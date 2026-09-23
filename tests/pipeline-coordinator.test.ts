import { describe, expect, it, vi } from 'vitest';
import type {
	AudioCandidate,
	PipelineProgress,
	RecordingState,
	RuntimeState,
} from '../src/model';
import type { ProcessRecordingInput } from '../src/pipeline/recording-processor';
import {
	groupRecordingCandidates,
	PipelineCoordinator,
} from '../src/pipeline/coordinator';
import { DEFAULT_SETTINGS } from '../src/settings/model';

function candidate(fileName: string): AudioCandidate {
	return {
		sourceId: 'dji',
		absolutePath: `/source/${fileName}`,
		relativePath: fileName,
		fileName,
		size: 10,
		modifiedAtMs: 1,
		recordedAtMs: 1,
	};
}

function coordinatorWithProvider(
	listModels: (
		baseUrl: string,
		apiKey?: string,
		query?: Record<string, string>,
	) => Promise<string[]>,
	sttOverrides: Partial<typeof DEFAULT_SETTINGS>,
): PipelineCoordinator {
	const settings = {
		...structuredClone(DEFAULT_SETTINGS),
		...sttOverrides,
	};
	return new PipelineCoordinator({
		getSettings: () => settings,
		getRuntime: () => ({ lastRun: null, recordings: {} }),
		getVaultRoot: () => '/vault',
		getArtifactRoot: () => '/vault/.config/plugins/test/.voice-journal',
		saveRuntime: async () => undefined,
		reportProgress: () => undefined,
		scanner: { scan: async () => ({ candidates: [], errors: [], warnings: [] }) },
		provider: { checkHealth: async (baseUrl) => ({ baseUrl, ok: true, latencyMs: 1, models: [] }), listModels },
		agent: {
			checkHealth: async (type) => ({ type, ok: true, latencyMs: 1 }),
			listModels: async () => [],
		},
		processor: { processBatch: async () => [] },
	});
}

