import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
	clearTimeout as cancelTimeout,
	setTimeout as scheduleTimeout,
} from 'node:timers';
import type {
	CodingAgentHealth,
	CodingAgentType,
	VoiceJournalSettings,
} from '../model';

interface CommandResult {
	stdout: string;
	stderr: string;
}

interface CommandOptions {
	cwd?: string;
	timeoutMs: number;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
	onSpawn?: (child: ChildProcess) => void;
}

export function codingAgentEnvironment(
	environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(environment).filter(([name]) => !name.startsWith('HERDR_')),
	);
}

export interface AgentInvocation {
	executable: string;
	args: string[];
	cwd: string;
}

export interface AgentRunResult {
	stdout: string;
	stderr: string;
}

export type AgentOutputListener = (
	stream: 'stdout' | 'stderr',
	chunk: string,
) => void;

export type CodingAgentCommandRunner = (
	executable: string,
	args: string[],
	options: CommandOptions,
) => Promise<CommandResult>;

const MAX_CAPTURED_OUTPUT_BYTES = 4 * 1024 * 1024;

function appendOutputTail(current: string, chunk: string): string {
	const combined = current + chunk;
	if (Buffer.byteLength(combined, 'utf8') <= MAX_CAPTURED_OUTPUT_BYTES) {
		return combined;
	}
	return Buffer.from(combined, 'utf8')
		.subarray(-MAX_CAPTURED_OUTPUT_BYTES)
		.toString('utf8');
}

export function executeCommand(
	executable: string,
	args: string[],
	options: CommandOptions,
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let settled = false;
		let forceTimer: ReturnType<typeof scheduleTimeout> | undefined;
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: {
				...codingAgentEnvironment(process.env),
				...(options.cwd === undefined ? {} : { PWD: options.cwd }),
			},
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const timeout =
			options.timeoutMs > 0
				? scheduleTimeout(() => {
						timedOut = true;
						child.kill('SIGTERM');
						forceTimer = scheduleTimeout(
							() => child.kill('SIGKILL'),
							3_000,
						);
					}, options.timeoutMs)
				: undefined;
		const clearTimers = (): void => {
			if (timeout !== undefined) {
				cancelTimeout(timeout);
			}
			if (forceTimer !== undefined) {
				cancelTimeout(forceTimer);
			}
		};
		const fail = (error: Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimers();
			reject(error);
		};
		// Print-mode agents inspect piped stdin before processing positional
		// prompts. Leaving the default child-process pipe open makes Pi wait
		// forever for EOF before it emits its first JSON event.
		child.stdin?.on('error', () => {
			// The agent may exit before consuming stdin; the process callback owns
			// command failure reporting.
		});
		child.stdin?.end();
		options.onSpawn?.(child);
		child.stdout?.on('data', (chunk: string | Buffer) => {
			const text = chunk.toString();
			stdout = appendOutputTail(stdout, text);
			options.onStdout?.(text);
		});
		child.stderr?.on('data', (chunk: string | Buffer) => {
			const text = chunk.toString();
			stderr = appendOutputTail(stderr, text);
			options.onStderr?.(text);
		});
		child.once('error', (error) => fail(error));
		child.once('close', (code, signal) => {
			if (settled) {
				return;
			}
			clearTimers();
			if (code === 0 && !timedOut) {
				settled = true;
				resolve({ stdout, stderr });
				return;
			}
			const diagnostic = stderr.trim().slice(-4_000);
			const reason = timedOut
				? `timed out after ${options.timeoutMs.toString()} ms`
				: (code?.toString() ?? signal ?? 'unknown error');
			fail(
				new Error(
					diagnostic === ''
						? `Coding-agent command failed (${reason}).`
						: `Coding-agent command failed: ${diagnostic}`,
				),
			);
		});
	});
}

export function codingAgentName(type: CodingAgentType): string {
	return {
		pi: 'Pi',
		claude: 'Claude Code',
		codex: 'Codex',
		cursor: 'Cursor',
	}[type];
}

