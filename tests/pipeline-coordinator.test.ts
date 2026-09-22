import { describe, expect, it, vi } from 'vitest';
import type {
	AudioCandidate,
	PipelineProgress,
	RuntimeState,
} from '../src/model';
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

describe('PipelineCoordinator', () => {
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
