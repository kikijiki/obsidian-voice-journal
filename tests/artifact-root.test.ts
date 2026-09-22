import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	initializeArtifactStorage,
	resolvePluginArtifactRoot,
} from '../src/storage/artifact-root';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

describe('plugin artifact storage', () => {
	it('uses the configured Obsidian plugin folder and ignores cache contents', async () => {
		const vault = await mkdtemp(join(tmpdir(), 'voice-journal-storage-'));
		temporaryDirectories.push(vault);
		const root = resolvePluginArtifactRoot(vault, '.config', 'voice-journal');
		await initializeArtifactStorage(root);

		expect(root).toBe(
			join(vault, '.config', 'plugins', 'voice-journal', '.voice-journal'),
		);
		expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('*\n');
	});
});
