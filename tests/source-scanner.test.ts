import { mkdtemp, mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { SourceScanner } from '../src/ingest/source-scanner';
import { DEFAULT_DJI_FILENAME_TIMESTAMP_REGEX } from '../src/ingest/recording-timestamp';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

async function createFixtureRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'voice-journal-scan-'));
	temporaryDirectories.push(root);
	return root;
}

describe('SourceScanner', () => {
	it('uses a configured filename timestamp for the recording time', async () => {
		const root = await createFixtureRoot();
		const recording = join(root, 'TX01_MIC002_20260921_190443_orig.wav');
		await writeFile(recording, 'audio');
		const oldDate = new Date(Date.now() - 60_000);
		await utimes(recording, oldDate, oldDate);

		const result = await new SourceScanner().scan(
			[
				{
					id: 'dji',
					name: 'DJI',
					path: root,
					recursive: true,
					extensions: ['.wav'],
					minimumAgeSeconds: 10,
					timestampSource: 'filename',
					filenameTimestampRegex: DEFAULT_DJI_FILENAME_TIMESTAMP_REGEX,
					timestampOffsetHours: 0,
				},
			],
			100,
		);

		expect(result.errors).toEqual([]);
		const timestamp = new Date(result.candidates[0]?.recordedAtMs ?? 0);
		expect([
			timestamp.getFullYear(),
			timestamp.getMonth() + 1,
			timestamp.getDate(),
			timestamp.getHours(),
			timestamp.getMinutes(),
			timestamp.getSeconds(),
		]).toEqual([2026, 9, 21, 19, 4, 43]);
	});

	it('finds configured audio files recursively and skips symlinks', async () => {
		const root = await createFixtureRoot();
		const nested = join(root, 'nested');
		await mkdir(nested);
		const recording = join(nested, 'DJI_001.WAV');
		await writeFile(recording, 'audio');
		await writeFile(join(root, 'notes.txt'), 'not audio');
		await symlink(recording, join(root, 'linked.wav'));
		const oldDate = new Date(Date.now() - 60_000);
		await utimes(recording, oldDate, oldDate);

		const result = await new SourceScanner().scan(
			[
				{
					id: 'dji',
					name: 'DJI',
					path: root,
					recursive: true,
					extensions: ['.wav'],
					minimumAgeSeconds: 10,
					timestampSource: 'filesystem',
					filenameTimestampRegex: '',
					timestampOffsetHours: 0,
				},
			],
			100,
		);

		expect(result.errors).toEqual([]);
		expect(result.candidates.map((candidate) => candidate.relativePath)).toEqual([
			join('nested', 'DJI_001.WAV'),
		]);
	});

	it('reports relative source paths as configuration errors', async () => {
		const result = await new SourceScanner().scan(
			[
				{
					id: 'bad',
					name: 'Bad',
					path: 'relative',
					recursive: true,
					extensions: ['.wav'],
					minimumAgeSeconds: 0,
					timestampSource: 'filesystem',
					filenameTimestampRegex: '',
					timestampOffsetHours: 0,
				},
			],
			100,
		);
		expect(result.candidates).toEqual([]);
		expect(result.errors[0]?.message).toMatch(/absolute/i);
	});

	it('reports an invalid filename timestamp regex without scanning files', async () => {
		const root = await createFixtureRoot();
		await writeFile(join(root, 'recording.wav'), 'audio');
		const result = await new SourceScanner().scan(
			[
				{
					id: 'invalid-regex',
					name: 'Invalid regex',
					path: root,
					recursive: true,
					extensions: ['.wav'],
					minimumAgeSeconds: 0,
					timestampSource: 'filename',
					filenameTimestampRegex: '(',
					timestampOffsetHours: 0,
				},
			],
			100,
		);

		expect(result.candidates).toEqual([]);
		expect(result.errors[0]?.message).toMatch(/regex is invalid/i);
	});

	it('accepts stable candidates whose removable-media timestamp is in the future', async () => {
		const root = await createFixtureRoot();
		const recording = join(root, 'DJI_FUTURE.WAV');
		await writeFile(recording, 'audio');
		const futureDate = new Date(Date.now() + 8 * 60 * 60 * 1000);
		await utimes(recording, futureDate, futureDate);

		const result = await new SourceScanner().scan(
			[
				{
					id: 'dji',
					name: 'DJI',
					path: root,
					recursive: true,
					extensions: ['.wav'],
					minimumAgeSeconds: 10,
					timestampSource: 'filesystem',
					filenameTimestampRegex: '',
					timestampOffsetHours: 0,
				},
			],
			100,
		);

		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]?.fileName).toBe('DJI_FUTURE.WAV');
		expect(result.warnings[0]?.message).toMatch(/ahead of the system clock/i);
	});

	it('applies a filesystem timestamp offset before checking file age', async () => {
		const root = await createFixtureRoot();
		const recording = join(root, 'OFFSET.WAV');
		await writeFile(recording, 'audio');
		const futureDate = new Date(Date.now() + 8 * 60 * 60 * 1000);
		await utimes(recording, futureDate, futureDate);

		const result = await new SourceScanner().scan(
			[
				{
					id: 'offset',
					name: 'Offset metadata',
					path: root,
					recursive: true,
					extensions: ['.wav'],
					minimumAgeSeconds: 10,
					timestampSource: 'filesystem',
					filenameTimestampRegex: '',
					timestampOffsetHours: -9,
				},
			],
			100,
		);

		expect(result.candidates).toHaveLength(1);
		expect(result.warnings).toEqual([]);
	});

	it('stops traversal when the configured entry budget is exhausted', async () => {
		const root = await createFixtureRoot();
		await Promise.all(
			['one.txt', 'two.txt', 'three.txt'].map(async (name) =>
				writeFile(join(root, name), 'fixture'),
			),
		);
		const result = await new SourceScanner().scan(
			[
				{
					id: 'broad',
					name: 'Broad source',
					path: root,
					recursive: true,
					extensions: ['.wav'],
					minimumAgeSeconds: 0,
					timestampSource: 'filesystem',
					filenameTimestampRegex: '',
					timestampOffsetHours: 0,
				},
			],
			2,
		);
		expect(result.candidates).toEqual([]);
		expect(result.errors[0]?.message).toMatch(/entry limit/i);
	});
});
