import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	agentTurnStarted,
	AgentLineBuffer,
	AgentOutputPresenter,
	formatAgentLine,
} from '../src/activity/agent-output';
import { ActivityLog } from '../src/activity/log';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

describe('AgentLineBuffer', () => {
	it('reassembles JSONL split across process output chunks', () => {
		const buffer = new AgentLineBuffer();
		expect(buffer.push('stdout', '{"type":"te')).toEqual([]);
		expect(
			buffer.push('stdout', 'xt","part":{"text":"hello"}}\n'),
		).toEqual(['{"type":"text","part":{"text":"hello"}}']);
	});

	it('splits CRLF output, including a CR/LF pair split across chunks', () => {
		const buffer = new AgentLineBuffer();
		expect(buffer.push('stdout', '{"a":1}\r\n{"b":2}\r')).toEqual(['{"a":1}']);
		expect(buffer.push('stdout', '\n{"c":3}\r\n')).toEqual([
			'{"b":2}',
			'{"c":3}',
		]);
		expect(buffer.push('stdout', 'tail\r')).toEqual([]);
		expect(buffer.flush('stdout')).toEqual(['tail']);
	});

	it('keeps stdout and stderr partial lines separate', () => {
		const buffer = new AgentLineBuffer();
		expect(buffer.push('stdout', 'out-')).toEqual([]);
		expect(buffer.push('stderr', 'err\n')).toEqual(['err']);
		expect(buffer.push('stdout', 'line\n')).toEqual(['out-line']);
	});

	it('creates a readable label and human-readable event details', () => {
		const line = '{"type":"text","part":{"text":"hello"}}';
		expect(formatAgentLine(line)).toEqual({
			title: 'Agent · text',
			message: 'hello',
			detail: 'type: text\npart:\n  text: hello',
			presentation: 'event',
			icon: 'bot',
		});
	});

	it('formats Pi text deltas from the JSON event stream', () => {
		const line =
			'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Editing the journal"}}';
		expect(formatAgentLine(line)).toEqual({
			title: 'Agent · text_delta',
			message: 'Editing the journal',
			detail:
				'type: message_update\nassistantMessageEvent:\n  type: text_delta\n  delta: Editing the journal',
			presentation: 'event',
			icon: 'bot',
		});
	});

	it('formats Pi tool execution events', () => {
		const line =
			'{"type":"tool_execution_start","toolName":"edit","args":{"path":"Journal/today.md"}}';
		expect(formatAgentLine(line).title).toBe('Agent · edit');
	});
});

