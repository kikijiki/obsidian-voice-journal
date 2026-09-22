import type { Dirent } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface ArtifactCachePruneResult {
	bytesBefore: number;
	bytesAfter: number;
	deletedDirectories: string[];
}

interface CacheDirectory {
	path: string;
	name: string;
	size: number;
	latestModifiedAtMs: number;
}

const HASH_DIRECTORY = /^[a-f0-9]{64}$/u;
const HASH_SHARD = /^[a-f0-9]{2}$/u;

async function measureDirectory(path: string): Promise<Pick<CacheDirectory, 'size' | 'latestModifiedAtMs'>> {
	let size = 0;
	let latestModifiedAtMs = 0;
	let entries: Dirent[];
	try {
		entries = await readdir(path, { withFileTypes: true });
	} catch {
		return { size, latestModifiedAtMs };
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) {
			continue;
		}
		const child = join(path, entry.name);
		if (entry.isDirectory()) {
			const measured = await measureDirectory(child);
			size += measured.size;
			latestModifiedAtMs = Math.max(
				latestModifiedAtMs,
				measured.latestModifiedAtMs,
			);
		} else if (entry.isFile()) {
			const metadata = await stat(child);
			size += metadata.size;
			latestModifiedAtMs = Math.max(latestModifiedAtMs, metadata.mtimeMs);
		}
	}
	return { size, latestModifiedAtMs };
}

async function recordingDirectories(artifactRoot: string): Promise<CacheDirectory[]> {
	let shards: Dirent[];
	try {
		shards = await readdir(artifactRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const directories: CacheDirectory[] = [];
	for (const shard of shards) {
		if (!shard.isDirectory() || !HASH_SHARD.test(shard.name)) {
			continue;
		}
		const shardPath = join(artifactRoot, shard.name);
		const entries = await readdir(shardPath, { withFileTypes: true }).catch(
			() => [] as Dirent[],
		);
		for (const entry of entries) {
			if (
				!entry.isDirectory() ||
				!HASH_DIRECTORY.test(entry.name) ||
				!entry.name.startsWith(shard.name)
			) {
				continue;
			}
			const path = join(shardPath, entry.name);
			const measured = await measureDirectory(path);
			directories.push({ path, name: entry.name, ...measured });
		}
	}
	return directories;
}

/** Removes only recognized recording artifact directories, oldest first. */
export async function pruneArtifactCache(
	artifactRoot: string,
	maximumBytes: number,
	protectedHashes: ReadonlySet<string> = new Set(),
): Promise<ArtifactCachePruneResult> {
	const directories = await recordingDirectories(artifactRoot);
	const bytesBefore = directories.reduce((sum, directory) => sum + directory.size, 0);
	let bytesAfter = bytesBefore;
	const deletedDirectories: string[] = [];
	for (const directory of [...directories].sort(
		(left, right) => left.latestModifiedAtMs - right.latestModifiedAtMs,
	)) {
		if (bytesAfter <= maximumBytes) {
			break;
		}
		if (protectedHashes.has(directory.name)) {
			continue;
		}
		await rm(directory.path, { recursive: true, force: true });
		bytesAfter -= directory.size;
		deletedDirectories.push(directory.path);
	}
	return { bytesBefore, bytesAfter, deletedDirectories };
}
