import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Vault } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Wraps the real implementation (rather than replacing it) purely so
// `readFile` is spy-able; every other test in this file still hits the
// actual filesystem exactly as before.
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return { ...actual, readFile: vi.fn(actual.readFile) };
});
import {
	classifyDiffLine,
	compareVaultSnapshots,
	effectiveBaselineSnapshot,
	revertVaultFileChange,
	snapshotVaultNotes,
} from '../src/changes/vault-changes';

/**
 * The subset of Obsidian's Vault API that revertVaultFileChange() calls.
 * Returns the individual mocks as their own locals (not read back off
 * `vault.modify` etc.) so assertions never pull an unbound method off an
 * object.
 */
function fakeVault(tracked: Set<string>, overrides: Partial<Vault> = {}) {
	const modify = vi.fn(async () => undefined);
	const del = vi.fn(async () => undefined);
	const create = vi.fn(async () => undefined as never);
	const vault = {
		getFileByPath: vi.fn((path: string) =>
			tracked.has(path) ? ({ path } as never) : null,
		),
		modify,
		delete: del,
		create,
		...overrides,
	} as unknown as Vault;
	return { vault, modify, del, create };
}

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
		const changes = compareVaultSnapshots(before.snapshot, after.snapshot);

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
		const change = compareVaultSnapshots(before.snapshot, after.snapshot)[0]!;
		await writeFile(note, 'manual edit\n');

		await expect(revertVaultFileChange(vault, change)).rejects.toThrow(
			/changed after the agent run/u,
		);
	});

	it('reconstructs the true original snapshot for a follow-up diff', () => {
		// The first pass created "new.md" and modified "existing.md"; a
		// follow-up run then further edits "existing.md" and touches an
		// untouched file "other.md" for the first time.
		const priorChanges = compareVaultSnapshots(
			new Map([['existing.md', 'original\n']]),
			new Map([
				['existing.md', 'first pass\n'],
				['new.md', 'created\n'],
			]),
		);
		const currentSnapshot = new Map([
			['existing.md', 'first pass\n'],
			['new.md', 'created\n'],
			['other.md', 'never touched\n'],
		]);

		const baseline = effectiveBaselineSnapshot(currentSnapshot, priorChanges);

		expect(baseline.get('existing.md')).toBe('original\n');
		expect(baseline.has('new.md')).toBe(false);
		expect(baseline.get('other.md')).toBe('never touched\n');

		const afterFollowUp = new Map([
			['existing.md', 'second pass\n'],
			['new.md', 'created\n'],
			['other.md', 'now touched\n'],
		]);
		const cumulative = compareVaultSnapshots(baseline, afterFollowUp);
		expect(cumulative).toEqual([
			expect.objectContaining({ path: 'existing.md', kind: 'modified' }),
			expect.objectContaining({ path: 'new.md', kind: 'created' }),
			expect.objectContaining({ path: 'other.md', kind: 'modified' }),
		]);
	});

	it('keeps the earliest original when several reports touched a note', () => {
		const dayOne = compareVaultSnapshots(
			new Map([['People/Alice.md', 'A0\n']]),
			new Map([
				['People/Alice.md', 'A1\n'],
				['Journal/new.md', 'created\n'],
			]),
		);
		const dayTwo = compareVaultSnapshots(
			new Map([
				['People/Alice.md', 'A1\n'],
				['Journal/new.md', 'created\n'],
			]),
			new Map([
				['People/Alice.md', 'A2\n'],
				['Journal/new.md', 'edited\n'],
			]),
		);
		const baseline = effectiveBaselineSnapshot(
			new Map([
				['People/Alice.md', 'A2\n'],
				['Journal/new.md', 'edited\n'],
			]),
			[...dayOne, ...dayTwo],
		);
		expect(baseline.get('People/Alice.md')).toBe('A0\n');
		expect(baseline.has('Journal/new.md')).toBe(false);
	});
});

