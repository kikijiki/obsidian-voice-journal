import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import {
	clearTimeout as cancelTimeout,
	setTimeout as scheduleTimeout,
} from 'node:timers';

export interface AudioSplitter {
	probeDurationSeconds(
		inputPath: string,
		ffmpegExecutable: string,
	): Promise<number | null>;
	split(
		inputPath: string,
		outputDir: string,
		chunkSeconds: number,
		ffmpegExecutable: string,
	): Promise<string[]>;
}

export interface FfmpegResult {
	code: number | null;
	stderr: string;
	timedOut: boolean;
}

export function isMissingExecutable(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error as NodeJS.ErrnoException).code === 'ENOENT'
	);
}

export function parseFfmpegDuration(stderr: string): number | null {
	const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/u);
	if (match === null) {
		return null;
	}
	return (
		Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
	);
}

function runFfmpeg(
	executable: string,
	args: string[],
	timeoutMs: number,
): Promise<FfmpegResult> {
	return new Promise((resolvePromise, reject) => {
		let stderr = '';
		let timedOut = false;
		const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
		const timer =
			timeoutMs > 0
				? scheduleTimeout(() => {
						timedOut = true;
						child.kill('SIGKILL');
					}, timeoutMs)
				: undefined;
		child.stderr?.on('data', (chunk: string | Buffer) => {
			stderr += chunk.toString();
			if (stderr.length > 8_000) {
				stderr = stderr.slice(-8_000);
			}
		});
		child.once('error', (error) => {
			if (timer !== undefined) {
				cancelTimeout(timer);
			}
			reject(error);
		});
		child.once('close', (code) => {
			if (timer !== undefined) {
				cancelTimeout(timer);
			}
			resolvePromise({ code, stderr, timedOut });
		});
	});
}

export class FfmpegAudioSplitter implements AudioSplitter {
	constructor(
		private readonly timeoutMs = 300_000,
		private readonly run: typeof runFfmpeg = runFfmpeg,
	) {}

	async probeDurationSeconds(
		inputPath: string,
		ffmpegExecutable: string,
	): Promise<number | null> {
		// With no output file ffmpeg exits non-zero after printing the input
		// details, so only stderr matters here.
		const result = await this.run(
			ffmpegExecutable,
			['-hide_banner', '-nostdin', '-i', inputPath],
			this.timeoutMs,
		);
		if (result.timedOut) {
			throw new Error(`ffmpeg timed out reading ${inputPath}.`);
		}
		return parseFfmpegDuration(result.stderr);
	}

	async split(
		inputPath: string,
		outputDir: string,
		chunkSeconds: number,
		ffmpegExecutable: string,
	): Promise<string[]> {
		const pattern = join(outputDir, `chunk-%04d${extname(inputPath)}`);
		const result = await this.run(
			ffmpegExecutable,
			[
				'-hide_banner',
				'-loglevel',
				'error',
				'-nostdin',
				'-y',
				'-i',
				inputPath,
				'-f',
				'segment',
				'-segment_time',
				chunkSeconds.toString(),
				'-c',
				'copy',
				'-reset_timestamps',
				'1',
				pattern,
			],
			this.timeoutMs,
		);
		if (result.timedOut || result.code !== 0) {
			const reason = result.timedOut
				? `timed out after ${this.timeoutMs.toString()} ms`
				: result.stderr.trim().slice(-2_000) ||
					`exit code ${result.code?.toString() ?? 'unknown'}`;
			throw new Error(`ffmpeg failed to split the recording: ${reason}`);
		}
		const entries = await readdir(outputDir);
		return entries
			.filter((entry) => entry.startsWith('chunk-'))
			.sort((left, right) => left.localeCompare(right))
			.map((entry) => join(outputDir, entry));
	}
}
