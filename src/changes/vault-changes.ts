import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createTwoFilesPatch } from 'diff';

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

export async function snapshotVaultNotes(
	vaultRoot: string,
	artifactRoot: string,
): Promise<VaultSnapshot> {
	const root = resolve(vaultRoot);
	const excludedArtifacts = resolve(artifactRoot);
	const snapshot: VaultSnapshot = new Map();
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
				snapshot.set(vaultRelative(root, path), await readFile(path, 'utf8'));
			}
		}
	};
	await visit(root);
	return snapshot;
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

export async function revertVaultFileChange(
	vaultRoot: string,
	change: VaultFileChange,
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
	if (change.before === null) {
		await unlink(path);
	} else {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, change.before, 'utf8');
	}
	return { ...change, reverted: true };
}
