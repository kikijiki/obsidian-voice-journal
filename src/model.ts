export const PLUGIN_DATA_SCHEMA_VERSION = 1;

export type StartupMode = 'off' | 'scan-only' | 'scan-and-process';
export type CodingAgentType = 'pi' | 'claude' | 'codex';
export type SttProviderType = 'custom' | 'openrouter';
export type PipelineMode = 'scan-only' | 'scan-and-process';
export type RunOrigin = 'command' | 'ribbon' | 'startup' | 'manual';
export type RecordingTimestampSource = 'filename' | 'filesystem';
export type RecordingGrouping = 'none' | 'day' | 'week' | 'month' | 'all';

export interface RecordingSource {
	id: string;
	name: string;
	path: string;
	recursive: boolean;
	extensions: string[];
	minimumAgeSeconds: number;
	timestampSource: RecordingTimestampSource;
	filenameTimestampRegex: string;
	timestampOffsetHours: number;
}

export interface VoiceJournalSettings {
	schemaVersion: number;
	startupMode: StartupMode;
	startupDelayMs: number;
	sttProvider: SttProviderType;
	sttBaseUrl: string;
	sttApiKey: string;
	sttModel: string;
	sttSplitLongRecordings: boolean;
	ffmpegExecutable: string;
	recordingSources: RecordingSource[];
	recordingGrouping: RecordingGrouping;
	journalDirectory: string;
	codingAgentType: CodingAgentType;
	codingAgentExecutable: string;
	codingAgentModel: string;
	codingAgentThinkingEnabled: boolean;
	codingAgentTimeoutSeconds: number;
	agentAddNewEntries: boolean;
	agentUpdateExistingEntries: boolean;
	additionalAgentInstructions: string;
	artifactCacheMaxMb: number;
	maxEntriesPerScan: number;
}

export interface RunSummary {
	startedAt: string;
	finishedAt: string;
	origin: RunOrigin;
	mode: PipelineMode;
	status: 'succeeded' | 'failed' | 'cancelled';
	candidateCount: number;
	processedCount: number;
	skippedCount: number;
	processingFailureCount: number;
	scanErrorCount: number;
	warningCount: number;
	errorCount: number;
	message: string;
	issues: RunIssue[];
}

export interface RunIssue {
	severity: 'warning' | 'error';
	path: string;
	message: string;
}

/**
 * `complete` and `failed` are terminal: scheduled runs never pick those
 * recordings up again. A manual pick from the activity panel retries `failed`.
 */
export type RecordingStage =
	| 'discovered'
	| 'copied'
	| 'transcribed'
	| 'complete'
	| 'failed';

export interface RecordingState {
	hash: string;
	stage: RecordingStage;
	sourcePath: string;
	fileName: string;
	size?: number;
	sourceModifiedAtMs?: number;
	recordedAtMs?: number;
	archivedAudioPath?: string;
	transcriptPath?: string;
	rawResponsePath?: string;
	attempts: number;
	updatedAt: string;
	lastError?: string;
	/** Set before the agent runs, cleared on success; a resumed run warns the agent about possible partial edits. */
	agentStartedAt?: string;
	completedAt?: string;
	/** Provenance: vault-relative notes the agent changed while processing this recording. */
	notePaths?: string[];
}

export interface RuntimeState {
	lastRun: RunSummary | null;
	recordings: Record<string, RecordingState>;
}

export interface PersistedPluginData {
	schemaVersion: number;
	settings: VoiceJournalSettings;
	runtime: RuntimeState;
}

export interface AudioCandidate {
	sourceId: string;
	absolutePath: string;
	relativePath: string;
	fileName: string;
	size: number;
	modifiedAtMs: number;
	recordedAtMs: number;
}

export interface SourceScanError {
	sourceId: string;
	path: string;
	message: string;
}

export interface SourceScanWarning {
	sourceId: string;
	path: string;
	message: string;
}

export interface ScanResult {
	candidates: AudioCandidate[];
	errors: SourceScanError[];
	warnings: SourceScanWarning[];
}

export interface ProviderHealth {
	baseUrl: string;
	ok: boolean;
	latencyMs: number;
	models: string[];
	error?: string;
}

export interface ProviderHealthReport {
	agent: CodingAgentHealth;
	stt: ProviderHealth;
}

export interface CodingAgentHealth {
	type: CodingAgentType;
	ok: boolean;
	latencyMs: number;
	version?: string;
	modelAvailable?: boolean;
	error?: string;
}

export interface PipelineRunResult {
	scan: ScanResult;
	providers?: ProviderHealthReport;
	summary: RunSummary;
}

export type PipelineProgressStage =
	| 'scanning'
	| 'checking-services'
	| 'stabilizing'
	| 'hashing'
	| 'copying'
	| 'transcribing'
	| 'editing-vault'
	| 'complete'
	| 'cancelled'
	| 'failed';

export interface PipelineProgress {
	stage: PipelineProgressStage;
	message: string;
	current?: number;
	total?: number;
	fileName?: string;
}