describe('PipelineCoordinator', () => {
	it('lists speech-to-text models against the active profile', async () => {
		const calls: Array<[string, string | undefined, Record<string, string> | undefined]> = [];
		const coordinator = coordinatorWithProvider(
			async (baseUrl, apiKey, query) => {
				calls.push([baseUrl, apiKey, query]);
				return ['custom/model'];
			},
			{ sttProvider: 'custom', sttBaseUrl: 'http://127.0.0.1:8000/v1', sttApiKey: 'secret' },
		);
		const models = await coordinator.listSttModels();
		expect(models).toEqual(['custom/model']);
		expect(calls).toEqual([['http://127.0.0.1:8000/v1', 'secret', undefined]]);
	});

	it('filters to transcription-capable models for the OpenRouter provider', async () => {
		const calls: Array<[string, string | undefined, Record<string, string> | undefined]> = [];
		const coordinator = coordinatorWithProvider(
			async (baseUrl, apiKey, query) => {
				calls.push([baseUrl, apiKey, query]);
				return ['openai/whisper-1'];
			},
			{
				sttProvider: 'openrouter',
				sttBaseUrl: 'https://openrouter.ai/api/v1',
				sttApiKey: 'sk-or-secret',
			},
		);
		const models = await coordinator.listSttModels();
		expect(models).toEqual(['openai/whisper-1']);
		expect(calls).toEqual([
			[
				'https://openrouter.ai/api/v1',
				'sk-or-secret',
				{ output_modalities: 'transcription' },
			],
		]);
	});

	it('threads the request format, chunk duration, and ffmpeg executable through to the processor', async () => {
		const runtime: RuntimeState = { lastRun: null, recordings: {} };
		const processBatch = vi.fn(async (inputs: Array<{ candidate: AudioCandidate }>) =>
			inputs.map(({ candidate: next }) => ({
				candidate: next,
				result: 'processed' as const,
			})),
		);
		const coordinator = new PipelineCoordinator({
			getSettings: () => ({
				...structuredClone(DEFAULT_SETTINGS),
				ffmpegExecutable: '/usr/local/bin/ffmpeg',
				sttProvider: 'openrouter',
				sttBaseUrl: 'https://openrouter.ai/api/v1',
				sttSplitLongRecordings: false,
			}),
			getRuntime: () => runtime,
			getVaultRoot: () => '/vault',
			getArtifactRoot: () => '/vault/.config/plugins/test/.voice-journal',
			saveRuntime: async () => undefined,
			reportProgress: () => undefined,
			scanner: {
				scan: async () => ({
					candidates: [candidate('long.wav')],
					errors: [],
					warnings: [],
				}),
			},
			provider: {
				checkHealth: async (baseUrl) => ({ baseUrl, ok: true, latencyMs: 1, models: [] }),
				listModels: async () => [],
			},
			agent: {
				checkHealth: async (type) => ({ type, ok: true, latencyMs: 1 }),
				listModels: async () => [],
			},
			processor: { processBatch },
		});

		await coordinator.run('scan-and-process', 'command');

		expect(processBatch).toHaveBeenCalledOnce();
		expect(processBatch.mock.calls[0]?.[0]?.[0]).toMatchObject({
			sttRequestFormat: 'json-base64',
			splitLongRecordings: false,
			ffmpegExecutable: '/usr/local/bin/ffmpeg',
		});
	});

	it('matches recordings by file name, size, and modification time', async () => {
		const known: RecordingState = {
			hash: 'b'.repeat(64),
			stage: 'complete',
			sourcePath: '/old/mount/long.wav',
			fileName: 'long.wav',
			size: 10,
			sourceModifiedAtMs: 1,
			attempts: 1,
			updatedAt: '2026-09-23T00:00:00.000Z',
		};
		const runtime: RuntimeState = {
			lastRun: null,
			recordings: { [known.hash]: known },
		};
		let captured: ProcessRecordingInput | undefined;
		const coordinator = new PipelineCoordinator({
			getSettings: () => ({
				...structuredClone(DEFAULT_SETTINGS),
				sttBaseUrl: 'http://127.0.0.1:8001/v1',
			}),
			getRuntime: () => runtime,
			getVaultRoot: () => '/vault',
			getArtifactRoot: () => '/vault/.config/plugins/test/.voice-journal',
			saveRuntime: async () => undefined,
			reportProgress: () => undefined,
			scanner: {
				scan: async () => ({
					candidates: [candidate('long.wav')],
					errors: [],
					warnings: [],
				}),
			},
			provider: {
				checkHealth: async (baseUrl) => ({ baseUrl, ok: true, latencyMs: 1, models: [] }),
				listModels: async () => [],
			},
			agent: {
				checkHealth: async (type) => ({ type, ok: true, latencyMs: 1 }),
				listModels: async () => [],
			},
			processor: {
				processBatch: async (inputs) => {
					captured = inputs[0];
					return inputs.map((next) => ({
						candidate: next.candidate,
						result: 'skipped' as const,
					}));
				},
			},
		});

		await coordinator.run('scan-and-process', 'command');

		const match = captured?.findStateByFingerprint?.(candidate('long.wav'));
		expect(match?.hash).toBe(known.hash);
		expect(
			captured?.findStateByFingerprint?.({ ...candidate('long.wav'), size: 11 }),
		).toBeUndefined();
		expect(
			captured?.findStateByFingerprint?.({
				...candidate('long.wav'),
				modifiedAtMs: 2,
			}),
		).toBeUndefined();

		captured?.recordFingerprint?.(known, {
			...candidate('long.wav'),
			absolutePath: '/new/mount/long.wav',
			size: 12,
			modifiedAtMs: 3,
		});
		expect(known).toMatchObject({
			sourcePath: '/new/mount/long.wav',
			size: 12,
			sourceModifiedAtMs: 3,
		});
	});

	it('leaves the request format undefined for a custom speech-to-text profile', async () => {
		const runtime: RuntimeState = { lastRun: null, recordings: {} };
		const processBatch = vi.fn(async (inputs: Array<{ candidate: AudioCandidate }>) =>
			inputs.map(({ candidate: next }) => ({
				candidate: next,
				result: 'processed' as const,
			})),
		);
		const coordinator = new PipelineCoordinator({
			getSettings: () => structuredClone(DEFAULT_SETTINGS),
			getRuntime: () => runtime,
			getVaultRoot: () => '/vault',
			getArtifactRoot: () => '/vault/.config/plugins/test/.voice-journal',
			saveRuntime: async () => undefined,
			reportProgress: () => undefined,
			scanner: {
				scan: async () => ({
					candidates: [candidate('short.wav')],
					errors: [],
					warnings: [],
				}),
			},
			provider: {
				checkHealth: async (baseUrl) => ({ baseUrl, ok: true, latencyMs: 1, models: [] }),
				listModels: async () => [],
			},
			agent: {
				checkHealth: async (type) => ({ type, ok: true, latencyMs: 1 }),
				listModels: async () => [],
			},
			processor: { processBatch },
		});

		await coordinator.run('scan-and-process', 'command');

		expect(processBatch.mock.calls[0]?.[0]?.[0]).toMatchObject({
			sttRequestFormat: undefined,
			splitLongRecordings: true,
			ffmpegExecutable: 'ffmpeg',
		});
	});

	it('groups recordings by local calendar periods and all available', () => {
		const at = (year: number, month: number, day: number, hour = 12) =>
			new Date(year, month - 1, day, hour).valueOf();
		const recordings = [
			{ ...candidate('monday-am.wav'), recordedAtMs: at(2026, 9, 21, 9) },
			{ ...candidate('monday-pm.wav'), recordedAtMs: at(2026, 9, 21, 18) },
			{ ...candidate('sunday.wav'), recordedAtMs: at(2026, 9, 27) },
			{ ...candidate('next-monday.wav'), recordedAtMs: at(2026, 9, 28) },
			{ ...candidate('october.wav'), recordedAtMs: at(2026, 10, 1) },
		];

		expect(
			groupRecordingCandidates(recordings, 'day').map((group) => group.length),
		).toEqual([2, 1, 1, 1]);
		expect(
			groupRecordingCandidates(recordings, 'week').map((group) => group.length),
		).toEqual([3, 2]);
		expect(
			groupRecordingCandidates(recordings, 'month').map((group) => group.length),
		).toEqual([4, 1]);
		expect(groupRecordingCandidates(recordings, 'all')).toHaveLength(1);
		expect(groupRecordingCandidates(recordings, 'none')).toHaveLength(5);
	});

	it('stops after the first recording failure and reports its source', async () => {
		const runtime: RuntimeState = { lastRun: null, recordings: {} };
		const progress: PipelineProgress[] = [];
		const saved: RuntimeState[] = [];
		const processBatch = vi.fn(async (inputs: Array<{ candidate: AudioCandidate }>) =>
			inputs.map(({ candidate: next }) =>
				next.fileName === 'bad.wav'
					? {
							candidate: next,
							result: 'failed' as const,
							error: new Error('Synthetic STT failure.'),
						}
					: { candidate: next, result: 'processed' as const },
			),
		);
		const coordinator = new PipelineCoordinator({
			getSettings: () => ({
				...structuredClone(DEFAULT_SETTINGS),
				recordingGrouping: 'none',
			}),
			getRuntime: () => runtime,
			getVaultRoot: () => '/vault',
			getArtifactRoot: () => '/vault/.config/plugins/test/.voice-journal',
			saveRuntime: async (next) => {
				saved.push(structuredClone(next));
			},
			reportProgress: (next) => progress.push(next),
			scanner: {
				scan: async () => ({
					candidates: [candidate('bad.wav'), candidate('good.wav')],
					errors: [],
					warnings: [
						{
							sourceId: 'dji',
							path: '/source/good.wav',
							message: 'Timestamp is in the future.',
						},
					],
				}),
			},
			provider: {
				checkHealth: async (baseUrl) => ({
					baseUrl,
					ok: true,
					latencyMs: 1,
					models: [],
				}),
				listModels: async () => [],
			},
		agent: {
			checkHealth: async (type) => ({ type, ok: true, latencyMs: 1 }),
			listModels: async () => ['test/model'],
		},
			processor: { processBatch },
		});

		const result = await coordinator.run('scan-and-process', 'command');

		expect(processBatch).toHaveBeenCalledTimes(1);
		expect(result.summary).toMatchObject({
			status: 'failed',
			candidateCount: 2,
			processedCount: 0,
			processingFailureCount: 1,
			scanErrorCount: 0,
			warningCount: 1,
			errorCount: 1,
		});
		expect(result.summary.message).toContain('recording failures 1');
		expect(result.summary.message).toContain('scan errors 0');
		expect(result.summary.issues).toHaveLength(2);
		expect(progress).toContainEqual(
			expect.objectContaining({
				stage: 'failed',
				message: 'Synthetic STT failure.',
				fileName: 'bad.wav',
			}),
		);
		expect(saved.at(-1)?.lastRun).toEqual(result.summary);
		expect(progress.at(-1)?.stage).toBe('failed');
	});

	it('does not process partial scan results when a source scan fails', async () => {
		const runtime: RuntimeState = { lastRun: null, recordings: {} };
		const processBatch = vi.fn();
		const coordinator = new PipelineCoordinator({
			getSettings: () => structuredClone(DEFAULT_SETTINGS),
			getRuntime: () => runtime,
			getVaultRoot: () => '/vault',
			getArtifactRoot: () => '/vault/.config/plugins/test/.voice-journal',
			saveRuntime: async () => undefined,
			reportProgress: () => undefined,
			scanner: {
				scan: async () => ({
					candidates: [candidate('partial.wav')],
					errors: [
						{
							sourceId: 'missing',
							path: '/missing',
							message: 'Source missing.',
						},
					],
					warnings: [],
				}),
			},
			provider: {
				checkHealth: async (baseUrl) => ({
					baseUrl,
					ok: true,
					latencyMs: 1,
					models: [],
				}),
				listModels: async () => [],
			},
			agent: {
				checkHealth: async (type) => ({ type, ok: true, latencyMs: 1 }),
				listModels: async () => ['test/model'],
			},
			processor: { processBatch },
		});

		const result = await coordinator.run('scan-and-process', 'command');

		expect(processBatch).not.toHaveBeenCalled();
		expect(result.summary).toMatchObject({
			status: 'failed',
			scanErrorCount: 1,
			processedCount: 0,
		});
		expect(result.summary.message).toContain('Stopped before processing');
	});
});