describe('AgentOutputPresenter', () => {
	it('updates one Pi response row and finalizes it from message_end', () => {
		const presenter = new AgentOutputPresenter('pi');
		const started =
			presenter.push(
				'{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}',
			)[0];
		expect(started).toMatchObject({
			title: 'Agent response',
			message: 'Streaming…',
			persist: false,
		});
		const firstDelta =
			presenter.push(
				'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Let"}}',
			)[0];
		expect(firstDelta).toMatchObject({
			message: 'Let',
			replaceKey: started?.replaceKey,
			persist: false,
		});
		const secondDelta =
			presenter.push(
				'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":" me check."}}',
			)[0];
		expect(secondDelta).toMatchObject({
			message: 'Let me check.',
			replaceKey: started?.replaceKey,
			persist: false,
		});
		const events = presenter.push(
			'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Let me check."}]}}',
		);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			title: 'Agent response',
			message: 'Let me check.',
			replaceKey: started?.replaceKey,
			persist: true,
		});
	});

	it('hides Pi protocol noise and partial tool-call deltas', () => {
		const presenter = new AgentOutputPresenter('pi');
		expect(presenter.push('{"type":"session","id":"example"}')).toEqual(
			[],
		);
		expect(
			presenter.push(
				'{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","delta":"{\\"path"}}',
			),
		).toEqual([]);
	});

	it('updates one row across Pi tool execution boundaries', () => {
		const presenter = new AgentOutputPresenter('pi');
		const started =
			presenter.push(
				'{"type":"tool_execution_start","toolCallId":"call-1","toolName":"edit","args":{"path":"Journal/today.md"}}',
			)[0];
		expect(started).toMatchObject({
			title: 'Edit',
			message: 'Journal/today.md',
			presentation: 'tool',
			icon: 'file-pen-line',
			status: 'running',
			persist: false,
		});
		const finished =
			presenter.push(
				'{"type":"tool_execution_end","toolCallId":"call-1","toolName":"edit","result":"done","isError":false}',
			)[0];
		expect(finished).toMatchObject({
			title: 'Edit',
			message: 'Journal/today.md',
			status: 'succeeded',
			replaceKey: started?.replaceKey,
			persist: true,
		});
		expect(finished?.detail).toBe(
			'Input\npath: Journal/today.md\n\nOutput\ndone',
		);
	});

	it('does not render Pi turn boundaries as activity rows', () => {
		const presenter = new AgentOutputPresenter('pi');
		expect(presenter.push('{"type":"turn_start"}')).toEqual([]);
		expect(presenter.push(
			'{"type":"turn_end","message":{"role":"assistant","content":[]},"toolResults":[]}',
		)).toEqual([]);
		expect(agentTurnStarted('{"type":"turn_start"}')).toBe(true);
		expect(agentTurnStarted('{"type":"turn_end"}')).toBe(false);
	});

	it('folds Pi automatic retries into one readable status row', () => {
		const presenter = new AgentOutputPresenter('pi', 'recording');
		const started = presenter.push(
			'{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"terminated"}',
		)[0];
		expect(started).toMatchObject({
			title: 'Retrying model request',
			message: 'Attempt 1 of 3 in 2s · terminated',
			level: 'warning',
			status: 'running',
			persist: false,
		});
		const finished = presenter.push(
			'{"type":"auto_retry_end","success":true,"attempt":1}',
		)[0];
		expect(finished).toMatchObject({
			title: 'Model request recovered',
			message: 'Recovered after 1 retry attempt.',
			level: 'success',
			status: 'succeeded',
			replaceKey: started?.replaceKey,
			persist: true,
		});
	});

	it('folds Codex command lifecycle events into one readable tool row', () => {
		const presenter = new AgentOutputPresenter('codex', 'recording');
		const command =
			'/run/current-system/sw/bin/zsh -lc "sed -n \'1,260p\' Journal/2026/03/2026-03-31.md"';
		const started = presenter.push(
			JSON.stringify({
				type: 'item.started',
				item: {
					id: 'item_8',
					type: 'command_execution',
					command,
					aggregated_output: '',
					exit_code: null,
					status: 'in_progress',
				},
			}),
		)[0];
		expect(started).toMatchObject({
			title: 'Read',
			message: 'Journal/2026/03/2026-03-31.md',
			presentation: 'tool',
			icon: 'file-text',
			status: 'running',
			persist: false,
		});
		expect(started?.detail).toContain(`Command\n${command}`);

		const finished = presenter.push(
			JSON.stringify({
				type: 'item.completed',
				item: {
					id: 'item_8',
					type: 'command_execution',
					command,
					aggregated_output: '# Journal entry\n',
					exit_code: 0,
					status: 'completed',
				},
			}),
		)[0];
		expect(finished).toMatchObject({
			title: 'Read',
			message: 'Journal/2026/03/2026-03-31.md',
			status: 'succeeded',
			replaceKey: started?.replaceKey,
			persist: true,
		});
		expect(finished?.detail).toContain('Output\n# Journal entry');
		expect(finished?.detail).toContain('Exit code: 0');
	});

	it('renders Codex searches compactly and keeps long output in details', () => {
		const presenter = new AgentOutputPresenter('codex');
		const command =
			'/run/current-system/sw/bin/zsh -lc "rg -l --glob \'**/*.md\' \'^---$\' Journal | sort | tail -20"';
		const finished = presenter.push(
			JSON.stringify({
				type: 'item.completed',
				item: {
					id: 'item_20',
					type: 'command_execution',
					command,
					aggregated_output:
						'Journal/2026/02/2026-02-02.md\nJournal/2026/02/2026-02-03.md\n',
					exit_code: 0,
					status: 'completed',
				},
			}),
		)[0];
		expect(finished).toMatchObject({
			title: 'Search',
			message: 'Journal',
			icon: 'search',
			status: 'succeeded',
		});
		expect(finished?.message).not.toContain('2026-02-02');
		expect(finished?.detail).toContain('Journal/2026/02/2026-02-02.md');
	});

	it('presents ordinary tool failures as warnings', () => {
		const codex = new AgentOutputPresenter('codex');
		const codexFailure = codex.push(
			'{"type":"item.completed","item":{"id":"item_9","type":"command_execution","command":"rg missing Journal","aggregated_output":"No matches","exit_code":1,"status":"failed"}}',
		)[0];
		expect(codexFailure).toMatchObject({
			level: 'warning',
			status: 'warning',
		});

		const pi = new AgentOutputPresenter('pi');
		const piFailure = pi.push(
			'{"type":"tool_execution_end","toolCallId":"call-1","toolName":"read","result":"missing","isError":true}',
		)[0];
		expect(piFailure).toMatchObject({
			level: 'warning',
			status: 'warning',
		});
	});

	it('hides Codex protocol noise and formats messages and file edits', () => {
		const presenter = new AgentOutputPresenter('codex');
		expect(presenter.push('{"type":"thread.started"}')).toEqual([]);
		expect(presenter.push('{"type":"turn.started"}')).toEqual([]);
		expect(presenter.push('{"type":"turn.completed"}')).toEqual([]);
		expect(agentTurnStarted('{"type":"turn.started"}')).toBe(true);
		expect(
			presenter.push(
				'{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I checked the existing notes."}}',
			)[0],
		).toMatchObject({
			title: 'Agent response',
			message: 'I checked the existing notes.',
			presentation: 'message',
		});
		const editStarted = presenter.push(
			'{"type":"item.started","item":{"id":"item_1","type":"file_change","changes":[{"path":"Journal/today.md","kind":"update"}],"status":"in_progress"}}',
		)[0];
		const editFinished = presenter.push(
			'{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"Journal/today.md","kind":"update"}],"status":"completed"}}',
		)[0];
		expect(editStarted).toMatchObject({
			title: 'Edit file',
			message: 'Journal/today.md',
			status: 'running',
		});
		expect(editFinished).toMatchObject({
			status: 'succeeded',
			replaceKey: editStarted?.replaceKey,
		});
	});

	it('hides Claude protocol noise and presents assistant text', () => {
		const presenter = new AgentOutputPresenter('claude');
		expect(
			presenter.push(
				'{"type":"system","subtype":"init","session_id":"abc","cwd":"/vault"}',
			),
		).toEqual([]);
		expect(agentTurnStarted('{"type":"system","subtype":"init"}')).toBe(false);
		expect(agentTurnStarted('{"type":"assistant"}')).toBe(true);
		const [message] = presenter.push(
			'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I checked the existing notes."}]}}',
		);
		expect(message).toMatchObject({
			title: 'Agent response',
			message: 'I checked the existing notes.',
			presentation: 'message',
			status: 'succeeded',
			persist: true,
		});
		expect(
			presenter.push(
				'{"type":"result","subtype":"success","is_error":false,"result":"Done."}',
			),
		).toEqual([]);
	});

	it('folds Claude tool_use/tool_result pairs into one readable tool row', () => {
		const presenter = new AgentOutputPresenter('claude', 'recording');
		const started = presenter.push(
			JSON.stringify({
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'toolu_1',
							name: 'Read',
							input: { file_path: 'Journal/2026/03/2026-03-31.md' },
						},
					],
				},
			}),
		)[0];
		expect(started).toMatchObject({
			title: 'Read',
			message: 'Journal/2026/03/2026-03-31.md',
			presentation: 'tool',
			icon: 'file-text',
			status: 'running',
			persist: false,
		});

		const finished = presenter.push(
			JSON.stringify({
				type: 'user',
				message: {
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'toolu_1',
							content: [{ type: 'text', text: '# Journal entry\n' }],
							is_error: false,
						},
					],
				},
			}),
		)[0];
		expect(finished).toMatchObject({
			title: 'Read',
			message: 'Journal/2026/03/2026-03-31.md',
			status: 'succeeded',
			replaceKey: started?.replaceKey,
			persist: true,
		});
		expect(finished?.detail).toContain('Output\n# Journal entry');
	});

	it('presents Claude tool failures as warnings', () => {
		const presenter = new AgentOutputPresenter('claude');
		presenter.push(
			JSON.stringify({
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'toolu_9',
							name: 'Grep',
							input: { pattern: 'missing', path: 'Journal' },
						},
					],
				},
			}),
		);
		const failure = presenter.push(
			JSON.stringify({
				type: 'user',
				message: {
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'toolu_9',
							content: 'No matches',
							is_error: true,
						},
					],
				},
			}),
		)[0];
		expect(failure).toMatchObject({
			level: 'warning',
			status: 'warning',
		});
	});

	it('reports interrupted Claude tool calls on flush', () => {
		const presenter = new AgentOutputPresenter('claude');
		presenter.push(
			JSON.stringify({
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{ type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: 'a.md' } },
					],
				},
			}),
		);
		const [flushed] = presenter.flush();
		expect(flushed).toMatchObject({ status: 'interrupted', level: 'warning' });
	});
});

