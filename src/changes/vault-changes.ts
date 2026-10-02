import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { Vault } from 'obsidian';

export type VaultFileChangeKind = 'created' | 'modified' | 'deleted';
export type DiffLineKind = 'addition' | 'deletion' | 'header' | 'context';

export interface VaultFileChange {
	path: string;
	kind: VaultFileChangeKind;
	before: string | null;
	after: string | null;
	diff: string;
	reverted?: boolean;
}

export type VaultSnapshot = Map<string, string>;

export interface VaultFileStat {
	mtimeMs: number;
	size: number;
}
export type VaultStatSnapshot = Map<string, VaultFileStat>;

export interface VaultSnapshotResult {
	snapshot: VaultSnapshot;
	stats: VaultStatSnapshot;
}

export function classifyDiffLine(line: string): DiffLineKind {
	if (line.startsWith('+') && !line.startsWith('+++')) {
		return 'addition';
	}
	if (line.startsWith('-') && !line.startsWith('---')) {
		return 'deletion';
	}
	if (
		line.startsWith('diff ') ||
		line.startsWith('Index: ') ||
		line.startsWith('---') ||
		line.startsWith('+++') ||
		line.startsWith('@@') ||
		line.startsWith('===')
	) {
		return 'header';
	}
	return 'context';
}

const IGNORED_DIRECTORY_NAMES = new Set(['node_modules']);

function vaultRelative(vaultRoot: string, path: string): string {
	return relative(vaultRoot, path).split(sep).join('/');
}

function isInside(parent: string, candidate: string): boolean {
	return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

/**
 * Walks every Markdown note in the vault and reads its content. `reuse`, when
 * given, is typically the result of the snapshot taken just before the agent
 * ran: a file whose mtime and size are unchanged from it is assumed to still
 * hold the same content, which is reused instead of read again. This is
 * always checked against the real filesystem stat, never Obsidian's own file
 * index, so a false "might have changed" only ever costs one redundant read.
 * The one residual risk is an edit that preserves both the byte count and
 * lands within the filesystem's mtime resolution (coarse on some filesystems,
 * e.g. FAT32's two seconds) — narrow enough to accept in exchange for not
 * re-reading a large vault's untouched notes on every agent call, but still a
 * real way a change could go undetected, so this must never be used for
 * anything safety-critical (recording completion keys off content hashes
 * computed independently, never this). The stat for every file is still
 * recorded even on a pass with no `reuse` (the very first, "before"
 * snapshot of a run), so that map can be reused by the next pass.
 */
export async function snapshotVaultNotes(
	vaultRoot: string,
	artifactRoot: string,
	reuse?: VaultSnapshotResult,
): Promise<VaultSnapshotResult> {
	const root = resolve(vaultRoot);
	const excludedArtifacts = resolve(artifactRoot);
	const snapshot: VaultSnapshot = new Map();
	const stats: VaultStatSnapshot = new Map();
	const visit = async (directory: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) {
				continue;
			}
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (
					entry.name.startsWith('.') ||
					IGNORED_DIRECTORY_NAMES.has(entry.name) ||
					isInside(excludedArtifacts, resolve(path))
				) {
					continue;
				}
				await visit(path);
			} else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
				const relativePath = vaultRelative(root, path);
				try {
					const metadata = await stat(path);
					const current: VaultFileStat = {
						mtimeMs: metadata.mtimeMs,
						size: metadata.size,
					};
					stats.set(relativePath, current);
					const priorStat = reuse?.stats.get(relativePath);
					const priorContent = reuse?.snapshot.get(relativePath);
					const unchanged =
						priorStat !== undefined &&
						priorContent !== undefined &&
						priorStat.mtimeMs === current.mtimeMs &&
						priorStat.size === current.size;
					snapshot.set(
						relativePath,
						unchanged ? priorContent : await readFile(path, 'utf8'),
					);
				} catch {
					// Removed (e.g. by sync) or unreadable between listing and reading.
				}
			}
		}
	};
	await visit(root);
	return { snapshot, stats };
}

