import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	FfmpegAudioSplitter,
	isMissingExecutable,
	parseFfmpegDuration,
	segmentOutputPattern,
} from '../src/audio/ffmpeg';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

async function tempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'voice-journal-ffmpeg-'));
	temporaryDirectories.push(directory);
	return directory;
}

describe('FfmpegAudioSplitter', () => {
	it('invokes ffmpeg with a segment muxer and returns sorted chunk paths', async () => {
		const outputDir = await tempDir();
		const calls: Array<{ executable: string; args: string[]; timeoutMs: number }> = [];
		const splitter = new FfmpegAudioSplitter(5_000, async (executable, args, timeoutMs) => {
			calls.push({ executable, args, timeoutMs });
			await writeFile(join(outputDir, 'chunk-0001.wav'), 'a');
			await writeFile(join(outputDir, 'chunk-0000.wav'), 'b');
			await writeFile(join(outputDir, 'not-a-chunk.txt'), 'c');
			return { code: 0, stderr: '', timedOut: false };
		});

		const chunks = await splitter.split(
			'/recordings/voice.wav',
			outputDir,
			300,
			'/usr/bin/ffmpeg',
		);

		expect(chunks).toEqual([
			join(outputDir, 'chunk-0000.wav'),
			join(outputDir, 'chunk-0001.wav'),
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.executable).toBe('/usr/bin/ffmpeg');
		expect(calls[0]?.args).toEqual(
			expect.arrayContaining([
				'-i',
				'/recordings/voice.wav',
				'-map',
				'0:a:0',
				'-vn',
				'-f',
				'segment',
				'-segment_time',
				'300',
				'-c',
				'copy',
			]),
		);
		expect(calls[0]?.args.at(-1)).toBe(join(outputDir, 'chunk-%04d.wav'));
	});

	it('propagates ffmpeg failures with a clear message', async () => {
		const outputDir = await tempDir();
		const splitter = new FfmpegAudioSplitter(5_000, async () => ({
			code: 1,
			stderr: 'no such filter',
			timedOut: false,
		}));

		await expect(
			splitter.split('/recordings/voice.wav', outputDir, 60, 'ffmpeg'),
		).rejects.toThrow('ffmpeg failed to split the recording (exit code 1): no such filter');
	});

	it('reports a timeout even when ffmpeg printed nothing', async () => {
		const outputDir = await tempDir();
		const splitter = new FfmpegAudioSplitter(5_000, async () => ({
			code: null,
			signal: 'SIGTERM',
			stderr: '',
			timedOut: true,
		}));

		await expect(
			splitter.split('/recordings/voice.wav', outputDir, 60, 'ffmpeg'),
		).rejects.toThrow('ffmpeg failed to split the recording (timed out after 5000 ms).');
	});

	it('escapes percent signs in the segment output path', async () => {
		const outputDir = await tempDir();
		const percentDir = join(outputDir, '100% voice');
		await mkdir(percentDir);
		let pattern: string | undefined;
		const splitter = new FfmpegAudioSplitter(5_000, async (_executable, args) => {
			pattern = args.at(-1);
			return { code: 0, stderr: '', timedOut: false };
		});

		await splitter.split('/recordings/50%.m4a', percentDir, 60, 'ffmpeg');

		expect(pattern).toBe(join(outputDir, '100%% voice', 'chunk-%04d.m4a'));
		expect(segmentOutputPattern('/a%b', '.x%y')).toBe('/a%%b/chunk-%04d.x%%y');
	});

	it('produces exactly one chunk for a recording shorter than the segment duration', async () => {
		const outputDir = await mkdtemp(join(tmpdir(), 'voice-journal-ffmpeg-single-'));
		temporaryDirectories.push(outputDir);
		await mkdir(outputDir, { recursive: true });
		const splitter = new FfmpegAudioSplitter(5_000, async () => {
			await writeFile(join(outputDir, 'chunk-0000.mp3'), 'whole file');
			return { code: 0, stderr: '', timedOut: false };
		});

		const chunks = await splitter.split(
			'/recordings/short.mp3',
			outputDir,
			600,
			'ffmpeg',
		);

		expect(chunks).toEqual([join(outputDir, 'chunk-0000.mp3')]);
	});
});

describe('duration probing', () => {
	it('parses the duration ffmpeg prints even though it exits non-zero', async () => {
		const splitter = new FfmpegAudioSplitter(5_000, async () => ({
			code: 1,
			stderr: 'Input #0, wav\n  Duration: 00:08:04.55, bitrate: 1152 kb/s',
			timedOut: false,
		}));
		expect(await splitter.probeDurationSeconds('/a.wav', 'ffmpeg')).toBeCloseTo(484.55);
	});

	it('keeps the head of stderr so the Duration line survives long metadata', async () => {
		const retentions: Array<string | undefined> = [];
		const splitter = new FfmpegAudioSplitter(
			5_000,
			async (_executable, _args, _timeoutMs, retention) => {
				retentions.push(retention);
				return {
					code: 1,
					stderr: `  Duration: 00:01:00.00\n${'lyrics '.repeat(1_000)}`,
					timedOut: false,
				};
			},
		);
		expect(await splitter.probeDurationSeconds('/a.m4a', 'ffmpeg')).toBe(60);
		expect(retentions).toEqual(['head']);
	});

	it('returns null when no duration is reported', async () => {
		const splitter = new FfmpegAudioSplitter(5_000, async () => ({
			code: 1,
			stderr: 'Duration: N/A',
			timedOut: false,
		}));
		expect(await splitter.probeDurationSeconds('/a.wav', 'ffmpeg')).toBeNull();
		expect(parseFfmpegDuration('Duration: 01:00:00.00')).toBe(3600);
	});

	it('recognises a missing executable', () => {
		expect(
			isMissingExecutable(Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })),
		).toBe(true);
		expect(isMissingExecutable(new Error('other'))).toBe(false);
	});
});
