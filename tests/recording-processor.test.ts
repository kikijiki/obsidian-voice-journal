import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	AudioCandidate,
	PipelineProgress,
	RecordingState,
	VoiceJournalSettings,
} from '../src/model';
import type { NewActivityEvent } from '../src/activity/log';
import {
	buildJournalAgentPrompt,
	RecordingProcessor,
} from '../src/pipeline/recording-processor';
import { DEFAULT_SETTINGS } from '../src/settings/model';

const temporaryDirectories: string[] = [];

function sourceValuesFromPrompt(prompt: string): string[] {
	return [...prompt.matchAll(/"sha256:[a-f0-9]+"/gu)].map(
		(match) => match[0],
	);
}

function journalWithSources(sources: string[], body = ''): string {
	return `---\nvoice_journal_sources:\n${sources.map((source) => `  - ${source}`).join('\n')}\n---\n${body}`;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

async function fixture(): Promise<{
	vaultRoot: string;
	artifactRoot: string;
	candidate: AudioCandidate;
	settings: VoiceJournalSettings;
}> {
	const root = await mkdtemp(join(tmpdir(), 'voice-journal-process-'));
	temporaryDirectories.push(root);
	const vaultRoot = join(root, 'vault');
	const sourcePath = join(root, 'TX01_MIC001_20260921_190000_orig.wav');
	await writeFile(sourcePath, 'synthetic audio');
	await writeFile(join(root, '.keep'), '');
	const file = await stat(sourcePath);
	return {
		vaultRoot,
		artifactRoot: join(vaultRoot, '.config', 'plugins', 'test', '.voice-journal'),
		candidate: {
			sourceId: 'dji',
			absolutePath: sourcePath,
			relativePath: basename(sourcePath),
			fileName: basename(sourcePath),
			size: file.size,
			modifiedAtMs: file.mtimeMs,
			recordedAtMs: file.mtimeMs,
		},
		settings: structuredClone(DEFAULT_SETTINGS),
	};
}

describe('RecordingProcessor', () => {
	it('transcribes a group independently and invokes the agent once', async () => {
		const input = await fixture();
		const secondPath = join(
			dirname(input.candidate.absolutePath),
			'TX01_MIC002_20260921_193000_orig.wav',
		);
		await writeFile(secondPath, 'second synthetic audio');
		const secondFile = await stat(secondPath);
		const secondCandidate: AudioCandidate = {
			...input.candidate,
			absolutePath: secondPath,
			relativePath: basename(secondPath),
			fileName: basename(secondPath),
			size: secondFile.size,
			modifiedAtMs: secondFile.mtimeMs,
			recordedAtMs: input.candidate.recordedAtMs + 30 * 60 * 1000,
		};
		const transcribe = vi.fn(async (_baseUrl: string, request: { fileName: string }) => ({
			text: `Transcript for ${request.fileName}`,
			segments: [],
			rawResponse: { text: `Transcript for ${request.fileName}` },
		}));
		const run = vi.fn(
			async (
				_settings: VoiceJournalSettings,
				vaultPath: string,
				prompt: string,
			) => {
				const sources = sourceValuesFromPrompt(prompt);
				await mkdir(join(vaultPath, 'Journal'), { recursive: true });
				await writeFile(
					join(vaultPath, 'Journal', 'grouped-entry.md'),
					journalWithSources(sources),
				);
				return { stdout: 'done', stderr: '' };
			},
		);
		const states: Record<string, RecordingState> = {};
		const common = {
			settings: input.settings,
			sttBaseUrl: 'http://localhost:8001/v1',
			vaultRoot: input.vaultRoot,
			artifactRoot: input.artifactRoot,
			findState: (hash: string) => states[hash],
			saveState: async (state: RecordingState) => {
				states[state.hash] = state;
			},
			reportProgress: () => undefined,
		};

		const outcomes = await new RecordingProcessor(
			{ transcribe },
			{ run },
			0,
		).processBatch([
			{ ...common, candidate: input.candidate },
			{ ...common, candidate: secondCandidate },
		]);

		expect(transcribe).toHaveBeenCalledTimes(2);
		expect(run).toHaveBeenCalledOnce();
		expect(run.mock.calls[0]?.[2]).toContain(input.candidate.fileName);
		expect(run.mock.calls[0]?.[2]).toContain(secondCandidate.fileName);
		expect(outcomes.map((outcome) => outcome.result)).toEqual([
			'processed',
			'processed',
		]);
		expect(Object.values(states).map((state) => state.stage)).toEqual([
			'complete',
			'complete',
		]);
	});

	it('does not launch the agent when any recording in a group fails', async () => {
		const input = await fixture();
		const secondPath = join(
			dirname(input.candidate.absolutePath),
			'TX01_MIC002_20260921_193000_orig.wav',
		);
		await writeFile(secondPath, 'second synthetic audio');
		const secondFile = await stat(secondPath);
		const secondCandidate: AudioCandidate = {
			...input.candidate,
			absolutePath: secondPath,
			relativePath: basename(secondPath),
			fileName: basename(secondPath),
			size: secondFile.size,
			modifiedAtMs: secondFile.mtimeMs,
			recordedAtMs: input.candidate.recordedAtMs + 30 * 60 * 1000,
		};
		const transcribe = vi.fn(
			async (_baseUrl: string, request: { fileName: string }) => {
				if (request.fileName === secondCandidate.fileName) {
					throw new Error('Maximum file size exceeded.');
				}
				return {
					text: 'First transcript is complete.',
					segments: [],
					rawResponse: { text: 'First transcript is complete.' },
				};
			},
		);
		const run = vi.fn(async () => ({ stdout: '', stderr: '' }));
		const states: Record<string, RecordingState> = {};
		const common = {
			settings: input.settings,
			sttBaseUrl: 'http://localhost:8001/v1',
			vaultRoot: input.vaultRoot,
			artifactRoot: input.artifactRoot,
			findState: (hash: string) => states[hash],
			saveState: async (state: RecordingState) => {
				states[state.hash] = state;
			},
			reportProgress: () => undefined,
		};

		const outcomes = await new RecordingProcessor(
			{ transcribe },
			{ run },
			0,
		).processBatch([
			{ ...common, candidate: input.candidate },
			{ ...common, candidate: secondCandidate },
		]);

		expect(run).not.toHaveBeenCalled();
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			candidate: secondCandidate,
			result: 'failed',
		});
		expect(
			Object.values(states).find(
				(state) => state.fileName === input.candidate.fileName,
			),
		).toMatchObject({ stage: 'transcribed' });
		expect(
			Object.values(states).find(
				(state) => state.fileName === secondCandidate.fileName,
			),
		).toMatchObject({
			stage: 'copied',
			lastError: 'Maximum file size exceeded.',
		});
	});

	it('archives, transcribes, invokes the agent, and deduplicates by hash', async () => {
		const input = await fixture();
		input.settings.codingAgentType = 'codex';
		input.settings.codingAgentExecutable = 'codex';
		const transcribe = vi.fn(async () => ({
			text: 'I talked to Samantha about a book.',
			segments: [],
			rawResponse: { text: 'I talked to Samantha about a book.' },
		}));
		const run = vi.fn(
			async (
				_settings: VoiceJournalSettings,
				vaultPath: string,
				prompt: string,
				onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void,
			) => {
				onOutput?.(
					'stdout',
					'{"type":"turn.started"}\n',
				);
				const source = sourceValuesFromPrompt(prompt)[0];
				await mkdir(join(vaultPath, 'Journal'), { recursive: true });
				await writeFile(
					join(vaultPath, 'Journal', 'entry.md'),
					journalWithSources(source === undefined ? [] : [source]),
				);
				return { stdout: 'done', stderr: '' };
			},
		);
		const processor = new RecordingProcessor({ transcribe }, { run }, 0);
		const states: Record<string, RecordingState> = {};
		const progress: PipelineProgress[] = [];
		const activity: NewActivityEvent[] = [];
		const process = async () =>
			await processor.process({
				...input,
				sttBaseUrl: 'http://localhost:8001/v1',
				findState: (hash) => states[hash],
				saveState: async (state) => {
					states[state.hash] = state;
				},
				reportProgress: (next) => progress.push(next),
				reportActivity: (event) => activity.push(event),
			});

		expect(await process()).toBe('processed');
		const state = Object.values(states)[0];
		expect(state?.stage).toBe('complete');
		expect(state?.archivedAudioPath).toContain('.voice-journal');
		expect(state?.transcriptPath).toContain('raw-transcript.txt');
		expect(await readFile(input.candidate.absolutePath, 'utf8')).toBe(
			'synthetic audio',
		);
		expect(
			await readFile(join(input.vaultRoot, state?.transcriptPath ?? ''), 'utf8'),
		).toContain('Samantha');
		expect(run).toHaveBeenCalledOnce();
		expect(activity).toContainEqual(
			expect.objectContaining({
				kind: 'changes',
				persist: false,
				changes: [
					expect.objectContaining({
						path: 'Journal/entry.md',
						kind: 'created',
					}),
				],
			}),
		);
		expect(run.mock.calls[0]?.[2]).toContain(`"sha256:${state?.hash ?? ''}"`);
		expect(run.mock.calls[0]?.[2]).toMatch(
			/^You are editing an existing Obsidian vault/u,
		);
		expect(progress).toContainEqual(
			expect.objectContaining({
				message: 'Codex inference in progress…',
			}),
		);

		await rm(input.artifactRoot, { recursive: true, force: true });
		expect(await process()).toBe('skipped');
		expect(transcribe).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledOnce();
	});

	it('does not inject model-specific thinking tokens into the prompt', () => {
		const prompt = buildJournalAgentPrompt({
			journalDirectory: 'Journal',
			addNewEntries: true,
			updateExistingEntries: true,
			additionalInstructions: 'Use my established informal writing style.',
			recordings: [
				{
					fileName: 'recording.wav',
					sourceHash: 'abc123',
					recordedAt: '2026-09-21T09:00:00.000+09:00',
					archivedAudioPath: 'Journal/.voice-journal/audio.wav',
					transcriptPath: 'Journal/.voice-journal/raw-transcript.txt',
				},
			],
		});
		expect(prompt).not.toContain('<|think_');
		expect(prompt).toContain('Issue exactly one tool call at a time');
		expect(prompt).toContain('relative to the vault root');
		expect(prompt).toContain('Never repeat an identical failed call');
		expect(prompt).toContain('read tool accepts files only');
		expect(prompt).toContain('an EISDIR error');
		expect(prompt).toContain('Never call grep without a specific relative path');
		expect(prompt).toContain('commonly contain spaces and punctuation');
		expect(prompt).toContain('[[People/Women/Samantha|Samantha]]');
		expect(prompt).toContain('frontmatter aliases');
		expect(prompt).toContain('target before the |');
		expect(prompt).toContain('only one literal display form');
		expect(prompt).toContain('Never search inside .voice-journal');
		expect(prompt).toContain('only inside "Journal"');
		expect(prompt).toContain('create the appropriate Poncle note');
		expect(prompt).toContain('enrich relevant existing notes');
		expect(prompt).toContain('representative set of nearby and recent');
		expect(prompt).toContain('Use my established informal writing style.');
		expect(prompt).toContain('Write natural English');
		expect(prompt).toContain('Avoid AI mannerisms, em dashes');
		expect(prompt).toContain('LinkedIn-style embellishment');
		expect(prompt).toContain('voice_journal_sources');
		expect(prompt).toContain('do not add an H1 containing the same date');
	});

	it('constrains auxiliary vault edits when both permissions are disabled', () => {
		const prompt = buildJournalAgentPrompt({
			journalDirectory: 'Journal',
			addNewEntries: false,
			updateExistingEntries: false,
			additionalInstructions: '',
			recordings: [],
		});
		expect(prompt).toContain('Do not create notes outside');
		expect(prompt).toContain('Do not modify existing notes other than');
	});

	it('retains a transcript and resumes at the agent after an agent failure', async () => {
		const input = await fixture();
		const transcribe = vi.fn(async () => ({
			text: 'Retry me.',
			segments: [],
			rawResponse: { text: 'Retry me.' },
		}));
		const failingRun = vi.fn(
			async (
				_settings: VoiceJournalSettings,
				_vaultPath: string,
				_prompt: string,
			) => {
				throw new Error('Agent failed.');
			},
		);
		const states: Record<string, RecordingState> = {};
		const common = {
			...input,
			sttBaseUrl: 'http://localhost:8001/v1',
			findState: (hash: string) => states[hash],
			saveState: async (state: RecordingState) => {
				states[state.hash] = state;
			},
			reportProgress: () => undefined,
		};
		await expect(
			new RecordingProcessor({ transcribe }, { run: failingRun }, 0).process(
				common,
			),
		).rejects.toThrow('Agent failed');
		expect(Object.values(states)[0]).toMatchObject({
			stage: 'transcribed',
			lastError: 'Agent failed.',
		});

		const successfulRun = vi.fn(
			async (
				_settings: VoiceJournalSettings,
				vaultPath: string,
				prompt: string,
			) => {
				const source = sourceValuesFromPrompt(prompt)[0];
				await mkdir(join(vaultPath, 'Journal'), { recursive: true });
				await writeFile(
					join(vaultPath, 'Journal', 'entry.md'),
					journalWithSources(source === undefined ? [] : [source]),
				);
				return { stdout: 'done', stderr: '' };
			},
		);
		await expect(
			new RecordingProcessor({ transcribe }, { run: successfulRun }, 0).process(
				common,
			),
		).resolves.toBe('processed');
		expect(transcribe).toHaveBeenCalledOnce();
		expect(successfulRun).toHaveBeenCalledOnce();
		expect(Object.values(states)[0]?.stage).toBe('complete');
	});

	it('does not mark an exit-zero agent run complete without source metadata', async () => {
		const input = await fixture();
		const transcribe = vi.fn(async () => ({
			text: 'No marker yet.',
			segments: [],
			rawResponse: { text: 'No marker yet.' },
		}));
		const run = vi.fn(
			async (
				_settings: VoiceJournalSettings,
				_vaultPath: string,
				_prompt: string,
			) => ({ stdout: 'claimed success', stderr: '' }),
		);
		const states: Record<string, RecordingState> = {};

		await expect(
			new RecordingProcessor({ transcribe }, { run }, 0).process({
				...input,
				sttBaseUrl: 'http://localhost:8001/v1',
				findState: (hash) => states[hash],
				saveState: async (state) => {
					states[state.hash] = state;
				},
				reportProgress: () => undefined,
			}),
		).rejects.toThrow(/source metadata/i);
		expect(Object.values(states)[0]).toMatchObject({
			stage: 'transcribed',
			lastError:
				'Coding agent exited successfully but did not write the required source metadata.',
		});
	});

	it('rejects HTML provenance comments', async () => {
		const input = await fixture();
		const states: Record<string, RecordingState> = {};
		const run = vi.fn(
			async (
				_settings: VoiceJournalSettings,
				vaultPath: string,
				prompt: string,
			) => {
				const source = sourceValuesFromPrompt(prompt)[0] ?? '';
				await mkdir(join(vaultPath, 'Journal'), { recursive: true });
				await writeFile(
					join(vaultPath, 'Journal', 'comment.md'),
					`Entry\n\n<!-- voice-journal-source: ${source.replaceAll('"', '')} -->\n`,
				);
				return { stdout: '', stderr: '' };
			},
		);

		await expect(
			new RecordingProcessor(
				{
					transcribe: async () => ({
						text: 'Transcript.',
						segments: [],
						rawResponse: { text: 'Transcript.' },
					}),
				},
				{ run },
				0,
			).process({
				...input,
				sttBaseUrl: 'http://localhost:8001/v1',
				findState: (hash) => states[hash],
				saveState: async (state) => {
					states[state.hash] = state;
				},
				reportProgress: () => undefined,
			}),
		).rejects.toThrow(/source metadata/iu);
	});

	it('allows Pi to recover from consecutive tool failures', async () => {
		const input = await fixture();
		const transcribe = vi.fn(async () => ({
			text: 'A transcript that needs journal processing.',
			segments: [],
			rawResponse: { text: 'A transcript that needs journal processing.' },
		}));
		const cancelActiveRun = vi.fn(() => true);
		const run = vi.fn(
			async (
				_settings: VoiceJournalSettings,
				vaultPath: string,
				prompt: string,
				onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void,
			) => {
				for (let index = 0; index < 3; index += 1) {
					onOutput?.(
						'stdout',
						`{"type":"tool_execution_end","toolCallId":"call-${index.toString()}","toolName":"read","result":"missing","isError":true}\n`,
					);
				}
				const source = sourceValuesFromPrompt(prompt)[0];
				await mkdir(join(vaultPath, 'Journal'), { recursive: true });
				await writeFile(
					join(vaultPath, 'Journal', 'recovered.md'),
					journalWithSources(source === undefined ? [] : [source]),
				);
				return { stdout: '', stderr: '' };
			},
		);
		const states: Record<string, RecordingState> = {};

		await expect(
			new RecordingProcessor(
				{ transcribe },
				{ run, cancelActiveRun },
				0,
			).process({
				...input,
				sttBaseUrl: 'http://localhost:8001/v1',
				findState: (hash) => states[hash],
				saveState: async (state) => {
					states[state.hash] = state;
				},
				reportProgress: () => undefined,
			}),
		).resolves.toBe('processed');
		expect(cancelActiveRun).not.toHaveBeenCalled();
		expect(Object.values(states)[0]).toMatchObject({
			stage: 'complete',
		});
	});

	it('does not launch the agent when cancellation arrives during STT', async () => {
		const input = await fixture();
		let cancelled = false;
		const transcribe = vi.fn(async () => {
			cancelled = true;
			return {
				text: 'Keep this completed transcript for the retry.',
				segments: [],
				rawResponse: { text: 'Keep this completed transcript for the retry.' },
			};
		});
		const run = vi.fn(async () => ({ stdout: '', stderr: '' }));
		const states: Record<string, RecordingState> = {};

		await expect(
			new RecordingProcessor({ transcribe }, { run }, 0).process({
				...input,
				sttBaseUrl: 'http://localhost:8001/v1',
				findState: (hash) => states[hash],
				saveState: async (state) => {
					states[state.hash] = state;
				},
				reportProgress: () => undefined,
				isCancelled: () => cancelled,
			}),
		).rejects.toThrow(/cancelled/i);
		expect(run).not.toHaveBeenCalled();
		expect(Object.values(states)[0]).toMatchObject({
			stage: 'transcribed',
			lastError: 'Voice journal run was cancelled.',
		});
	});

	it('does not create an empty change report when the agent is stopped', async () => {
		const input = await fixture();
		const activity: NewActivityEvent[] = [];
		const states: Record<string, RecordingState> = {};
		const run = vi.fn(async () => {
			throw new Error('Coding-agent run was cancelled.');
		});

		await expect(
			new RecordingProcessor(
				{
					transcribe: async () => ({
						text: 'A transcript with no applied vault changes.',
						segments: [],
						rawResponse: { text: 'A transcript with no applied vault changes.' },
					}),
				},
				{ run },
				0,
			).process({
				...input,
				sttBaseUrl: 'http://localhost:8001/v1',
				findState: (hash) => states[hash],
				saveState: async (state) => {
					states[state.hash] = state;
				},
				reportProgress: () => undefined,
				reportActivity: (event) => activity.push(event),
			}),
		).rejects.toThrow(/cancelled/iu);

		expect(activity.some((event) => event.kind === 'changes')).toBe(false);
	});
});
