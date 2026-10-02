import type {
	AudioCandidate,
	CodingAgentHealth,
	PipelineMode,
	PipelineProgress,
	PipelineRunResult,
	ProviderHealth,
	ProviderHealthReport,
	RecordingState,
	RecordingGrouping,
	RunIssue,
	RunOrigin,
	RunSummary,
	RuntimeState,
	VoiceJournalSettings,
	ScanResult,
} from '../model';
import type { NewActivityEvent } from '../activity/log';
import {
	effectiveSttBaseUrl,
	OPENROUTER_STT_MODEL_QUERY,
} from '../providers/openrouter';
import { formatLocalTimestamp } from '../ingest/recording-timestamp';
import { pruneArtifactCache } from '../storage/artifact-cache';
import type {
	ProcessRecordingInput,
	ProcessRecordingOutcome,
} from './recording-processor';

interface Scanner {
	scan(
		sources: VoiceJournalSettings['recordingSources'],
		maxEntries: number,
	): Promise<ScanResult>;
	scanPaths(
		absolutePaths: string[],
		sources?: VoiceJournalSettings['recordingSources'],
	): Promise<ScanResult>;
}

interface HealthProvider {
	checkHealth(baseUrl: string, apiKey?: string): Promise<ProviderHealth>;
	listModels(
		baseUrl: string,
		apiKey?: string,
		query?: Record<string, string>,
	): Promise<string[]>;
}

interface AgentHealthProvider {
	checkHealth(
		type: VoiceJournalSettings['codingAgentType'],
		executable: string,
		model: string,
	): Promise<CodingAgentHealth>;
	listModels(
		type: VoiceJournalSettings['codingAgentType'],
		executable: string,
	): Promise<string[]>;
}

interface Processor {
	processBatch(inputs: ProcessRecordingInput[]): Promise<ProcessRecordingOutcome[]>;
	cancel?: () => boolean;
}

export interface PipelineDependencies {
	getSettings: () => VoiceJournalSettings;
	getRuntime: () => RuntimeState;
	getVaultRoot: () => string;
	getArtifactRoot: () => string;
	saveRuntime: (runtime: RuntimeState) => Promise<void>;
	reportProgress: (progress: PipelineProgress) => void;
	reportActivity?: (event: NewActivityEvent) => void;
	scanner: Scanner;
	provider: HealthProvider;
	agent: AgentHealthProvider;
	processor: Processor;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown pipeline error.';
}

interface RunCounters {
	candidateCount: number;
	processedCount: number;
	skippedCount: number;
	processingFailureCount: number;
	scanErrorCount: number;
	warningCount: number;
}

function freshCounters(): RunCounters {
	return {
		candidateCount: 0,
		processedCount: 0,
		skippedCount: 0,
		processingFailureCount: 0,
		scanErrorCount: 0,
		warningCount: 0,
	};
}

/** Stops a run after this many groups fail in a row, e.g. during a service outage. */
const MAX_CONSECUTIVE_GROUP_FAILURES = 3;

function isTerminal(state: RecordingState | undefined): boolean {
	return state?.stage === 'complete' || state?.stage === 'failed';
}

/**
 * Unfinished recordings whose source file is no longer being scanned (for
 * example, a wiped or unmounted device) but whose archived audio or transcript
 * lets processing continue without it.
 */
function resumableOrphans(
	runtime: RuntimeState,
	scannedPaths: ReadonlySet<string>,
): Array<{ candidate: AudioCandidate; hash: string }> {
	return Object.values(runtime.recordings).flatMap((state) => {
		const resumable =
			(state.stage === 'copied' && state.archivedAudioPath !== undefined) ||
			(state.stage === 'transcribed' && state.transcriptPath !== undefined);
		if (!resumable || scannedPaths.has(state.sourcePath)) {
			return [];
		}
		const modifiedAtMs = state.sourceModifiedAtMs ?? Date.parse(state.updatedAt);
		return [
			{
				hash: state.hash,
				candidate: {
					sourceId: 'resumed',
					absolutePath: state.sourcePath,
					relativePath: state.fileName,
					fileName: state.fileName,
					size: state.size ?? 0,
					modifiedAtMs,
					recordedAtMs: state.recordedAtMs ?? modifiedAtMs,
				},
			},
		];
	});
}

