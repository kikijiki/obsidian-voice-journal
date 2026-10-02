import { userInfo } from 'node:os';
import { posix, win32 } from 'node:path';
import { runProcess } from './run-process';

// Obsidian started from a desktop entry, the Dock or Finder inherits a
// minimal PATH that usually lacks ~/.local/bin, Homebrew, nvm, Nix profiles
// and similar locations where agent CLIs and ffmpeg live. The login shell's
// PATH is resolved once and merged into the environment of every spawn.

export type LoginShellPathReader = () => Promise<string | null>;

export interface SpawnEnvironmentDependencies {
	platform: NodeJS.Platform;
	readLoginShellPath: LoginShellPathReader;
}

export interface SpawnEnvironmentResolver {
	environmentFor(
		executable: string,
		base?: NodeJS.ProcessEnv,
	): Promise<NodeJS.ProcessEnv>;
}

const LOGIN_SHELL_TIMEOUT_MS = 5_000;

export function mergePathLists(
	delimiter: string,
	...lists: Array<string | undefined>
): string {
	const entries = lists.flatMap((list) =>
		list === undefined ? [] : list.split(delimiter),
	);
	return [...new Set(entries.filter((entry) => entry !== ''))].join(delimiter);
}

// Reads PATH from the last `PATH=` line printed by `env`, so anything an
// interactive shell prints on startup (MOTD, prompts, warnings) is ignored.
export function parseEnvPath(output: string): string | null {
	const line = output
		.split(/\r?\n/u)
		.reverse()
		.find((candidate) => candidate.startsWith('PATH='));
	return line === undefined ? null : line.slice('PATH='.length);
}

function defaultLoginShell(): string | undefined {
	const fromEnvironment = process.env.SHELL;
	if (fromEnvironment !== undefined && fromEnvironment !== '') {
		return fromEnvironment;
	}
	try {
		return userInfo().shell ?? undefined;
	} catch {
		return undefined;
	}
}

export async function readLoginShellPath(
	shell: string | undefined = defaultLoginShell(),
	timeoutMs = LOGIN_SHELL_TIMEOUT_MS,
): Promise<string | null> {
	if (shell === undefined || !posix.isAbsolute(shell)) {
		return null;
	}
	try {
		const result = await runProcess(shell, ['-ilc', '/usr/bin/env'], {
			env: process.env,
			timeoutMs,
			maxOutputChars: 1024 * 1024,
			exitGraceMs: 500,
			killGraceMs: 500,
		});
		if (result.timedOut) {
			return null;
		}
		return parseEnvPath(result.stdout);
	} catch {
		return null;
	}
}

function pathKey(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
	if (platform !== 'win32') {
		return 'PATH';
	}
	return (
		Object.keys(environment).find((name) => name.toUpperCase() === 'PATH') ??
		'Path'
	);
}

export function createSpawnEnvironmentResolver(
	dependencies: Partial<SpawnEnvironmentDependencies> = {},
): SpawnEnvironmentResolver {
	const platform = dependencies.platform ?? process.platform;
	const readPath =
		dependencies.readLoginShellPath ??
		(platform === 'win32' ? () => Promise.resolve(null) : () => readLoginShellPath());
	const paths = platform === 'win32' ? win32 : posix;
	let loginPath: Promise<string | null> | undefined;

	return {
		async environmentFor(
			executable: string,
			base: NodeJS.ProcessEnv = process.env,
		): Promise<NodeJS.ProcessEnv> {
			loginPath ??= readPath().catch(() => null);
			const shellPath = await loginPath;
			const key = pathKey(base, platform);
			// An absolute executable's own directory goes first so a
			// `#!/usr/bin/env node` shim finds the runtime installed beside it.
			const executableDir = paths.isAbsolute(executable)
				? paths.dirname(executable)
				: undefined;
			const merged = mergePathLists(
				paths.delimiter,
				executableDir,
				shellPath ?? undefined,
				base[key],
			);
			return merged === '' ? { ...base } : { ...base, [key]: merged };
		},
	};
}

const defaultResolver = createSpawnEnvironmentResolver();

export function spawnEnvironment(
	executable: string,
	base: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
	return defaultResolver.environmentFor(executable, base);
}
