import type {
	AudioCandidate,
	CodingAgentHealth,
	ConnectionProfile,
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
import { getActiveProfile } from '../settings/model';
import { formatLocalTimestamp } from '../ingest/recording-timestamp';
import type {
	ProcessRecordingInput,
	ProcessRecordingOutcome,
} from './recording-processor';

interface Scanner {
	scan(
		sources: VoiceJournalSettings['recordingSources'],
		maxEntries: number,
	): Promise<ScanResult>;
}

interface HealthProvider {
	checkHealth(baseUrl: string, apiKey?: string): Promise<ProviderHealth>;
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

function requireActiveProfile(settings: VoiceJournalSettings): ConnectionProfile {
	const profile = getActiveProfile(settings);
	if (profile === null) {
		throw new Error('No active speech-to-text connection profile is configured.');
	}
	return profile;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown pipeline error.';
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
		const profile = requireActiveProfile(settings);
		return await this.dependencies.provider.checkHealth(
			profile.sttBaseUrl,
			profile.sttApiKey,
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
		const runtime = this.dependencies.getRuntime();
		let candidateCount = 0;
		let processedCount = 0;
		let skippedCount = 0;
		let processingFailureCount = 0;
		let scanErrorCount = 0;
		let warningCount = 0;
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
			candidateCount = scan.candidates.length;
			scanErrorCount = scan.errors.length;
			warningCount = scan.warnings.length;
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
			if (scanErrorCount > 0) {
				const message = `Stopped before processing because ${scanErrorCount.toString()} source scan error${scanErrorCount === 1 ? '' : 's'} occurred.`;
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
					errorCount: scanErrorCount,
					issues,
					message,
					status: 'failed',
				});
				await this.dependencies.saveRuntime({ ...runtime, lastRun: summary });
				this.dependencies.reportProgress({
					stage: 'failed',
					message,
				});
				return { scan, summary };
			}

			let providers: ProviderHealthReport | undefined;
			if (candidateCount > 0) {
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

			const profile = requireActiveProfile(settings);
			const groups = groupRecordingCandidates(
				scan.candidates,
				settings.recordingGrouping,
			);
			let candidateIndex = 0;
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
						sttBaseUrl: profile.sttBaseUrl,
						sttApiKey: profile.sttApiKey,
						vaultRoot: this.dependencies.getVaultRoot(),
						artifactRoot: this.dependencies.getArtifactRoot(),
						findState: (hash: string) => runtime.recordings[hash],
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
					for (const outcome of outcomes) {
						if (outcome.result === 'skipped') {
							skippedCount += 1;
						} else if (outcome.result === 'processed') {
							processedCount += 1;
						} else {
							groupFailed = true;
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
				if (groupFailed) {
					break;
				}
			}

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

			const errorCount = processingFailureCount + scanErrorCount;
			const message = `Processed ${processedCount.toString()}, already complete ${skippedCount.toString()}, recording failures ${processingFailureCount.toString()}, scan errors ${scanErrorCount.toString()}, timestamp warnings ${warningCount.toString()}.`;
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
		} catch (error) {
			const fatalError = errorMessage(error);
			issues.push({ severity: 'error', path: '', message: fatalError });
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
				errorCount: Math.max(
					1,
					processingFailureCount + scanErrorCount,
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
		} finally {
			this.running = false;
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