function localDateKey(timestampMs: number): string {
	const date = new Date(timestampMs);
	return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
}

export function groupRecordingCandidates(
	candidates: AudioCandidate[],
	grouping: RecordingGrouping,
): AudioCandidate[][] {
	const sorted = [...candidates].sort(
		(left, right) => left.recordedAtMs - right.recordedAtMs,
	);
	if (grouping === 'none') {
		return sorted.map((candidate) => [candidate]);
	}
	if (grouping === 'all') {
		return sorted.length === 0 ? [] : [sorted];
	}
	const groups = new Map<string, AudioCandidate[]>();
	for (const candidate of sorted) {
		const date = new Date(candidate.recordedAtMs);
		let key: string;
		if (grouping === 'month') {
			key = `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;
		} else if (grouping === 'week') {
			const monday = new Date(candidate.recordedAtMs);
			monday.setHours(0, 0, 0, 0);
			monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
			key = localDateKey(monday.valueOf());
		} else {
			key = localDateKey(candidate.recordedAtMs);
		}
		const group = groups.get(key) ?? [];
		group.push(candidate);
		groups.set(key, group);
	}
	return [...groups.values()];
}

export class PipelineCoordinator {
	private running = false;
	private cancelRequested = false;

	constructor(private readonly dependencies: PipelineDependencies) {}

	isRunning(): boolean {
		return this.running;
	}

	cancel(): boolean {
		if (!this.running) {
			return false;
		}
		this.cancelRequested = true;
		this.dependencies.processor.cancel?.();
		this.dependencies.reportProgress({
			stage: 'cancelled',
			message: 'Cancellation requested; stopping the active operation…',
		});
		return true;
	}

	async checkStt(): Promise<ProviderHealth> {
		const settings = this.dependencies.getSettings();
		return await this.dependencies.provider.checkHealth(
			effectiveSttBaseUrl(settings),
			settings.sttApiKey,
		);
	}

	async listSttModels(): Promise<string[]> {
		const settings = this.dependencies.getSettings();
		return await this.dependencies.provider.listModels(
			effectiveSttBaseUrl(settings),
			settings.sttApiKey,
			settings.sttProvider === 'openrouter' ? OPENROUTER_STT_MODEL_QUERY : undefined,
		);
	}

	async checkCodingAgent(): Promise<CodingAgentHealth> {
		const settings = this.dependencies.getSettings();
		return await this.dependencies.agent.checkHealth(
			settings.codingAgentType,
			settings.codingAgentExecutable,
			settings.codingAgentModel,
		);
	}

	async listCodingAgentModels(): Promise<string[]> {
		const settings = this.dependencies.getSettings();
		return await this.dependencies.agent.listModels(
			settings.codingAgentType,
			settings.codingAgentExecutable,
		);
	}

	async checkProviders(): Promise<ProviderHealthReport> {
		const [agent, stt] = await Promise.all([
			this.checkCodingAgent(),
			this.checkStt(),
		]);
		return { agent, stt };
	}

	async run(mode: PipelineMode, origin: RunOrigin): Promise<PipelineRunResult> {
		if (this.running) {
			throw new Error('A voice journal pipeline run is already active.');
		}
		this.running = true;
		this.cancelRequested = false;
		const startedAt = new Date();
		const counters = freshCounters();
		const issues: RunIssue[] = [];
		try {
			const settings = this.dependencies.getSettings();
			this.dependencies.reportProgress({
				stage: 'scanning',
				message: 'Scanning configured recording sources…',
			});
			const scan = await this.dependencies.scanner.scan(
				settings.recordingSources,
				settings.maxEntriesPerScan,
			);
			return await this.processScan(scan, mode, origin, startedAt, counters, issues, {
				resumeOrphans: true,
				retryFailed: false,
			});
		} catch (error) {
			return await this.finishWithFatalError(
				error,
				origin,
				mode,
				startedAt,
				counters,
				issues,
			);
		} finally {
			this.running = false;
		}
	}

	/** Processes recordings picked directly in the activity panel, bypassing configured watched folders. */
	async runManual(
		absolutePaths: string[],
		origin: RunOrigin,
	): Promise<PipelineRunResult> {
		if (this.running) {
			throw new Error('A voice journal pipeline run is already active.');
		}
		this.running = true;
		this.cancelRequested = false;
		const startedAt = new Date();
		const counters = freshCounters();
		const issues: RunIssue[] = [];
		const mode: PipelineMode = 'scan-and-process';
		try {
			this.dependencies.reportProgress({
				stage: 'scanning',
				message: 'Preparing the selected recording(s)…',
			});
			const scan = await this.dependencies.scanner.scanPaths(
				absolutePaths,
				this.dependencies.getSettings().recordingSources,
			);
			return await this.processScan(scan, mode, origin, startedAt, counters, issues, {
				resumeOrphans: false,
				retryFailed: true,
			});
		} catch (error) {
			return await this.finishWithFatalError(
				error,
				origin,
				mode,
				startedAt,
				counters,
				issues,
			);
		} finally {
			this.running = false;
		}
	}

	private async finishWithFatalError(
		error: unknown,
		origin: RunOrigin,
		mode: PipelineMode,
		startedAt: Date,
		counters: RunCounters,
		issues: RunIssue[],
	): Promise<never> {
		const runtime = this.dependencies.getRuntime();
		const fatalError = errorMessage(error);
		issues.push({ severity: 'error', path: '', message: fatalError });
		const summary = this.makeSummary({
			startedAt,
			origin,
			mode,
			candidateCount: counters.candidateCount,
			processedCount: counters.processedCount,
			skippedCount: counters.skippedCount,
			processingFailureCount: counters.processingFailureCount,
			scanErrorCount: counters.scanErrorCount,
			warningCount: counters.warningCount,
			errorCount: Math.max(
				1,
				counters.processingFailureCount + counters.scanErrorCount,
			),
			message: fatalError,
			issues,
			status: 'failed',
		});
		await this.dependencies.saveRuntime({ ...runtime, lastRun: summary });
		this.dependencies.reportProgress({
			stage: 'failed',
			message: summary.message,
		});
		throw error;
	}

	private async processScan(
		scan: ScanResult,
		mode: PipelineMode,
		origin: RunOrigin,
		startedAt: Date,
		counters: RunCounters,
		issues: RunIssue[],
		options: { resumeOrphans: boolean; retryFailed: boolean },
	): Promise<PipelineRunResult> {
		const settings = this.dependencies.getSettings();
		const runtime = this.dependencies.getRuntime();
		let candidateCount = scan.candidates.length;
		let processedCount = 0;
		let skippedCount = 0;
		let processingFailureCount = 0;
		let scanErrorCount = scan.errors.length;
		let warningCount = scan.warnings.length;
		// Kept in sync so a fatal error thrown from this method still reports
		// accurate progress via the shared counters object.
		counters.candidateCount = candidateCount;
		counters.scanErrorCount = scanErrorCount;
		counters.warningCount = warningCount;
		this.dependencies.reportActivity?.({
			kind: 'pipeline',
			title: 'Source scan complete',
			message: `Found ${candidateCount.toString()} recording(s).`,
			stage: 'scanning',
		});
		for (const candidate of scan.candidates) {
			this.dependencies.reportActivity?.({
				kind: 'pipeline',
				title: 'Recording detected',
				message: `${candidate.relativePath} · ${candidate.size.toLocaleString()} bytes · ${formatLocalTimestamp(candidate.recordedAtMs)}`,
				fileName: candidate.fileName,
				stage: 'scanning',
			});
		}
		for (const warning of scan.warnings) {
			this.dependencies.reportActivity?.({
				kind: 'pipeline',
				level: 'warning',
				title: 'Scan warning',
				message: warning.message,
				fileName: warning.path,
				stage: 'scanning',
			});
		}
		for (const error of scan.errors) {
			this.dependencies.reportActivity?.({
				kind: 'pipeline',
				level: 'error',
				title: 'Scan error',
				message: error.message,
				fileName: error.path,
				stage: 'scanning',
			});
		}
		issues.push(
			...scan.errors.map((error) => ({
				severity: 'error' as const,
				path: error.path,
				message: error.message,
			})),
			...scan.warnings.map((warning) => ({
				severity: 'warning' as const,
				path: warning.path,
				message: warning.message,
			})),
		);

		if (mode === 'scan-only') {
			const errorCount = scanErrorCount;
			const summary = this.makeSummary({
				startedAt,
				origin,
				mode,
				candidateCount,
				processedCount,
				skippedCount,
				processingFailureCount,
				scanErrorCount,
				warningCount,
				errorCount,
				issues,
				message: `Found ${candidateCount.toString()} recording(s), ${scanErrorCount.toString()} scan error(s), ${warningCount.toString()} timestamp warning(s).`,
			});
			await this.dependencies.saveRuntime({ ...runtime, lastRun: summary });
			this.dependencies.reportProgress({
				stage: scanErrorCount === 0 ? 'complete' : 'failed',
				message: summary.message,
			});
			return { scan, summary };
		}
		const statesByFileName = new Map<string, RecordingState[]>();
		for (const state of Object.values(runtime.recordings)) {
			const bucket = statesByFileName.get(state.fileName) ?? [];
			bucket.push(state);
			statesByFileName.set(state.fileName, bucket);
		}
		const findStateByFingerprint = (
			target: AudioCandidate,
		): RecordingState | undefined =>
			statesByFileName
				.get(target.fileName)
				?.find(
					(state) =>
						state.size === target.size &&
						state.sourceModifiedAtMs === target.modifiedAtMs,
				);
		// Recordings already known to be finished are counted without touching
		// the services, so an offline STT server does not fail an idle run.
		const knownHashes = new Map<AudioCandidate, string>();
		const pending: AudioCandidate[] = [];
		for (const candidate of scan.candidates) {
			const known = findStateByFingerprint(candidate);
			if (
				known !== undefined &&
				(known.stage === 'complete' ||
					(known.stage === 'failed' && !options.retryFailed))
			) {
				skippedCount += 1;
			} else {
				pending.push(candidate);
			}
		}
		if (options.resumeOrphans) {
			const scannedPaths = new Set(
				scan.candidates.map((candidate) => candidate.absolutePath),
			);
			const orphans = resumableOrphans(runtime, scannedPaths);
			for (const orphan of orphans) {
				knownHashes.set(orphan.candidate, orphan.hash);
				pending.push(orphan.candidate);
			}
			if (orphans.length > 0) {
				candidateCount += orphans.length;
				counters.candidateCount = candidateCount;
				this.dependencies.reportActivity?.({
					kind: 'pipeline',
					title: 'Resuming unfinished recordings',
					message: `${orphans.length.toString()} recording(s) are no longer on the source but can be finished from the plugin cache.`,
					stage: 'scanning',
				});
			}
		}
		counters.skippedCount = skippedCount;

		let providers: ProviderHealthReport | undefined;
		if (pending.length > 0) {
			this.dependencies.reportProgress({
				stage: 'checking-services',
				message: 'Checking speech-to-text and coding-agent services…',
			});
			providers = await this.checkProviders();
			const unavailable = [
				providers.stt.ok
					? undefined
					: `Speech-to-text service unavailable: ${providers.stt.error ?? 'health check failed'}`,
				providers.agent.ok
					? undefined
					: `Coding agent unavailable: ${providers.agent.error ?? 'health check failed'}`,
			].filter((message): message is string => message !== undefined);
			if (unavailable.length > 0) {
				throw new Error(unavailable.join(' '));
			}
		}

		const groups = groupRecordingCandidates(pending, settings.recordingGrouping);
		let candidateIndex = skippedCount;
		let consecutiveGroupFailures = 0;
		for (const group of groups) {
			if (this.cancelRequested) {
				break;
			}
			const positions = new Map<AudioCandidate, number>();
			const inputs = group.map((candidate, groupIndex) => {
				const position = candidateIndex + groupIndex + 1;
				positions.set(candidate, position);
				const decorateProgress = (progress: PipelineProgress): void => {
					this.dependencies.reportProgress({
						...progress,
						current: position,
						total: candidateCount,
					});
				};
				return {
					candidate,
					settings,
					sttBaseUrl: effectiveSttBaseUrl(settings),
					sttApiKey: settings.sttApiKey,
					sttRequestFormat:
						settings.sttProvider === 'openrouter'
							? ('json-base64' as const)
							: undefined,
					splitLongRecordings: settings.sttSplitLongRecordings,
					ffmpegExecutable: settings.ffmpegExecutable,
					vaultRoot: this.dependencies.getVaultRoot(),
					artifactRoot: this.dependencies.getArtifactRoot(),
					findState: (hash: string) => runtime.recordings[hash],
					findStateByFingerprint,
					knownHash: knownHashes.get(candidate),
					retryFailed: options.retryFailed,
					// Mutates the live state so the fingerprint is persisted by the
					// end-of-run save instead of writing once per skipped recording.
					recordFingerprint: (state: RecordingState, target: AudioCandidate) => {
						state.size = target.size;
						state.sourceModifiedAtMs = target.modifiedAtMs;
						state.sourcePath = target.absolutePath;
						state.fileName = target.fileName;
					},
					saveState: async (state: RecordingState) => {
						runtime.recordings[state.hash] = state;
						await this.dependencies.saveRuntime(runtime);
					},
					reportProgress: decorateProgress,
					reportActivity: this.dependencies.reportActivity,
					isCancelled: () => this.cancelRequested,
				};
			});
			let groupFailed = false;
			try {
				const outcomes = await this.dependencies.processor.processBatch(inputs);
				groupFailed =
					outcomes.length > 0 &&
					outcomes.every((outcome) => outcome.result === 'failed');
				for (const outcome of outcomes) {
					if (outcome.result === 'skipped') {
						skippedCount += 1;
					} else if (outcome.result === 'processed') {
						processedCount += 1;
					} else {
						processingFailureCount += 1;
						const message = errorMessage(outcome.error);
						issues.push({
							severity: 'error',
							path: outcome.candidate.absolutePath,
							message,
						});
						this.dependencies.reportProgress({
							stage: 'failed',
							message,
							fileName: outcome.candidate.fileName,
							current: positions.get(outcome.candidate),
							total: candidateCount,
						});
					}
				}
			} catch (error) {
				if (this.cancelRequested) {
					break;
				}
				groupFailed = true;
				const message = errorMessage(error);
				for (const candidate of group) {
					processingFailureCount += 1;
					issues.push({
						severity: 'error',
						path: candidate.absolutePath,
						message,
					});
				}
				this.dependencies.reportProgress({
					stage: 'failed',
					message,
					current: candidateIndex + 1,
					total: candidateCount,
				});
			}
			candidateIndex += group.length;
			counters.processedCount = processedCount;
			counters.skippedCount = skippedCount;
			counters.processingFailureCount = processingFailureCount;
			// Keep going past a failed group so one bad recording cannot block
			// newer ones, but stop when failures look systemic.
			consecutiveGroupFailures = groupFailed ? consecutiveGroupFailures + 1 : 0;
			if (consecutiveGroupFailures >= MAX_CONSECUTIVE_GROUP_FAILURES) {
				issues.push({
					severity: 'error',
					path: '',
					message: `Stopped after ${MAX_CONSECUTIVE_GROUP_FAILURES.toString()} consecutive failed groups.`,
				});
				break;
			}
		}
		await this.pruneCache(runtime);

		if (this.cancelRequested) {
			const message = `Cancelled after processing ${processedCount.toString()} recording(s).`;
			const summary = this.makeSummary({
				startedAt,
				origin,
				mode,
				candidateCount,
				processedCount,
				skippedCount,
				processingFailureCount,
				scanErrorCount,
				warningCount,
				errorCount: processingFailureCount + scanErrorCount,
				issues,
				message,
				status: 'cancelled',
			});
			await this.dependencies.saveRuntime({ ...runtime, lastRun: summary });
			this.dependencies.reportProgress({
				stage: 'cancelled',
				message,
			});
			return { scan, providers, summary };
		}

		const failedCount = Object.values(runtime.recordings).filter(
			(state) => state.stage === 'failed',
		).length;
		const errorCount = processingFailureCount + scanErrorCount;
		const failedNote =
			failedCount === 0
				? ''
				: ` ${failedCount.toString()} recording(s) are marked as failed and are skipped until picked manually.`;
		const message = `Processed ${processedCount.toString()}, already complete ${skippedCount.toString()}, recording failures ${processingFailureCount.toString()}, scan errors ${scanErrorCount.toString()}, timestamp warnings ${warningCount.toString()}.${failedNote}`;
		const summary = this.makeSummary({
			startedAt,
			origin,
			mode,
			candidateCount,
			processedCount,
			skippedCount,
			processingFailureCount,
			scanErrorCount,
			warningCount,
			errorCount,
			issues,
			message,
		});
		await this.dependencies.saveRuntime({ ...runtime, lastRun: summary });
		this.dependencies.reportProgress({
			stage: errorCount === 0 ? 'complete' : 'failed',
			message,
			current: candidateCount,
			total: candidateCount,
		});
		return { scan, providers, summary };
	}

	private async pruneCache(runtime: RuntimeState): Promise<void> {
		const settings = this.dependencies.getSettings();
		// Anything unfinished may still need its archived audio or transcript.
		const protectedHashes = new Set(
			Object.values(runtime.recordings)
				.filter((state) => !isTerminal(state))
				.map((state) => state.hash),
		);
		try {
			const result = await pruneArtifactCache(
				this.dependencies.getArtifactRoot(),
				settings.artifactCacheMaxMb * 1024 * 1024,
				protectedHashes,
			);
			if (result.deletedDirectories.length > 0) {
				this.dependencies.reportActivity?.({
					kind: 'pipeline',
					level: 'info',
					title: 'Artifact cache pruned',
					message: `${result.deletedDirectories.length.toString()} old recording artifact(s) removed.`,
				});
			}
		} catch (error) {
			this.dependencies.reportActivity?.({
				kind: 'pipeline',
				level: 'warning',
				title: 'Artifact cache cleanup failed',
				message: errorMessage(error),
			});
		}
	}

	private makeSummary(input: {
		startedAt: Date;
		origin: RunOrigin;
		mode: PipelineMode;
		candidateCount: number;
		processedCount: number;
		skippedCount: number;
		processingFailureCount: number;
		scanErrorCount: number;
		warningCount: number;
		errorCount: number;
		message: string;
		issues: RunIssue[];
		status?: RunSummary['status'];
	}): RunSummary {
		return {
			startedAt: input.startedAt.toISOString(),
			finishedAt: new Date().toISOString(),
			origin: input.origin,
			mode: input.mode,
			status:
				input.status ?? (input.errorCount === 0 ? 'succeeded' : 'failed'),
			candidateCount: input.candidateCount,
			processedCount: input.processedCount,
			skippedCount: input.skippedCount,
			processingFailureCount: input.processingFailureCount,
			scanErrorCount: input.scanErrorCount,
			warningCount: input.warningCount,
			errorCount: input.errorCount,
			message: input.message,
			issues: input.issues.slice(-20),
		};
	}
}