export function compareVaultSnapshots(
	before: VaultSnapshot,
	after: VaultSnapshot,
): VaultFileChange[] {
	const paths = new Set([...before.keys(), ...after.keys()]);
	return [...paths]
		.sort((left, right) => left.localeCompare(right))
		.flatMap((path): VaultFileChange[] => {
			const previous = before.get(path) ?? null;
			const current = after.get(path) ?? null;
			if (previous === current) {
				return [];
			}
			const kind: VaultFileChangeKind =
				previous === null
					? 'created'
					: current === null
						? 'deleted'
						: 'modified';
			return [
				{
					path,
					kind,
					before: previous,
					after: current,
					diff: createTwoFilesPatch(
						previous === null ? '/dev/null' : `a/${path}`,
						current === null ? '/dev/null' : `b/${path}`,
						previous ?? '',
						current ?? '',
						'',
						'',
						{ context: 3 },
					),
				},
			];
		});
}

/**
 * Reconstructs the vault state from before the very first agent pass, so a
 * follow-up run's diff still reflects the full cumulative change instead of
 * only the delta introduced by the follow-up itself. `priorChanges` are the
 * already-reported changes in chronological order; when several reports
 * touched the same path, the earliest `before` is the true original. Every
 * other path is taken from `currentSnapshot`, which already holds the true
 * original content for anything neither pass has touched yet.
 */
export function effectiveBaselineSnapshot(
	currentSnapshot: VaultSnapshot,
	priorChanges: VaultFileChange[],
): VaultSnapshot {
	const baseline = new Map(currentSnapshot);
	const seen = new Set<string>();
	for (const change of priorChanges) {
		if (seen.has(change.path)) {
			continue;
		}
		seen.add(change.path);
		if (change.before === null) {
			baseline.delete(change.path);
		} else {
			baseline.set(change.path, change.before);
		}
	}
	return baseline;
}

function resolveVaultPath(vaultRoot: string, relativePath: string): string {
	const root = resolve(vaultRoot);
	const target = resolve(root, relativePath);
	if (!target.startsWith(`${root}${sep}`)) {
		throw new Error('Change path escapes the active vault.');
	}
	return target;
}

async function currentContents(path: string): Promise<string | null> {
	try {
		const metadata = await stat(path);
		return metadata.isFile() ? await readFile(path, 'utf8') : null;
	} catch {
		return null;
	}
}

/**
 * Writes the revert through `vault` when Obsidian already tracks the file,
 * so an open editor pane, the metadata cache, and backlinks update as part
 * of the same call instead of waiting on Obsidian's own external-change
 * watcher to notice a raw filesystem write. Falls back to raw `fs` when the
 * file is not (yet) tracked — e.g. the agent just created, deleted, or
 * modified it and Obsidian has not indexed that change. `fileExists` is
 * whichever the caller already confirmed on disk (never re-derived from
 * Obsidian's own index, which is exactly what might be stale here): it picks
 * `create` vs `modify` so a revert is never attempted through the wrong one
 * of those two just because the file happens to be untracked.
 */
async function writeRevert(
	path: string,
	vaultPath: string,
	content: string | null,
	fileExists: boolean,
	vault: Vault | undefined,
): Promise<void> {
	const tracked = vault?.getFileByPath(vaultPath) ?? null;
	if (content === null) {
		if (tracked !== null) {
			try {
				await vault?.delete(tracked);
				return;
			} catch {
				// Obsidian's index may be stale; fall through to raw fs.
			}
		}
		await unlink(path);
		return;
	}
	if (vault !== undefined) {
		try {
			if (fileExists) {
				if (tracked !== null) {
					await vault.modify(tracked, content);
					return;
				}
				// Untracked but present on disk (e.g. the agent wrote it outside
				// Obsidian and the index has not caught up): nothing to modify.
			} else {
				await vault.create(vaultPath, content);
				return;
			}
		} catch {
			// Fall through to raw fs below.
		}
	}
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, 'utf8');
}

export async function revertVaultFileChange(
	vaultRoot: string,
	change: VaultFileChange,
	vault?: Vault,
): Promise<VaultFileChange> {
	if (change.reverted === true) {
		return change;
	}
	const path = resolveVaultPath(vaultRoot, change.path);
	const current = await currentContents(path);
	if (current !== change.after) {
		throw new Error(
			`${change.path} changed after the agent run; refusing to overwrite it.`,
		);
	}
	await writeRevert(path, change.path, change.before, current !== null, vault);
	return { ...change, reverted: true };
}