describe('snapshotVaultNotes reuse', () => {
	it('skips reading a file whose stat is unchanged from the prior pass', async () => {
		const vaultRoot = await mkdtemp(join(tmpdir(), 'voice-journal-reuse-'));
		temporaryDirectories.push(vaultRoot);
		const artifactRoot = join(vaultRoot, '.voice-journal');
		const untouchedPath = join(vaultRoot, 'untouched.md');
		const editedPath = join(vaultRoot, 'edited.md');
		await writeFile(untouchedPath, 'original\n');
		await writeFile(editedPath, 'before\n');

		const before = await snapshotVaultNotes(vaultRoot, artifactRoot);
		await writeFile(editedPath, 'after\n');

		vi.mocked(readFile).mockClear();
		const after = await snapshotVaultNotes(vaultRoot, artifactRoot, before);

		const readPaths = vi.mocked(readFile).mock.calls.map((call) => call[0]);
		expect(readPaths).toContain(editedPath);
		expect(readPaths).not.toContain(untouchedPath);
		expect(after.snapshot.get('untouched.md')).toBe('original\n');
		expect(after.snapshot.get('edited.md')).toBe('after\n');
	});
});

describe('revertVaultFileChange via the Vault API', () => {
	it('modifies a tracked file through vault.modify instead of raw fs', async () => {
		const vaultRoot = await mkdtemp(join(tmpdir(), 'voice-journal-revert-'));
		temporaryDirectories.push(vaultRoot);
		const notePath = join(vaultRoot, 'note.md');
		await writeFile(notePath, 'after\n');
		const { vault, modify } = fakeVault(new Set(['note.md']));

		const reverted = await revertVaultFileChange(
			vaultRoot,
			{ path: 'note.md', kind: 'modified', before: 'before\n', after: 'after\n', diff: '' },
			vault,
		);

		expect(reverted.reverted).toBe(true);
		expect(modify).toHaveBeenCalledWith(
			expect.objectContaining({ path: 'note.md' }),
			'before\n',
		);
		// Untouched on disk: the write went through the fake Vault, not raw fs.
		expect(await readFile(notePath, 'utf8')).toBe('after\n');
	});

	it('deletes a tracked created file through vault.delete instead of raw fs', async () => {
		const vaultRoot = await mkdtemp(join(tmpdir(), 'voice-journal-revert-'));
		temporaryDirectories.push(vaultRoot);
		const notePath = join(vaultRoot, 'note.md');
		await writeFile(notePath, 'created\n');
		const { vault, del } = fakeVault(new Set(['note.md']));

		await revertVaultFileChange(
			vaultRoot,
			{ path: 'note.md', kind: 'created', before: null, after: 'created\n', diff: '' },
			vault,
		);

		expect(del).toHaveBeenCalledWith(
			expect.objectContaining({ path: 'note.md' }),
		);
		expect(await readFile(notePath, 'utf8')).toBe('created\n');
	});

	it('falls back to raw fs for a file Obsidian does not track yet', async () => {
		const vaultRoot = await mkdtemp(join(tmpdir(), 'voice-journal-revert-'));
		temporaryDirectories.push(vaultRoot);
		const notePath = join(vaultRoot, 'note.md');
		await writeFile(notePath, 'after\n');
		const { vault, modify } = fakeVault(new Set());

		await revertVaultFileChange(
			vaultRoot,
			{ path: 'note.md', kind: 'modified', before: 'before\n', after: 'after\n', diff: '' },
			vault,
		);

		expect(modify).not.toHaveBeenCalled();
		expect(await readFile(notePath, 'utf8')).toBe('before\n');
	});

	it('falls back to raw fs when the Vault API write throws', async () => {
		const vaultRoot = await mkdtemp(join(tmpdir(), 'voice-journal-revert-'));
		temporaryDirectories.push(vaultRoot);
		const notePath = join(vaultRoot, 'note.md');
		await writeFile(notePath, 'after\n');
		const { vault } = fakeVault(new Set(['note.md']), {
			modify: vi.fn(async () => {
				throw new Error('stale index');
			}),
		});

		await revertVaultFileChange(
			vaultRoot,
			{ path: 'note.md', kind: 'modified', before: 'before\n', after: 'after\n', diff: '' },
			vault,
		);

		expect(await readFile(notePath, 'utf8')).toBe('before\n');
	});
});
