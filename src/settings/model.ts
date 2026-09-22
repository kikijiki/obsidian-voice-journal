import type {
	CodingAgentType,
	ConnectionProfile,
	PersistedPluginData,
	RecordingSource,
	RecordingStage,
	RecordingGrouping,
	RecordingTimestampSource,
	RuntimeState,
	StartupMode,
	VoiceJournalSettings,
} from '../model';
import { PLUGIN_DATA_SCHEMA_VERSION } from '../model';
import { DEFAULT_DJI_FILENAME_TIMESTAMP_REGEX } from '../ingest/recording-timestamp';

const DEFAULT_PROFILE: ConnectionProfile = {
	id: 'default',
	label: 'Configure speech-to-text',
	sttBaseUrl: '',
	sttApiKey: '',
	networkScope: 'unknown',
};

export const DEFAULT_SETTINGS: VoiceJournalSettings = {
	schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
	startupMode: 'off',
	startupDelayMs: 3000,
	activeConnectionProfileId: DEFAULT_PROFILE.id,
	connectionProfiles: [DEFAULT_PROFILE],
	recordingSources: [],
	recordingGrouping: 'day',
	journalDirectory: 'Journal',
	codingAgentType: 'pi',
	codingAgentExecutable: 'pi',
	codingAgentProfile: '',
	codingAgentModel: '',
	codingAgentThinkingEnabled: false,
	codingAgentTimeoutSeconds: 0,
	agentAddNewEntries: true,
	agentUpdateExistingEntries: true,
	additionalAgentInstructions: '',
	sttModel: '',
	artifactCacheMaxMb: 5_120,
	maxEntriesPerScan: 10_000,
};

export const DEFAULT_AGENT_EXECUTABLES: Record<CodingAgentType, string> = {
	pi: 'pi',
	claude: 'claude',
	codex: 'codex',
	cursor: 'cursor-agent',
};

