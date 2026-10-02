import { describe, expect, it, vi } from 'vitest';
import {
	createSpawnEnvironmentResolver,
	mergePathLists,
	parseEnvPath,
	readLoginShellPath,
} from '../src/process/spawn-environment';

describe('createSpawnEnvironmentResolver', () => {
	it('merges the login shell PATH with the inherited PATH once', async () => {
		const readLoginShellPath = vi.fn(async () => '/opt/homebrew/bin:/usr/bin');
		const resolver = createSpawnEnvironmentResolver({
			platform: 'darwin',
			readLoginShellPath,
		});

		const first = await resolver.environmentFor('ffmpeg', {
			PATH: '/usr/bin:/bin',
			HOME: '/Users/me',
		});
		const second = await resolver.environmentFor('claude', { PATH: '/bin' });

		expect(first).toEqual({
			PATH: '/opt/homebrew/bin:/usr/bin:/bin',
			HOME: '/Users/me',
		});
		expect(second.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin');
		expect(readLoginShellPath).toHaveBeenCalledTimes(1);
	});

	it('puts an absolute executable directory first for env shebang shims', async () => {
		const resolver = createSpawnEnvironmentResolver({
			platform: 'linux',
			readLoginShellPath: async () => '/usr/local/bin',
		});
		const environment = await resolver.environmentFor(
			'/home/me/.nvm/versions/node/v22/bin/codex',
			{ PATH: '/usr/bin' },
		);
		expect(environment.PATH).toBe(
			'/home/me/.nvm/versions/node/v22/bin:/usr/local/bin:/usr/bin',
		);
	});

	it('falls back to the inherited PATH when the login shell cannot be read', async () => {
		const resolver = createSpawnEnvironmentResolver({
			platform: 'linux',
			readLoginShellPath: async () => {
				throw new Error('shell failed');
			},
		});
		expect(await resolver.environmentFor('pi', { PATH: '/usr/bin' })).toEqual({
			PATH: '/usr/bin',
		});
	});

	it('uses the Windows Path key and delimiter', async () => {
		const resolver = createSpawnEnvironmentResolver({
			platform: 'win32',
			readLoginShellPath: async () => null,
		});
		const environment = await resolver.environmentFor(
			'C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe',
			{ Path: 'C:\\Windows' },
		);
		expect(environment).toEqual({ Path: 'C:\\Tools\\ffmpeg\\bin;C:\\Windows' });
	});
});

describe('login shell PATH helpers', () => {
	it('parses PATH from env output surrounded by shell noise', () => {
		expect(
			parseEnvPath('Welcome!\nHOME=/home/me\nPATH=/a:/b\nSHLVL=1\n'),
		).toBe('/a:/b');
		expect(parseEnvPath('nothing here')).toBeNull();
	});

	it('deduplicates and drops empty entries', () => {
		expect(mergePathLists(':', '/a::/b', undefined, '/b:/c')).toBe('/a:/b:/c');
	});

	it('does not run a relative or missing shell', async () => {
		expect(await readLoginShellPath('')).toBeNull();
		expect(await readLoginShellPath('zsh')).toBeNull();
	});

	it.skipIf(process.platform === 'win32')(
		'reads PATH from a real login shell',
		async () => {
			expect(await readLoginShellPath('/bin/sh', 5_000)).toEqual(
				expect.any(String),
			);
		},
	);
});
