import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { setTimeout as scheduleTimeout } from 'node:timers';
import { describe, expect, it, vi } from 'vitest';
import {
	buildAgentInvocation,
	codingAgentEnvironment,
	CodingAgentClient,
	executeCommand,
	parseListedModels,
	streamJsonResultError,
} from '../src/agents/coding-agent';
import type { CodingAgentCommandRunner } from '../src/agents/coding-agent';
import type { CodingAgentType } from '../src/model';

const baseSettings = {
	codingAgentType: 'pi' as CodingAgentType,
	codingAgentExecutable: 'pi',
	codingAgentModel: 'provider/model',
	codingAgentThinkingEnabled: false,
};

describe('buildAgentInvocation', () => {
	it('starts Pi in unattended JSON mode with local add-ons disabled', () => {
		const invocation = buildAgentInvocation(
			baseSettings,
			'/vault',
			'Process this transcript.',
		);

		expect(invocation).toMatchObject({ executable: 'pi', cwd: '/vault' });
		expect(invocation.args).toEqual([
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
			'off',
			'--model',
			'provider/model',
			'--',
			'Process this transcript.',
		]);
	});

	it('enables Pi thinking only when explicitly requested', () => {
		const invocation = buildAgentInvocation(
			{ ...baseSettings, codingAgentThinkingEnabled: true },
			'/vault',
			'Process this transcript.',
		);
		expect(invocation.args).toContain('high');
	});

	it.each([
		['claude', 'claude', '--print'],
		['codex', 'codex', 'exec'],
	] as const)(
		'builds an unattended %s invocation in the vault',
		(type, executable, firstArgument) => {
			const invocation = buildAgentInvocation(
				{
					...baseSettings,
					codingAgentType: type,
					codingAgentExecutable: executable,
				},
				'/vault',
				'Process this transcript.',
			);

			expect(invocation.executable).toBe(executable);
			expect(invocation.cwd).toBe('/vault');
			expect(invocation.args[0]).toBe(firstArgument);
			expect(invocation.args).toContain('--model');
			expect(invocation.args.at(-1)).toBe('Process this transcript.');
			expect(invocation.args).not.toContain('--agent');
			expect(invocation.args).not.toContain('--profile');
		},
	);
});

describe('agent permissions', () => {
	const invocationFor = (type: CodingAgentType, model = ''): string[] =>
		buildAgentInvocation(
			{
				...baseSettings,
				codingAgentType: type,
				codingAgentExecutable: type,
				codingAgentModel: model,
			},
			'/vault',
			'Process this transcript.',
		).args;

	it('limits Claude Code to file tools with no shell, network, or MCP', () => {
		expect(invocationFor('claude')).toEqual([
			'--print',
			'--output-format',
			'stream-json',
			'--verbose',
			'--no-session-persistence',
			'--tools',
			'Read,Edit,Write,Glob,Grep,LS',
			'--allowedTools',
			'Read,Edit,Write,Glob,Grep,LS',
			'--disallowedTools',
			'Bash,WebFetch,WebSearch,Task,NotebookEdit',
			'--mcp-config',
			'{"mcpServers":{}}',
			'--strict-mcp-config',
			'--permission-mode',
			'acceptEdits',
			'Process this transcript.',
		]);
		expect(invocationFor('claude')).not.toContain('bypassPermissions');
	});

	it('keeps the Claude prompt out of variadic options when a model is set', () => {
		const args = invocationFor('claude', 'sonnet');
		expect(args.slice(-4)).toEqual([
			'acceptEdits',
			'--model',
			'sonnet',
			'Process this transcript.',
		]);
	});

	it('runs Codex in the workspace-write sandbox without approvals or network', () => {
		expect(invocationFor('codex')).toEqual([
			'exec',
			'--json',
			'--cd',
			'/vault',
			'--skip-git-repo-check',
			'--sandbox',
			'workspace-write',
			'-c',
			'approval_policy="never"',
			'-c',
			'sandbox_workspace_write.network_access=false',
			'Process this transcript.',
		]);
		expect(invocationFor('codex')).not.toContain(
			'--dangerously-bypass-approvals-and-sandbox',
		);
	});

});

