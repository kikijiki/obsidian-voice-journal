import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneArtifactCache } from '../src/storage/artifact-cache';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

describe('artifact cache pruning', () => {
	it('deletes oldest recording artifacts and protects the current run', async () => {
		const root = await mkdtemp(join(tmpdir(), 'voice-journal-cache-'));
		temporaryDirectories.push(root);
		const oldHash = `aa${'0'.repeat(62)}`;
		const currentHash = `bb${'1'.repeat(62)}`;
		const oldFile = join(root, 'aa', oldHash, 'audio.wav');
		const currentFile = join(root, 'bb', currentHash, 'audio.wav');
		await mkdir(join(root, 'aa', oldHash), { recursive: true });
		await mkdir(join(root, 'bb', currentHash), { recursive: true });
		await writeFile(oldFile, '12345');
		await writeFile(currentFile, '67890');
		await utimes(oldFile, new Date(1_000), new Date(1_000));
		await utimes(currentFile, new Date(2_000), new Date(2_000));

		const result = await pruneArtifactCache(root, 5, new Set([currentHash]));
		expect(result.deletedDirectories).toHaveLength(1);
		await expect(stat(join(root, 'aa', oldHash))).rejects.toThrow();
		expect((await stat(join(root, 'bb', currentHash))).isDirectory()).toBe(true);
	});
});