export function buildAgentInvocation(
	settings: Pick<
		VoiceJournalSettings,
		| 'codingAgentType'
		| 'codingAgentExecutable'
		| 'codingAgentModel'
		| 'codingAgentThinkingEnabled'
	>,
	vaultPath: string,
	prompt: string,
): AgentInvocation {
	const modelArgs =
		settings.codingAgentModel === ''
			? []
			: ['--model', settings.codingAgentModel];
	let args: string[];

	switch (settings.codingAgentType) {
		case 'pi':
			args = [
				'--mode',
				'json',
				'--print',
				'--no-session',
				'--no-extensions',
				'--no-skills',
				'--no-prompt-templates',
				'--no-context-files',
				'--no-approve',
				'--tools',
				'read,edit,write,grep,find,ls',
				'--thinking',
				settings.codingAgentThinkingEnabled ? 'high' : 'off',
				...modelArgs,
				'--',
				prompt,
			];
			break;
		case 'claude':
			args = [
				'--print',
				'--output-format',
				'stream-json',
				'--verbose',
				'--no-session-persistence',
				'--permission-mode',
				'bypassPermissions',
				...modelArgs,
				prompt,
			];
			break;
		case 'codex':
			args = [
				'exec',
				'--json',
				'--cd',
				vaultPath,
				'--skip-git-repo-check',
				'--dangerously-bypass-approvals-and-sandbox',
				...modelArgs,
				prompt,
			];
			break;
		case 'cursor':
			args = [
				'--print',
				'--output-format',
				'stream-json',
				'--workspace',
				vaultPath,
				'--trust',
				'--force',
				...modelArgs,
				prompt,
			];
			break;
	}

	return { executable: settings.codingAgentExecutable, args, cwd: vaultPath };
}

function modelListArgs(type: CodingAgentType, model = ''): string[] {
	if (type === 'pi') {
		return model === '' ? ['--list-models'] : ['--list-models', model];
	}
	if (type === 'cursor') {
		return ['--list-models'];
	}
	if (type === 'codex') {
		return ['debug', 'models'];
	}
	return ['--help'];
}

export function parseListedModels(
	type: CodingAgentType,
	output: string,
): string[] {
	let models: string[];
	if (type === 'pi') {
		models = output.split(/\r?\n/u).flatMap((line) => {
			const match = line.trim().match(/^(\S+)\s+(\S+)\s+/u);
			return match?.[1] === undefined || match[2] === undefined || match[1] === 'provider'
				? []
				: [`${match[1]}/${match[2]}`];
		});
	} else if (type === 'cursor') {
		models = output.split(/\r?\n/u).flatMap((line) => {
			const match = line.trim().match(/^([^\s]+)\s+-\s+.+$/u);
			return match?.[1] === undefined ? [] : [match[1]];
		});
	} else if (type === 'codex') {
		try {
			const parsed = JSON.parse(output) as { models?: Array<{ slug?: unknown }> };
			models = (parsed.models ?? []).flatMap(({ slug }) =>
				typeof slug === 'string' && slug !== '' ? [slug] : [],
			);
		} catch {
			throw new Error('Codex returned an invalid model catalog.');
		}
	} else {
		const aliases = output.match(
			/--model[\s\S]*?alias[\s\S]*?\(e\.g\.\s*([^)]*)\)/iu,
		)?.[1];
		models = [...(aliases?.matchAll(/'([^']+)'/gu) ?? [])].flatMap(
			(match) => (match[1] === undefined ? [] : [match[1]]),
		);
	}
	return [...new Set(models)].sort((left, right) => left.localeCompare(right));
}

function listedModelMatches(
	type: CodingAgentType,
	output: string,
	model: string,
): boolean {
	if (type !== 'pi') {
		return output
			.split(/\r?\n/u)
			.some((candidate) => candidate.trim() === model);
	}

	return output.split(/\r?\n/u).some((line) => {
		const [provider, modelId] = line.trim().split(/\s+/u);
		if (provider === undefined || modelId === undefined) {
			return false;
		}
		return model.includes('/')
			? `${provider}/${modelId}` === model
			: modelId === model;
	});
}

export class CodingAgentClient {
	private activeChild: ChildProcess | null = null;
	private readonly ownedChildren = new Set<ChildProcess>();
	private readonly terminationTimers = new Map<
		ChildProcess,
		ReturnType<typeof scheduleTimeout>
	>();
	private cancelRequested = false;
	private disposed = false;

	constructor(
		private readonly commandRunner: CodingAgentCommandRunner = executeCommand,
		private readonly timeoutMs = 15_000,
		private runTimeoutMs = 0,
	) {}

	setRunTimeoutMs(timeoutMs: number): void {
		this.runTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
	}