describe('AgentOutputPresenter edge cases', () => {
	it.each(['pi', 'claude', 'codex'] as const)(
		'renders malformed or partial %s JSON lines as plain output',
		(type) => {
			const presenter = new AgentOutputPresenter(type);
			expect(presenter.push('{"type":"assistant","message":')).toEqual([
				expect.objectContaining({
					title: 'Agent output',
					message: '{"type":"assistant","message":',
				}),
			]);
			expect(presenter.push('plain stderr text')).toEqual([
				expect.objectContaining({ message: 'plain stderr text' }),
			]);
			expect(presenter.push('[1,2]')).toHaveLength(1);
		},
	);

	it('surfaces failed Claude results as error rows', () => {
		const presenter = new AgentOutputPresenter('claude');
		const [failure] = presenter.push(
			'{"type":"result","subtype":"error_max_turns","is_error":true}',
		);
		expect(failure).toMatchObject({
			level: 'error',
			status: 'failed',
			persist: true,
		});
		expect(failure?.message).toContain('max turns');
		const [explicit] = presenter.push(
			'{"type":"result","subtype":"success","is_error":true,"result":"API Error: 529 overloaded"}',
		);
		expect(explicit).toMatchObject({
			level: 'error',
			message: 'API Error: 529 overloaded',
		});
	});

	it('never reuses a Claude fallback tool id', () => {
		const presenter = new AgentOutputPresenter('claude');
		const toolUse = JSON.stringify({
			type: 'assistant',
			message: {
				role: 'assistant',
				content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.md' } }],
			},
		});
		const orphanResult = JSON.stringify({
			type: 'user',
			message: {
				role: 'user',
				content: [{ type: 'tool_result', content: 'ok' }],
			},
		});
		const keys = [
			presenter.push(toolUse)[0]?.replaceKey,
			presenter.push(orphanResult)[0]?.replaceKey,
			presenter.push(toolUse)[0]?.replaceKey,
			presenter.push(orphanResult)[0]?.replaceKey,
		];
		expect(keys.every((key) => key !== undefined)).toBe(true);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('surfaces Codex errors and failed turns as error rows', () => {
		const presenter = new AgentOutputPresenter('codex');
		expect(
			presenter.push('{"type":"error","message":"stream disconnected"}')[0],
		).toMatchObject({
			title: 'Codex error',
			message: 'stream disconnected',
			level: 'error',
		});
		expect(
			presenter.push(
				'{"type":"turn.failed","error":{"message":"usage limit reached"}}',
			)[0],
		).toMatchObject({
			title: 'Codex turn failed',
			message: 'usage limit reached',
			level: 'error',
			status: 'failed',
		});
	});

	it('updates the existing Codex row on item.updated', () => {
		const presenter = new AgentOutputPresenter('codex');
		const [started] = presenter.push(
			'{"type":"item.started","item":{"id":"item_5","type":"todo_list","items":[{"text":"a","completed":false}]}}',
		);
		const updated = presenter.push(
			'{"type":"item.updated","item":{"id":"item_5","type":"todo_list","items":[{"text":"a","completed":true}]}}',
		);
		expect(updated).toHaveLength(1);
		expect(updated[0]).toMatchObject({
			replaceKey: started?.replaceKey,
			status: 'running',
			persist: false,
		});
		expect(updated[0]?.detail).toContain('completed: true');
		const [completed] = presenter.push(
			'{"type":"item.completed","item":{"id":"item_5","type":"todo_list","items":[{"text":"a","completed":true}]}}',
		);
		expect(completed).toMatchObject({
			replaceKey: started?.replaceKey,
			status: 'succeeded',
		});
		expect(presenter.flush()).toEqual([]);
	});

	it('finalizes unfinished Pi content when the next message starts', () => {
		const presenter = new AgentOutputPresenter('pi');
		const [streaming] = presenter.push(
			'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Partial"}}',
		);
		expect(streaming).toMatchObject({ status: 'running' });
		const finalized = presenter.push(
			'{"type":"message_start","message":{"role":"assistant"}}',
		);
		expect(finalized).toEqual([
			expect.objectContaining({
				message: 'Partial',
				replaceKey: streaming?.replaceKey,
				status: 'succeeded',
				persist: true,
			}),
		]);
		const [next] = presenter.push(
			'{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}',
		);
		expect(next?.replaceKey).not.toBe(streaming?.replaceKey);
		expect(presenter.flush()).toHaveLength(1);
	});
});

describe('ActivityLog', () => {
	it('retains the structured summary for the final failure report', async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), 'voice-journal-log-'));
		temporaryDirectories.push(artifactRoot);
		const log = new ActivityLog();
		await log.startRun(artifactRoot, 'command', 'scan-and-process');
		log.add({
			kind: 'run',
			level: 'error',
			title: 'Run completed with errors',
			runSummary: {
				startedAt: '2026-09-22T10:00:00.000Z',
				finishedAt: '2026-09-22T10:00:01.000Z',
				origin: 'command',
				mode: 'scan-and-process',
				status: 'failed',
				candidateCount: 1,
				processedCount: 0,
				skippedCount: 0,
				processingFailureCount: 1,
				scanErrorCount: 0,
				warningCount: 0,
				errorCount: 1,
				message: 'Transcription failed.',
				issues: [
					{
						severity: 'error',
						path: '/recordings/sample.wav',
						message: 'Maximum file size exceeded.',
					},
				],
			},
		});

		expect(log.getEvents().at(-1)?.runSummary?.issues).toEqual([
			{
				severity: 'error',
				path: '/recordings/sample.wav',
				message: 'Maximum file size exceeded.',
			},
		]);
	});

	it('updates a streaming row in place and persists only its final snapshot', async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), 'voice-journal-log-'));
		temporaryDirectories.push(artifactRoot);
		const log = new ActivityLog();
		await log.startRun(artifactRoot, 'command', 'scan-and-process');
		log.add({
			kind: 'agent',
			title: 'Agent response',
			message: 'Hel',
			replaceKey: 'message-1',
			persist: false,
		});
		log.add({
			kind: 'agent',
			title: 'Agent response',
			message: 'Hello',
			replaceKey: 'message-1',
			persist: false,
		});
		expect(log.getEvents()).toHaveLength(2);
		expect(log.getEvents().at(-1)?.message).toBe('Hello');
		log.add({
			kind: 'agent',
			title: 'Agent response',
			message: 'Hello.',
			replaceKey: 'message-1',
			persist: true,
		});
		await log.flush();

		const files = await readdir(join(artifactRoot, 'runs'));
		const contents = await readFile(
			join(artifactRoot, 'runs', files[0] ?? ''),
			'utf8',
		);
		expect(contents).not.toContain('"message":"Hel"');
		expect(contents).toContain('"message":"Hello."');
	});

	it('persists the current run as JSONL', async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), 'voice-journal-log-'));
		temporaryDirectories.push(artifactRoot);
		const log = new ActivityLog();
		await log.startRun(artifactRoot, 'command', 'scan-and-process');
		log.add({
			kind: 'transcript',
			title: 'Transcription complete',
			detail: 'Private transcript fixture.',
		});
		await log.flush();

		const files = await readdir(join(artifactRoot, 'runs'));
		expect(files).toHaveLength(1);
		const contents = await readFile(
			join(artifactRoot, 'runs', files[0] ?? ''),
			'utf8',
		);
		expect(contents).toContain('Private transcript fixture.');
	});

	it('keeps only the current run and deletes it when the view is cleared', async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), 'voice-journal-log-'));
		temporaryDirectories.push(artifactRoot);
		const log = new ActivityLog();
		await log.startRun(artifactRoot, 'command', 'scan-and-process');
		log.add({ kind: 'pipeline', title: 'First run event' });
		await log.flush();
		await log.startRun(artifactRoot, 'ribbon', 'scan-and-process');
		await log.flush();
		expect(await readdir(join(artifactRoot, 'runs'))).toHaveLength(1);

		await log.clearView();
		await expect(readdir(join(artifactRoot, 'runs'))).rejects.toThrow();
		expect(log.getEvents()).toEqual([]);
	});

	it('keeps logging after the view is cleared mid-run', async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), 'voice-journal-log-'));
		temporaryDirectories.push(artifactRoot);
		const log = new ActivityLog();
		await log.startRun(artifactRoot, 'command', 'scan-and-process');
		await log.clearView();
		expect(log.getRunId()).not.toBeNull();
		log.add({ kind: 'pipeline', title: 'Event after clearing' });
		await log.flush();

		const files = await readdir(join(artifactRoot, 'runs'));
		expect(files).toHaveLength(1);
		const contents = await readFile(
			join(artifactRoot, 'runs', files[0] ?? ''),
			'utf8',
		);
		expect(contents).toContain('Event after clearing');
		expect(log.getEvents()).toHaveLength(1);
	});

	it('never evicts change reports when the in-memory cap is reached', async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), 'voice-journal-log-'));
		temporaryDirectories.push(artifactRoot);
		const log = new ActivityLog();
		await log.startRun(artifactRoot, 'command', 'scan-and-process');
		const report = log.add({
			kind: 'changes',
			title: 'Vault changes',
			changes: [],
			persist: false,
		});
		for (let index = 0; index < 2_100; index += 1) {
			log.add({ kind: 'agent', title: `Row ${index.toString()}`, persist: false });
		}
		const events = log.getEvents();
		expect(events).toHaveLength(2_000);
		expect(events.some((event) => event.id === report?.id)).toBe(true);
		expect(events.at(-1)?.title).toBe('Row 2099');
		expect(events.some((event) => event.title === 'Row 0')).toBe(false);
	});
});