export const DEFAULT_RUNTIME: RuntimeState = {
	lastRun: null,
	recordings: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
	return typeof value === 'string' ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

export function normalizeVaultRelativePath(value: string): string {
	const resolved: string[] = [];
	for (const segment of value.replaceAll('\\', '/').split('/')) {
		const trimmed = segment.trim();
		if (trimmed === '' || trimmed === '.') {
			continue;
		}
		if (trimmed === '..') {
			resolved.pop();
		} else {
			resolved.push(trimmed);
		}
	}
	return resolved.join('/');
}

function parseStartupMode(value: unknown): StartupMode {
	if (value === 'scan-only' || value === 'scan-and-process') {
		return value;
	}
	return 'off';
}

function parseCodingAgentType(value: unknown): CodingAgentType {
	if (
		value === 'claude' ||
		value === 'codex' ||
		value === 'cursor' ||
		value === 'pi'
	) {
		return value;
	}
	return DEFAULT_SETTINGS.codingAgentType;
}

function parseTimestampSource(value: unknown): RecordingTimestampSource {
	return value === 'filesystem' ? 'filesystem' : 'filename';
}

function parseRecordingGrouping(value: unknown): RecordingGrouping {
	return value === 'day' ||
		value === 'week' ||
		value === 'month' ||
		value === 'all'
		? value
		: value === 'none'
			? 'none'
			: DEFAULT_SETTINGS.recordingGrouping;
}

function parseProfiles(value: unknown): ConnectionProfile[] {
	if (!Array.isArray(value)) {
		return DEFAULT_SETTINGS.connectionProfiles.map((profile) => ({ ...profile }));
	}

	const profiles = value.flatMap((entry): ConnectionProfile[] => {
		if (!isRecord(entry)) {
			return [];
		}
		const id = readString(entry.id, '').trim();
		if (id === '') {
			return [];
		}
		const scope = entry.networkScope;
		return [
			{
				id,
				label: readString(entry.label, id),
				sttBaseUrl: readString(entry.sttBaseUrl, ''),
				sttApiKey: readString(entry.sttApiKey, ''),
				networkScope:
					scope === 'loopback' ||
					scope === 'private-network' ||
					scope === 'public-network'
						? scope
						: 'unknown',
			},
		];
	});

	return profiles.length > 0
		? profiles
		: DEFAULT_SETTINGS.connectionProfiles.map((profile) => ({ ...profile }));
}

function parseSources(value: unknown): RecordingSource[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.flatMap((entry): RecordingSource[] => {
		if (!isRecord(entry)) {
			return [];
		}
		const id = readString(entry.id, '').trim();
		const sourcePath = readString(entry.path, '').trim();
		if (id === '') {
			return [];
		}
		const extensions = Array.isArray(entry.extensions)
			? entry.extensions.filter(
					(extension): extension is string => typeof extension === 'string',
				)
			: ['.wav', '.mp3', '.m4a'];
		return [
			{
				id,
				name: readString(entry.name, id),
				path: sourcePath,
				recursive: readBoolean(entry.recursive, true),
				extensions,
				minimumAgeSeconds: Math.max(
					0,
					readNumber(entry.minimumAgeSeconds, 10),
				),
				timestampSource: parseTimestampSource(entry.timestampSource),
				filenameTimestampRegex: readString(
					entry.filenameTimestampRegex,
					DEFAULT_DJI_FILENAME_TIMESTAMP_REGEX,
				),
				timestampOffsetHours: readNumber(entry.timestampOffsetHours, 0),
			},
		];
	});
}

function parseLastRun(value: unknown): RuntimeState['lastRun'] {
	if (!isRecord(value)) {
		return null;
	}
	const origin = value.origin;
	const mode = value.mode;
	const status = value.status;
	if (
		(origin !== 'command' && origin !== 'ribbon' && origin !== 'startup') ||
		(mode !== 'scan-only' && mode !== 'scan-and-process') ||
		(status !== 'succeeded' && status !== 'failed' && status !== 'cancelled')
	) {
		return null;
	}
	return {
		startedAt: readString(value.startedAt, ''),
		finishedAt: readString(value.finishedAt, ''),
		origin,
		mode,
		status,
		candidateCount: Math.max(0, readNumber(value.candidateCount, 0)),
		processedCount: Math.max(0, readNumber(value.processedCount, 0)),
		skippedCount: Math.max(0, readNumber(value.skippedCount, 0)),
		processingFailureCount: Math.max(
			0,
			readNumber(value.processingFailureCount, 0),
		),
		scanErrorCount: Math.max(0, readNumber(value.scanErrorCount, 0)),
		warningCount: Math.max(0, readNumber(value.warningCount, 0)),
		errorCount: Math.max(0, readNumber(value.errorCount, 0)),
		message: readString(value.message, ''),
		issues: Array.isArray(value.issues)
			? value.issues.flatMap((issue) => {
					if (!isRecord(issue)) {
						return [];
					}
					return [
						{
							severity:
								issue.severity === 'warning' ? 'warning' : ('error' as const),
							path: readString(issue.path, ''),
							message: readString(issue.message, ''),
						},
					];
				})
			: [],
	};
}

function parseRecordingStage(value: unknown): RecordingStage | null {
	if (
		value === 'discovered' ||
		value === 'copied' ||
		value === 'transcribed' ||
		value === 'complete'
	) {
		return value;
	}
	return null;
}

function parseRecordings(value: unknown): RuntimeState['recordings'] {
	if (!isRecord(value)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(value).flatMap(([hash, entry]) => {
			if (!isRecord(entry)) {
				return [];
			}
			const stage = parseRecordingStage(entry.stage);
			if (stage === null || hash === '') {
				return [];
			}
			return [
				[
					hash,
					{
						hash,
						stage,
						sourcePath: readString(entry.sourcePath, ''),
						fileName: readString(entry.fileName, ''),
						archivedAudioPath:
							typeof entry.archivedAudioPath === 'string'
								? entry.archivedAudioPath
								: undefined,
						transcriptPath:
							typeof entry.transcriptPath === 'string'
								? entry.transcriptPath
								: undefined,
						rawResponsePath:
							typeof entry.rawResponsePath === 'string'
								? entry.rawResponsePath
								: undefined,
						attempts: Math.max(0, readNumber(entry.attempts, 0)),
						updatedAt: readString(entry.updatedAt, ''),
						lastError:
							typeof entry.lastError === 'string' ? entry.lastError : undefined,
					},
				],
			];
		}),
	);
}

export function parsePluginData(value: unknown): PersistedPluginData {
	const root = isRecord(value) ? value : {};
	const settingsValue = isRecord(root.settings) ? root.settings : {};
	const profiles = parseProfiles(settingsValue.connectionProfiles);
	const requestedActiveProfile = readString(
		settingsValue.activeConnectionProfileId,
		profiles[0]?.id ?? DEFAULT_PROFILE.id,
	);
	const activeProfileId = profiles.some(
		(profile) => profile.id === requestedActiveProfile,
	)
		? requestedActiveProfile
		: (profiles[0]?.id ?? DEFAULT_PROFILE.id);
	const codingAgentType = parseCodingAgentType(settingsValue.codingAgentType);
	const configuredExecutable = readString(
		settingsValue.codingAgentExecutable,
		DEFAULT_AGENT_EXECUTABLES[codingAgentType],
	);
	const configuredProfile = readString(
		settingsValue.codingAgentProfile,
		'',
	);
	const settings: VoiceJournalSettings = {
		schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
		startupMode: parseStartupMode(settingsValue.startupMode),
		startupDelayMs: Math.max(
			0,
			readNumber(settingsValue.startupDelayMs, DEFAULT_SETTINGS.startupDelayMs),
		),
		activeConnectionProfileId: activeProfileId,
		connectionProfiles: profiles,
		recordingSources: parseSources(settingsValue.recordingSources),
		recordingGrouping: parseRecordingGrouping(settingsValue.recordingGrouping),
		journalDirectory:
			normalizeVaultRelativePath(
				readString(
					settingsValue.journalDirectory,
					DEFAULT_SETTINGS.journalDirectory,
				),
			) || DEFAULT_SETTINGS.journalDirectory,
		codingAgentType,
		codingAgentExecutable: configuredExecutable,
		codingAgentProfile: configuredProfile,
		codingAgentModel: readString(
			settingsValue.codingAgentModel,
			DEFAULT_SETTINGS.codingAgentModel,
		),
		codingAgentThinkingEnabled: readBoolean(
			settingsValue.codingAgentThinkingEnabled,
			DEFAULT_SETTINGS.codingAgentThinkingEnabled,
		),
		codingAgentTimeoutSeconds: Math.max(
			0,
			Math.floor(
				readNumber(
					settingsValue.codingAgentTimeoutSeconds,
					DEFAULT_SETTINGS.codingAgentTimeoutSeconds,
				),
			),
		),
		agentAddNewEntries: readBoolean(
			settingsValue.agentAddNewEntries,
			DEFAULT_SETTINGS.agentAddNewEntries,
		),
		agentUpdateExistingEntries: readBoolean(
			settingsValue.agentUpdateExistingEntries,
			DEFAULT_SETTINGS.agentUpdateExistingEntries,
		),
		additionalAgentInstructions: readString(
			settingsValue.additionalAgentInstructions,
			DEFAULT_SETTINGS.additionalAgentInstructions,
		),
		sttModel: readString(settingsValue.sttModel, ''),
		artifactCacheMaxMb: Math.max(
			1,
			Math.floor(
				readNumber(
					settingsValue.artifactCacheMaxMb,
					DEFAULT_SETTINGS.artifactCacheMaxMb,
				),
			),
		),
		maxEntriesPerScan: Math.max(
			1,
			Math.floor(
				readNumber(
					settingsValue.maxEntriesPerScan,
					DEFAULT_SETTINGS.maxEntriesPerScan,
				),
			),
		),
	};

	const runtimeValue = isRecord(root.runtime) ? root.runtime : {};
	const lastRun = parseLastRun(runtimeValue.lastRun);
	const recordings = parseRecordings(runtimeValue.recordings);

	return {
		schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
		settings,
		runtime: { lastRun, recordings },
	};
}

export function getActiveProfile(
	settings: VoiceJournalSettings,
): ConnectionProfile | null {
	return (
		settings.connectionProfiles.find(
			(profile) => profile.id === settings.activeConnectionProfileId,
		) ?? null
	);
}