describe('streamJsonResultError', () => {
	it('extracts the message of a failed Claude result event', () => {
		expect(
			streamJsonResultError(
				[
					'{"type":"system","subtype":"init"}',
					'{"type":"result","subtype":"success","is_error":true,"result":"API Error: 529 overloaded"}',
				].join('\n'),
			),
		).toBe('API Error: 529 overloaded');
		expect(
			streamJsonResultError(
				'{"type":"result","subtype":"error_max_turns","is_error":false,"errors":["Reached max turns"]}\n',
			),
		).toBe('Reached max turns');
	});

	it('ignores successful results and non-JSON output', () => {
		expect(
			streamJsonResultError('{"type":"result","subtype":"success","is_error":false,"result":"ok"}'),
		).toBeNull();
		expect(streamJsonResultError('plain text\n')).toBeNull();
	});
});

describe('codingAgentEnvironment', () => {
	it('does not leak terminal orchestrator session ownership to the child', () => {
		expect(
			codingAgentEnvironment({
				PATH: '/bin',
				HERDR_ENV: '1',
				HERDR_SOCKET_PATH: '/tmp/herdr.sock',
			}),
		).toEqual({ PATH: '/bin' });
	});
});

describe('parseListedModels', () => {
	it('parses Pi, Codex, and Claude CLI catalogs', () => {
		expect(
			parseListedModels(
				'pi',
				'provider  model  context\nvllm  Qwen3.8-27B  262K\n',
			),
		).toEqual(['vllm/Qwen3.8-27B']);
		expect(
			parseListedModels('codex', '{"models":[{"slug":"gpt-6"}]}'),
		).toEqual(['gpt-6']);
		expect(
			parseListedModels(
				'claude',
				"--model <model> Provide a model alias (e.g. 'fable', 'opus', or 'sonnet') or a full name.",
			),
		).toEqual(['fable', 'opus', 'sonnet']);
	});
});

describe('executeCommand', () => {
	it('closes child stdin so print-mode agents do not wait forever for EOF', async () => {
		await expect(
			executeCommand(
				process.execPath,
				[
					'-e',
					'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("closed"));',
				],
				{ timeoutMs: 1_000 },
			),
		).resolves.toEqual({ stdout: 'closed', stderr: '' });
	});

	it('reports streamed command failures without waiting on a buffered callback', async () => {
		await expect(
			executeCommand(
				process.execPath,
				['-e', 'process.stderr.write("provider failed"); process.exit(7);'],
				{ timeoutMs: 1_000 },
			),
		).rejects.toThrow('Coding-agent command failed (exit code 7): provider failed');
	});

	it('reports the exit reason when stderr is empty', async () => {
		await expect(
			executeCommand(process.execPath, ['-e', 'process.exit(3);'], {
				timeoutMs: 1_000,
			}),
		).rejects.toThrow('Coding-agent command failed (exit code 3).');
	});

	it('surfaces a failed stream-json result when stderr is empty', async () => {
		await expect(
			executeCommand(
				process.execPath,
				[
					'-e',
					'process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "Credit balance is too low" }) + "\\n"); process.exitCode = 1;',
				],
				{ timeoutMs: 1_000 },
			),
		).rejects.toThrow(
			'Coding-agent command failed (exit code 1): Credit balance is too low',
		);
	});

	it('decodes multibyte characters split across output chunks', async () => {
		const chunks: string[] = [];
		const result = await executeCommand(
			process.execPath,
			[
				'-e',
				'process.stdout.write(Buffer.from([0xe6, 0x97])); setTimeout(() => process.stdout.write(Buffer.from([0xa5, 0xe6, 0x9c, 0xac])), 50);',
			],
			{ timeoutMs: 2_000, onStdout: (chunk) => chunks.push(chunk) },
		);
		expect(result.stdout).toBe('日本');
		expect(chunks.join('')).toBe('日本');
		expect(chunks.every((chunk) => !chunk.includes('\uFFFD'))).toBe(true);
	});

	it.skipIf(process.platform === 'win32')(
		'kills the whole process tree on timeout',
		async () => {
			let output = '';
			const script = [
				'const { spawn } = require("node:child_process");',
				'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
				'process.stdout.write(`${grandchild.pid}\\n`);',
				'process.on("SIGTERM", () => {});',
				'setInterval(() => {}, 1000);',
			].join('\n');
			await expect(
				executeCommand(process.execPath, ['-e', script], {
					timeoutMs: 500,
					onStdout: (chunk) => {
						output += chunk;
					},
				}),
			).rejects.toThrow('timed out after 500 ms');
			const grandchildPid = Number(output.trim());
			expect(grandchildPid).toBeGreaterThan(0);
			expect(isRunning(grandchildPid)).toBe(false);
		},
		10_000,
	);

	it.skipIf(process.platform === 'win32')(
		'settles when a grandchild keeps the output pipe open after the agent exits',
		async () => {
			const script = [
				'const { spawn } = require("node:child_process");',
				'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });',
				'grandchild.unref();',
				'process.stdout.write(`${grandchild.pid}\\n`, () => process.exit(0));',
			].join('\n');
			const startedAt = Date.now();
			const result = await executeCommand(process.execPath, ['-e', script], {
				timeoutMs: 0,
			});
			expect(Date.now() - startedAt).toBeLessThan(6_000);
			const grandchildPid = Number(result.stdout.trim());
			expect(grandchildPid).toBeGreaterThan(0);
			await waitFor(() => !isRunning(grandchildPid));
		},
		10_000,
	);
});

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error('Condition not met in time.');
		}
		await new Promise((resolve) => scheduleTimeout(resolve, 25));
	}
}

