import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
	buildAgentInvocation,
	codingAgentEnvironment,
	CodingAgentClient,
	executeCommand,
	parseListedModels,
} from '../src/agents/coding-agent';
import type { CodingAgentCommandRunner } from '../src/agents/coding-agent';
import type { CodingAgentType } from '../src/model';

const baseSettings = {
	codingAgentType: 'pi' as CodingAgentType,
	codingAgentExecutable: 'pi',
	codingAgentProfile: '',
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
		['claude', 'claude', '--print', '--agent'],
		['codex', 'codex', 'exec', '--profile'],
		['cursor', 'cursor-agent', '--print', null],
	] as const)(
		'builds an unattended %s invocation in the vault',
		(type, executable, firstArgument, profileFlag) => {
			const invocation = buildAgentInvocation(
				{
					...baseSettings,
					codingAgentType: type,
					codingAgentExecutable: executable,
					codingAgentProfile: profileFlag === null ? '' : 'journal',
				},
				'/vault',
				'Process this transcript.',
			);

			expect(invocation.executable).toBe(executable);
			expect(invocation.cwd).toBe('/vault');
			expect(invocation.args[0]).toBe(firstArgument);
			expect(invocation.args).toContain('--model');
			expect(invocation.args.at(-1)).toBe('Process this transcript.');
			if (profileFlag === null) {
				expect(invocation.args).not.toContain('--agent');
				expect(invocation.args).not.toContain('--profile');
			} else {
				expect(invocation.args).toContain(profileFlag);
			}
		},
	);
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
	it('parses Pi, Cursor, Codex, and Claude CLI catalogs', () => {
		expect(
			parseListedModels(
				'pi',
				'provider  model  context\nvllm  Qwen3.8-27B  262K\n',
			),
		).toEqual(['vllm/Qwen3.8-27B']);
		expect(
			parseListedModels('cursor', 'Available models\nauto - Auto\ngpt-5 - GPT 5\n'),
		).toEqual(['auto', 'gpt-5']);
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
		).rejects.toThrow('Coding-agent command failed: provider failed');
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
