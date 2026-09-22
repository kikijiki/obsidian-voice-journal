import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	classifyDiffLine,
	compareVaultSnapshots,
	revertVaultFileChange,
	snapshotVaultNotes,
} from '../src/changes/vault-changes';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

describe('vault change reports', () => {
	it('classifies unified diff lines for highlighting', () => {
		expect(classifyDiffLine('+added')).toBe('addition');
		expect(classifyDiffLine('-removed')).toBe('deletion');
		expect(classifyDiffLine('+++ b/entry.md')).toBe('header');
		expect(classifyDiffLine('--- a/entry.md')).toBe('header');
		expect(classifyDiffLine('@@ -1 +1 @@')).toBe('header');
		expect(classifyDiffLine(' unchanged')).toBe('context');
	});

	it('reports Markdown changes and safely reverts them', async () => {
		const vault = await mkdtemp(join(tmpdir(), 'voice-journal-vault-'));
		temporaryDirectories.push(vault);
		const artifactRoot = join(vault, 'Journal', '.voice-journal');
		await mkdir(join(vault, 'Journal'), { recursive: true });
		const note = join(vault, 'Journal', 'today.md');
		await writeFile(note, 'before\n');
		const before = await snapshotVaultNotes(vault, artifactRoot);
		await writeFile(note, 'after\n');
		const after = await snapshotVaultNotes(vault, artifactRoot);
		const changes = compareVaultSnapshots(before, after);

		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({
			path: 'Journal/today.md',
			kind: 'modified',
		});
		expect(changes[0]?.diff).toContain('-before');
		expect(changes[0]?.diff).toContain('+after');
		const reverted = await revertVaultFileChange(vault, changes[0]!);
		expect(reverted.reverted).toBe(true);
		expect(await readFile(note, 'utf8')).toBe('before\n');
	});

	it('refuses to overwrite edits made after the report', async () => {
		const vault = await mkdtemp(join(tmpdir(), 'voice-journal-vault-'));
		temporaryDirectories.push(vault);
		const note = join(vault, 'entry.md');
		await writeFile(note, 'before\n');
		const before = await snapshotVaultNotes(vault, join(vault, '.voice-journal'));
		await writeFile(note, 'agent\n');
		const after = await snapshotVaultNotes(vault, join(vault, '.voice-journal'));
		const change = compareVaultSnapshots(before, after)[0]!;
		await writeFile(note, 'manual edit\n');

		await expect(revertVaultFileChange(vault, change)).rejects.toThrow(
			/changed after the agent run/u,
		);
	});
});
