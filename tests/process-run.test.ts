import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	describeTermination,
	killProcessTree,
	OutputCapture,
	processTreeSpawnOptions,
	runProcess,
} from '../src/process/run-process';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

describe('OutputCapture', () => {
	it('keeps the tail without splitting a surrogate pair', () => {
		const capture = new OutputCapture(2, 'tail');
		capture.append('ab');
		capture.append('😀c');
		// '😀' is two code units; keeping the last 2 would start mid-pair.
		expect(capture.text).toBe('c');
		capture.append('def');
		expect(capture.text).toBe('ef');
	});

	it('keeps the head and ignores later output', () => {
		const capture = new OutputCapture(3, 'head');
		capture.append('ab😀');
		expect(capture.text).toBe('ab');
		capture.append('more');
		expect(capture.text).toBe('ab');
	});

	it('bounds a long stream while appending many chunks', () => {
		const capture = new OutputCapture(10, 'tail');
		for (let index = 0; index < 1_000; index += 1) {
			capture.append(`${index.toString()},`);
		}
		expect(capture.text).toHaveLength(10);
		expect(capture.text.endsWith('998,999,')).toBe(true);
	});
});

describe('describeTermination', () => {
	it('names the timeout, the signal, or the exit code', () => {
		expect(describeTermination({ code: null, signal: 'SIGTERM', timedOut: true }, 500)).toBe(
			'timed out after 500 ms',
		);
		expect(describeTermination({ code: null, signal: 'SIGKILL', timedOut: false }, 0)).toBe(
			'killed by signal SIGKILL',
		);
		expect(describeTermination({ code: 2, signal: null, timedOut: false }, 0)).toBe(
			'exit code 2',
		);
	});
});

describe('killProcessTree', () => {
	it('signals the process group on POSIX', () => {
		const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
		const childKill = vi.fn(() => true);
		const child = Object.assign(new EventEmitter(), {
			pid: 4242,
			kill: childKill,
		}) as unknown as ChildProcess;
		killProcessTree(child, 'SIGTERM', 'linux');
		expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
		expect(childKill).not.toHaveBeenCalled();
	});

	it('falls back to the child when the group cannot be signalled', () => {
		vi.spyOn(process, 'kill').mockImplementation(() => {
			throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
		});
		const childKill = vi.fn(() => true);
		const child = Object.assign(new EventEmitter(), {
			pid: 4242,
			kill: childKill,
		}) as unknown as ChildProcess;
		killProcessTree(child, 'SIGKILL', 'darwin');
		expect(childKill).toHaveBeenCalledWith('SIGKILL');
	});

	it('starts POSIX children as group leaders but not Windows children', () => {
		expect(processTreeSpawnOptions('linux').detached).toBe(true);
		expect(processTreeSpawnOptions('win32').detached).toBe(false);
	});
});

describe('runProcess', () => {
	it('reports a signal termination', async () => {
		const result = await runProcess(
			process.execPath,
			['-e', 'process.kill(process.pid, "SIGKILL")'],
			{ timeoutMs: 2_000 },
		);
		expect(result.code).toBeNull();
		expect(result.signal).toBe('SIGKILL');
	});

	it('retains the head of stderr when asked to', async () => {
		const result = await runProcess(
			process.execPath,
			['-e', 'process.stderr.write("Duration: first\\n" + "x".repeat(10000))'],
			{ timeoutMs: 2_000, maxOutputChars: 100, stderrRetention: 'head' },
		);
		expect(result.stderr.startsWith('Duration: first')).toBe(true);
		expect(result.stderr).toHaveLength(100);
	});

	// npm installs CLIs like claude/codex as a `.cmd` shim on Windows. Node's
	// own spawn() can only run one through a shell, which does not quote
	// arguments for cmd.exe — a command-injection hole, since the prompt
	// argument carries untrusted transcript text. This proves the `.cmd` runs
	// at all, and that an argument containing shell metacharacters is passed
	// through literally rather than being interpreted. CI runs on Linux, so
	// this only exercises the fix on an actual Windows machine.
	it.skipIf(process.platform !== 'win32')(
		'runs an npm-style .cmd shim without letting its arguments reach the shell',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'voice-journal-cmd-'));
			temporaryDirectories.push(root);
			const markerPath = join(root, 'injected.txt');
			await writeFile(
				join(root, 'agent.cmd'),
				'@echo off\r\necho arg=%1\r\n',
			);
			const maliciousArg = `hello & echo INJECTED> "${markerPath}"`;

			const result = await runProcess(
				join(root, 'agent.cmd'),
				[maliciousArg],
				{ timeoutMs: 5_000 },
			);

			expect(result.code).toBe(0);
			expect(result.stdout).toContain(`arg=${maliciousArg}`);
			await expect(stat(markerPath)).rejects.toThrow();
		},
	);
});
