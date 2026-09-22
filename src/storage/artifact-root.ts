import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

const CACHE_GITIGNORE = '*\n';

function isInside(parent: string, candidate: string): boolean {
	return candidate.startsWith(`${parent}${sep}`);
}

export function resolvePluginArtifactRoot(
	vaultRoot: string,
	configDirectory: string,
	pluginId: string,
): string {
	if (
		configDirectory.trim() === '' ||
		isAbsolute(configDirectory) ||
		pluginId.trim() === '' ||
		pluginId.includes('/') ||
		pluginId.includes('\\')
	) {
		throw new Error('Invalid Obsidian plugin storage path.');
	}
	const root = resolve(vaultRoot);
	const artifactRoot = resolve(
		root,
		configDirectory,
		'plugins',
		pluginId,
		'.voice-journal',
	);
	if (!isInside(root, artifactRoot)) {
		throw new Error('Plugin storage must remain inside the active vault.');
	}
	return artifactRoot;
}

/** Creates ignored plugin-local operational storage. */
export async function initializeArtifactStorage(
	artifactRoot: string,
): Promise<void> {
	await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
	await rm(resolve(artifactRoot, 'runs'), { recursive: true, force: true });
	await writeFile(resolve(artifactRoot, '.gitignore'), CACHE_GITIGNORE, {
		encoding: 'utf8',
		mode: 0o600,
	});
}
