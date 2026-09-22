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
});