describe('CodingAgentClient cancellation', () => {
	it('rejects a cancelled run even when the agent exits successfully', async () => {
		const child = new EventEmitter() as ChildProcess;
		let signalCode: NodeJS.Signals | null = null;
		Object.defineProperties(child, {
			exitCode: { get: () => (signalCode === null ? null : 0) },
			signalCode: { get: () => null },
		});
		child.kill = vi.fn(() => {
			signalCode = 'SIGTERM';
			child.emit('exit', 0, null);
			child.emit('close', 0, null);
			return true;
		});
		const runner: CodingAgentCommandRunner = async (
			_executable,
			_args,
			options,
		) =>
			await new Promise((resolve) => {
				child.once('close', () => resolve({ stdout: 'done', stderr: '' }));
				options.onSpawn?.(child);
			});
		const agent = new CodingAgentClient(runner);
		const run = agent.run(baseSettings, '/vault', 'Edit.');
		expect(agent.cancelActiveRun()).toBe(true);
		await expect(run).rejects.toThrow('cancelled');
		expect(agent.cancelActiveRun()).toBe(false);
	});

	it('does not retroactively cancel a run whose agent already exited successfully', async () => {
		// A straggling grandchild still holding the output pipe open past the
		// agent's own exit is reaped by runProcess()'s own exit-grace timer,
		// not by cancelActiveRun(); a cancel click landing in that window must
		// not discard a result the agent already decided.
		const child = new EventEmitter() as ChildProcess;
		Object.defineProperties(child, {
			exitCode: { get: () => 0 },
			signalCode: { get: () => null },
		});
		const kill = vi.fn(() => true);
		child.kill = kill;
		let finish: (() => void) | undefined;
		const runner: CodingAgentCommandRunner = async (
			_executable,
			_args,
			options,
		) =>
			await new Promise((resolve) => {
				finish = () => resolve({ stdout: 'done', stderr: '' });
				options.onSpawn?.(child);
			});
		const agent = new CodingAgentClient(runner);
		const run = agent.run(baseSettings, '/vault', 'Edit.');
		expect(agent.cancelActiveRun()).toBe(false);
		expect(kill).not.toHaveBeenCalled();
		finish?.();
		await expect(run).resolves.toEqual({ stdout: 'done', stderr: '' });
	});
});

