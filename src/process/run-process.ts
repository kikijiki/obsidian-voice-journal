import type { ChildProcess, SpawnOptions } from 'node:child_process';
// Node's own spawn() needs `shell: true` to run a Windows `.cmd`/`.bat`
// shim (how npm installs claude/codex/ffmpeg on Windows), and shell:true
// does not safely quote arguments for cmd.exe — the prompt argument carries
// untrusted transcript text, so that would be a command-injection hole.
// cross-spawn resolves the shim and escapes every argument itself, with no
// shell involved; on POSIX it is a thin pass-through to the same spawn().
import spawn from 'cross-spawn';
import {
	clearTimeout as cancelTimeout,
	setTimeout as scheduleTimeout,
} from 'node:timers';

export type OutputRetention = 'head' | 'tail';

// Bounded text capture measured in UTF-16 code units. Trimming is amortised
// (the buffer may grow to 1.5x the limit before it is cut) so a long stream
// does not copy the whole buffer on every chunk, and a cut never leaves half
// of a surrogate pair behind.
export class OutputCapture {
	private buffer = '';
	private full = false;

	constructor(
		private readonly maxChars: number,
		private readonly retention: OutputRetention = 'tail',
	) {}

	append(chunk: string): void {
		if (this.retention === 'head') {
			if (this.full) {
				return;
			}
			this.buffer += chunk;
			if (this.buffer.length >= this.maxChars) {
				this.buffer = trimHead(this.buffer, this.maxChars);
				this.full = true;
			}
			return;
		}
		this.buffer += chunk;
		if (this.buffer.length > this.maxChars + Math.floor(this.maxChars / 2)) {
			this.buffer = trimTail(this.buffer, this.maxChars);
		}
	}

	get text(): string {
		return this.retention === 'head'
			? trimHead(this.buffer, this.maxChars)
			: trimTail(this.buffer, this.maxChars);
	}
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

function trimHead(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	const end = isHighSurrogate(text.charCodeAt(maxChars - 1))
		? maxChars - 1
		: maxChars;
	return text.slice(0, end);
}

function trimTail(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	const start = text.length - maxChars;
	return text.slice(
		isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start,
	);
}

// POSIX children are started as process-group leaders so a timeout or
// cancellation can signal the whole tree (agents spawn tool subprocesses,
// shells, language servers, ...). Windows would open a console window for a
// detached child, and taskkill /T walks the tree there instead.
export function processTreeSpawnOptions(
	platform: NodeJS.Platform = process.platform,
): Pick<SpawnOptions, 'detached' | 'windowsHide'> {
	return { detached: platform !== 'win32', windowsHide: true };
}

export function killProcessTree(
	child: ChildProcess,
	signal: NodeJS.Signals,
	platform: NodeJS.Platform = process.platform,
): void {
	const pid = child.pid;
	if (pid === undefined) {
		child.kill(signal);
		return;
	}
	if (platform === 'win32') {
		try {
			const killer = spawn('taskkill', ['/pid', pid.toString(), '/T', '/F'], {
				stdio: 'ignore',
				windowsHide: true,
			});
			killer.once('error', () => child.kill(signal));
		} catch {
			child.kill(signal);
		}
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		// The child was not started as a group leader, or the whole group is
		// already gone.
		child.kill(signal);
	}
}

export interface RunProcessOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs: number;
	// 'close' gives the child an already-ended stdin pipe; print-mode agents
	// wait for EOF on a piped stdin before they start.
	stdin?: 'ignore' | 'close';
	captureStdout?: boolean;
	maxOutputChars?: number;
	stderrRetention?: OutputRetention;
	// How long to wait for stdio to drain after the child exits before the
	// pipes are destroyed. A grandchild that inherited them would otherwise
	// keep the command pending forever.
	exitGraceMs?: number;
	killGraceMs?: number;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
	onSpawn?: (child: ChildProcess) => void;
}

export interface ProcessResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export function describeTermination(
	result: Pick<ProcessResult, 'code' | 'signal' | 'timedOut'>,
	timeoutMs: number,
): string {
	if (result.timedOut) {
		return `timed out after ${timeoutMs.toString()} ms`;
	}
	if (result.signal !== null) {
		return `killed by signal ${result.signal}`;
	}
	return result.code === null
		? 'unknown exit status'
		: `exit code ${result.code.toString()}`;
}

const DEFAULT_MAX_OUTPUT_CHARS = 4 * 1024 * 1024;
const DEFAULT_EXIT_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 3_000;

export function runProcess(
	executable: string,
	args: string[],
	options: RunProcessOptions,
): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const maxChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
		const stdout = new OutputCapture(maxChars, 'tail');
		const stderr = new OutputCapture(maxChars, options.stderrRetention ?? 'tail');
		const captureStdout = options.captureStdout ?? true;
		let timedOut = false;
		let settled = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		let forceTimer: ReturnType<typeof scheduleTimeout> | undefined;
		let graceTimer: ReturnType<typeof scheduleTimeout> | undefined;
		let timeout: ReturnType<typeof scheduleTimeout> | undefined;

		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: [
				options.stdin === 'close' ? 'pipe' : 'ignore',
				captureStdout || options.onStdout !== undefined ? 'pipe' : 'ignore',
				'pipe',
			],
			...processTreeSpawnOptions(),
		});

		const clearTimers = (): void => {
			for (const timer of [timeout, forceTimer, graceTimer]) {
				if (timer !== undefined) {
					cancelTimeout(timer);
				}
			}
		};
		const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimers();
			resolve({
				code,
				signal,
				stdout: stdout.text,
				stderr: stderr.text,
				timedOut,
			});
		};

		if (options.timeoutMs > 0) {
			timeout = scheduleTimeout(() => {
				timedOut = true;
				killProcessTree(child, 'SIGTERM');
				forceTimer = scheduleTimeout(
					() => killProcessTree(child, 'SIGKILL'),
					options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
				);
			}, options.timeoutMs);
		}

		if (options.stdin === 'close') {
			child.stdin?.on('error', () => {
				// The child may exit before consuming stdin; the exit handlers own
				// failure reporting.
			});
			child.stdin?.end();
		}
		options.onSpawn?.(child);

		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			if (captureStdout) {
				stdout.append(chunk);
			}
			options.onStdout?.(chunk);
		});
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => {
			stderr.append(chunk);
			options.onStderr?.(chunk);
		});

		child.once('error', (error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimers();
			reject(error);
		});
		child.once('exit', (code, signal) => {
			exitCode = code;
			exitSignal = signal;
			if (settled) {
				return;
			}
			graceTimer = scheduleTimeout(() => {
				// Something that outlived the child still holds its stdio.
				// Reap the rest of the group and stop waiting for EOF.
				killProcessTree(child, 'SIGKILL');
				child.stdout?.destroy();
				child.stderr?.destroy();
				settle(exitCode, exitSignal);
			}, options.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS);
		});
		child.once('close', (code, signal) => settle(code ?? exitCode, signal ?? exitSignal));
	});
}
