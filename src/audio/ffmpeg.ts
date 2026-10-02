import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { describeTermination, runProcess } from '../process/run-process';
import type { OutputRetention } from '../process/run-process';
import { spawnEnvironment } from '../process/spawn-environment';

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
	signal?: NodeJS.Signals | null;
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

// Metadata-heavy inputs (chapters, embedded lyrics, many streams) can print
// a lot, but the Duration line always comes first, so the probe keeps the
// head of stderr while failures keep the tail where ffmpeg reports errors.
const MAX_STDERR_CHARS = 64 * 1024;

export async function runFfmpeg(
	executable: string,
	args: string[],
	timeoutMs: number,
	stderrRetention: OutputRetention = 'tail',
): Promise<FfmpegResult> {
	const result = await runProcess(executable, args, {
		env: await spawnEnvironment(executable),
		timeoutMs,
		captureStdout: false,
		maxOutputChars: MAX_STDERR_CHARS,
		stderrRetention,
		// ffmpeg ignores the first SIGTERM while it finalises output, so it
		// is not given long before the SIGKILL.
		killGraceMs: 1_000,
	});
	return {
		code: result.code,
		signal: result.signal,
		stderr: result.stderr,
		timedOut: result.timedOut,
	};
}

// The segment muxer expands printf-style `%` sequences in the whole output
// path, so literal percent signs in the directory or file name are doubled.
export function segmentOutputPattern(outputDir: string, extension: string): string {
	const escape = (text: string): string => text.replace(/%/gu, '%%');
	return join(escape(outputDir), `chunk-%04d${escape(extension)}`);
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
			'head',
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
		const pattern = segmentOutputPattern(outputDir, extname(inputPath));
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
				// Only the first audio stream is segmented: embedded cover art
				// and other streams cannot be stream-copied into every chunk.
				'-map',
				'0:a:0',
				'-vn',
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
			const reason = describeTermination(
				{
					code: result.code,
					signal: result.signal ?? null,
					timedOut: result.timedOut,
				},
				this.timeoutMs,
			);
			const diagnostic = result.stderr.trim().slice(-2_000);
			throw new Error(
				diagnostic === ''
					? `ffmpeg failed to split the recording (${reason}).`
					: `ffmpeg failed to split the recording (${reason}): ${diagnostic}`,
			);
		}
		const entries = await readdir(outputDir);
		return entries
			.filter((entry) => entry.startsWith('chunk-'))
			.sort((left, right) => left.localeCompare(right))
			.map((entry) => join(outputDir, entry));
	}
}