describe('CodingAgentClient', () => {
	it('owns the active agent child and terminates it on cancellation', async () => {
		const child = new EventEmitter() as ChildProcess;
		let exitCode: number | null = null;
		let signalCode: NodeJS.Signals | null = null;
		Object.defineProperties(child, {
			exitCode: { get: () => exitCode },
			signalCode: { get: () => signalCode },
		});
		const kill = vi.fn((signal?: NodeJS.Signals | number) => {
			signalCode = typeof signal === 'string' ? signal : 'SIGTERM';
			child.emit('exit', exitCode, signalCode);
			child.emit('close', exitCode, signalCode);
			return true;
		});
		child.kill = kill;
		const runner: CodingAgentCommandRunner = async (
			_executable,
			_args,
			options,
		) =>
			await new Promise((_resolve, reject) => {
				child.once('close', () => reject(new Error('terminated')));
				options.onSpawn?.(child);
			});
		const agent = new CodingAgentClient(runner);
		const run = agent.run(baseSettings, '/vault', 'Edit.');
		expect(agent.cancelActiveRun()).toBe(true);
		await expect(run).rejects.toThrow('cancelled');
		expect(kill).toHaveBeenCalledWith('SIGTERM');
	});

	it('does not impose a wall-clock timeout on an active agent run', async () => {
		const runner: CodingAgentCommandRunner = async (
			_executable,
			_args,
			options,
		) => {
			expect(options.timeoutMs).toBe(0);
			return { stdout: 'done', stderr: '' };
		};
		const agent = new CodingAgentClient(runner);
		await agent.run(baseSettings, '/vault', 'Edit the journal.');
	});

	it('applies a configured run timeout and ignores non-positive values', async () => {
		const observed: number[] = [];
		const runner: CodingAgentCommandRunner = async (
			_executable,
			_args,
			options,
		) => {
			observed.push(options.timeoutMs);
			return { stdout: 'done', stderr: '' };
		};
		const agent = new CodingAgentClient(runner);
		agent.setRunTimeoutMs(90_000);
		await agent.run(baseSettings, '/vault', 'Edit.');
		agent.setRunTimeoutMs(0);
		await agent.run(baseSettings, '/vault', 'Edit.');
		expect(observed).toEqual([90_000, 0]);
	});

	it('runs the selected agent in the vault with the configured timeout', async () => {
		const runner: CodingAgentCommandRunner = async (
			executable,
			args,
			options,
		) => {
			expect(executable).toBe('codex');
			expect(args).toContain('--skip-git-repo-check');
			expect(args.at(-1)).toBe('Edit the journal.');
			expect(options).toMatchObject({ cwd: '/vault', timeoutMs: 42_000 });
			return { stdout: 'done', stderr: '' };
		};
		const agent = new CodingAgentClient(runner, 15_000, 42_000);
		await expect(
			agent.run(
				{
					...baseSettings,
					codingAgentType: 'codex',
					codingAgentExecutable: 'codex',
				},
				'/vault',
				'Edit the journal.',
			),
		).resolves.toEqual({ stdout: 'done', stderr: '' });
	});

	it('forwards stdout and stderr chunks while the agent runs', async () => {
		const output: string[] = [];
		const runner: CodingAgentCommandRunner = async (
			_executable,
			_args,
			options,
		) => {
			options.onStdout?.('first\n');
			options.onStderr?.('warning\n');
			return { stdout: 'first\n', stderr: 'warning\n' };
		};
		const agent = new CodingAgentClient(runner);
		await agent.run(
			{ ...baseSettings, codingAgentType: 'codex' },
			'/vault',
			'Edit.',
			(stream, chunk) => {
				output.push(`${stream}:${chunk}`);
			},
		);
		expect(output).toEqual(['stdout:first\n', 'stderr:warning\n']);
	});

	it('checks a Pi executable and configured model', async () => {
		const runner: CodingAgentCommandRunner = async (_executable, args) => ({
			stdout: args[0] === '--version' ? '0.85.1\n' : 'provider model true\n',
			stderr: '',
		});
		const health = await new CodingAgentClient(runner).checkHealth(
			'pi',
			'pi',
			'provider/model',
		);
		expect(health).toMatchObject({
			type: 'pi',
			ok: true,
			version: '0.85.1',
			modelAvailable: true,
		});
	});

	it('reports a configured Pi model that is unavailable', async () => {
		const runner: CodingAgentCommandRunner = async (_executable, args) => ({
			stdout: args[0] === '--version' ? '1.18.29\n' : 'other/model\n',
			stderr: '',
		});
		const health = await new CodingAgentClient(runner).checkHealth(
			'pi',
			'pi',
			'missing/model',
		);
		expect(health.ok).toBe(false);
		expect(health.error).toContain('missing/model');
	});

	it('checks Claude without claiming its configured model was enumerated', async () => {
		const runner: CodingAgentCommandRunner = async () => ({
			stdout: '2.1.278\n',
			stderr: '',
		});
		const health = await new CodingAgentClient(runner).checkHealth(
			'claude',
			'claude',
			'custom-model',
		);
		expect(health).toMatchObject({
			type: 'claude',
			ok: true,
			version: '2.1.278',
		});
		expect(health.modelAvailable).toBeUndefined();
	});
});