	async run(
		settings: Pick<
			VoiceJournalSettings,
			| 'codingAgentType'
			| 'codingAgentExecutable'
				| 'codingAgentModel'
			| 'codingAgentThinkingEnabled'
		>,
		vaultPath: string,
		prompt: string,
		onOutput?: AgentOutputListener,
	): Promise<AgentRunResult> {
		if (this.disposed) {
			throw new Error('Coding-agent client has been disposed.');
		}
		if (this.activeChild !== null) {
			throw new Error('A coding-agent run is already active.');
		}
		this.cancelRequested = false;
		try {
			const invocation = buildAgentInvocation(settings, vaultPath, prompt);
			return await this.commandRunner(invocation.executable, invocation.args, {
				cwd: invocation.cwd,
				timeoutMs: this.runTimeoutMs,
				onStdout: (chunk) => onOutput?.('stdout', chunk),
				onStderr: (chunk) => onOutput?.('stderr', chunk),
				onSpawn: (child) => {
					this.activeChild = child;
					this.ownChild(child);
				},
			});
		} catch (error) {
			if (this.cancelRequested) {
				throw new Error('Coding-agent run was cancelled.');
			}
			throw error;
		} finally {
			this.activeChild = null;
		}
	}

	cancelActiveRun(): boolean {
		const child = this.activeChild;
		if (child === null || !this.isAlive(child)) {
			return false;
		}
		this.cancelRequested = true;
		this.terminateChild(child);
		return true;
	}

	dispose(): void {
		this.disposed = true;
		this.cancelRequested = true;
		for (const child of this.ownedChildren) {
			this.terminateChild(child);
		}
	}

	async checkHealth(
		type: CodingAgentType,
		executable: string,
		model: string,
	): Promise<CodingAgentHealth> {
		if (this.disposed) {
			return {
				type,
				ok: false,
				latencyMs: 0,
				error: 'Coding-agent client has been disposed.',
			};
		}
		const startedAt = performance.now();
		try {
			const versionResult = await this.commandRunner(executable, ['--version'], {
				timeoutMs: this.timeoutMs,
				onSpawn: (child) => this.ownChild(child),
			});
			const version = versionResult.stdout.trim() || versionResult.stderr.trim();
			if (model === '' || type === 'claude' || type === 'codex') {
				return {
					type,
					ok: true,
					latencyMs: Math.round(performance.now() - startedAt),
					version,
				};
			}

			const modelsResult = await this.commandRunner(
				executable,
				modelListArgs(type, model),
				{
					timeoutMs: this.timeoutMs,
					onSpawn: (child) => this.ownChild(child),
				},
			);
			const modelAvailable = listedModelMatches(
				type,
				modelsResult.stdout,
				model,
			);
			return {
				type,
				ok: modelAvailable,
				latencyMs: Math.round(performance.now() - startedAt),
				version,
				modelAvailable,
				error: modelAvailable
					? undefined
					: `Configured model ${model} is not available to ${codingAgentName(type)}.`,
			};
		} catch (error) {
			return {
				type,
				ok: false,
				latencyMs: Math.round(performance.now() - startedAt),
				error:
					error instanceof Error
						? error.message
						: `${codingAgentName(type)} check failed.`,
			};
		}
	}

	async listModels(type: CodingAgentType, executable: string): Promise<string[]> {
		if (this.disposed) {
			throw new Error('Coding-agent client has been disposed.');
		}
		const result = await this.commandRunner(executable, modelListArgs(type), {
			timeoutMs: this.timeoutMs,
			onSpawn: (child) => this.ownChild(child),
		});
		const models = parseListedModels(type, result.stdout || result.stderr);
		if (models.length === 0) {
			throw new Error(`${codingAgentName(type)} did not report any models.`);
		}
		return models;
	}

	private ownChild(child: ChildProcess): void {
		if (this.disposed) {
			this.terminateChild(child);
			return;
		}
		this.ownedChildren.add(child);
		child.once('close', () => {
			this.ownedChildren.delete(child);
			this.clearTerminationTimer(child);
		});
	}

	private isAlive(child: ChildProcess): boolean {
		return child.exitCode === null && child.signalCode === null;
	}

	private terminateChild(child: ChildProcess): void {
		if (!this.isAlive(child)) {
			return;
		}
		if (this.terminationTimers.has(child)) {
			return;
		}
		const timer = scheduleTimeout(() => {
			this.terminationTimers.delete(child);
			if (this.isAlive(child)) {
				child.kill('SIGKILL');
			}
		}, 3_000);
		this.terminationTimers.set(child, timer);
		child.once('exit', () => this.clearTerminationTimer(child));
		child.kill('SIGTERM');
	}

	private clearTerminationTimer(child: ChildProcess): void {
		const timer = this.terminationTimers.get(child);
		if (timer !== undefined) {
			cancelTimeout(timer);
			this.terminationTimers.delete(child);
		}
	}
}
