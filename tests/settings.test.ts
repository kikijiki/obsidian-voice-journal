import { describe, expect, it } from 'vitest';
import {
	normalizeVaultRelativePath,
	parsePluginData,
} from '../src/settings/model';

describe('normalizeVaultRelativePath', () => {
	it('strips absolute prefixes, separators, and parent traversal', () => {
		expect(normalizeVaultRelativePath('/Journal/')).toBe('Journal');
		expect(normalizeVaultRelativePath('Journal\\2026')).toBe('Journal/2026');
		expect(normalizeVaultRelativePath('../../etc')).toBe('etc');
		expect(normalizeVaultRelativePath('Journal/./Daily')).toBe('Journal/Daily');
	});
});

describe('parsePluginData', () => {
	it('provides generic provider-neutral defaults', () => {
		const data = parsePluginData(undefined);
		expect(data.settings.sttProvider).toBe('custom');
		expect(data.settings.sttBaseUrl).toBe('');
		expect(data.settings.sttApiKey).toBe('');
		expect(data.settings.sttSplitLongRecordings).toBe(true);
		expect(data.settings.ffmpegExecutable).toBe('ffmpeg');
		expect(data.settings.codingAgentType).toBe('pi');
		expect(data.settings.codingAgentExecutable).toBe('pi');
		expect(data.settings.codingAgentThinkingEnabled).toBe(false);
		expect(data.settings.codingAgentTimeoutSeconds).toBe(0);
		expect(data.settings.startupMode).toBe('off');
		expect(data.settings.recordingGrouping).toBe('day');
		expect(data.settings.agentAddNewEntries).toBe(true);
		expect(data.settings.agentUpdateExistingEntries).toBe(true);
		expect(data.settings.additionalAgentInstructions).toBe('');
		expect(data.settings.artifactCacheMaxMb).toBe(5_120);
		expect(data.settings.hideSourcesProperty).toBe(true);
		expect(data.settings.schemaVersion).toBe(1);
	});

	it('preserves an explicit choice to show the sources property', () => {
		const data = parsePluginData({ settings: { hideSourcesProperty: false } });
		expect(data.settings.hideSourcesProperty).toBe(false);
	});

	it('preserves disabled auxiliary-note permissions', () => {
		const data = parsePluginData({
			settings: {
				agentAddNewEntries: false,
				agentUpdateExistingEntries: false,
			},
		});
		expect(data.settings.agentAddNewEntries).toBe(false);
		expect(data.settings.agentUpdateExistingEntries).toBe(false);
	});

	it('preserves an explicit model-thinking opt in', () => {
		const data = parsePluginData({
			settings: { codingAgentThinkingEnabled: true },
		});
		expect(data.settings.codingAgentThinkingEnabled).toBe(true);
	});

	it('preserves an explicit recording grouping mode', () => {
		const data = parsePluginData({ settings: { recordingGrouping: 'week' } });
		expect(data.settings.recordingGrouping).toBe('week');
	});

	it('preserves an explicit flat speech-to-text configuration', () => {
		const data = parsePluginData({
			settings: {
				sttProvider: 'openrouter',
				sttBaseUrl: 'https://openrouter.ai/api/v1',
				sttApiKey: 'sk-or-secret',
				sttSplitLongRecordings: false,
				ffmpegExecutable: '/usr/local/bin/ffmpeg',
			},
		});
		expect(data.settings.sttProvider).toBe('openrouter');
		expect(data.settings.sttBaseUrl).toBe('https://openrouter.ai/api/v1');
		expect(data.settings.sttApiKey).toBe('sk-or-secret');
		expect(data.settings.sttSplitLongRecordings).toBe(false);
		expect(data.settings.ffmpegExecutable).toBe('/usr/local/bin/ffmpeg');
	});

	it('falls back to a custom speech-to-text provider for an unrecognized value', () => {
		const data = parsePluginData({
			settings: { sttProvider: 'not-a-real-provider' },
		});
		expect(data.settings.sttProvider).toBe('custom');
	});

	it('migrates a legacy multi-profile install by recovering the active profile', () => {
		const data = parsePluginData({
			settings: {
				activeConnectionProfileId: 'tailscale',
				connectionProfiles: [
					{
						id: 'localhost',
						label: 'Same-host speech-to-text',
						sttProvider: 'custom',
						sttBaseUrl: 'http://127.0.0.1:8001/v1',
						sttApiKey: '',
						networkScope: 'loopback',
					},
					{
						id: 'tailscale',
						label: 'Tailscale speech-to-text',
						sttProvider: 'openrouter',
						sttBaseUrl: 'https://openrouter.ai/api/v1',
						sttApiKey: 'sk-or-secret',
						networkScope: 'private-network',
					},
				],
			},
		});
		expect(data.settings.sttProvider).toBe('openrouter');
		expect(data.settings.sttBaseUrl).toBe('https://openrouter.ai/api/v1');
		expect(data.settings.sttApiKey).toBe('sk-or-secret');
		expect(data.settings.sttSplitLongRecordings).toBe(true);
	});

	it('migrates a legacy install with no explicit active profile by using the first one', () => {
		const data = parsePluginData({
			settings: {
				connectionProfiles: [
					{
						id: 'only',
						label: 'Only profile',
						sttBaseUrl: 'http://127.0.0.1:8001/v1',
						sttApiKey: 'legacy-secret',
					},
				],
			},
		});
		expect(data.settings.sttBaseUrl).toBe('http://127.0.0.1:8001/v1');
		expect(data.settings.sttApiKey).toBe('legacy-secret');
	});

	it('normalizes a persisted journal directory to a safe vault-relative path', () => {
		expect(
			parsePluginData({ settings: { journalDirectory: '/Journal/Daily' } })
				.settings.journalDirectory,
		).toBe('Journal/Daily');
		expect(
			parsePluginData({ settings: { journalDirectory: '../../outside' } })
				.settings.journalDirectory,
		).toBe('outside');
		expect(
			parsePluginData({ settings: { journalDirectory: '   ' } }).settings
				.journalDirectory,
		).toBe('Journal');
	});

	it('preserves an explicit coding-agent timeout and rejects negatives', () => {
		expect(
			parsePluginData({ settings: { codingAgentTimeoutSeconds: 90 } }).settings
				.codingAgentTimeoutSeconds,
		).toBe(90);
		expect(
			parsePluginData({ settings: { codingAgentTimeoutSeconds: -5 } }).settings
				.codingAgentTimeoutSeconds,
		).toBe(0);
	});

	it('uses the selected agent default executable', () => {
		const data = parsePluginData({ settings: { codingAgentType: 'cursor' } });
		expect(data.settings.codingAgentExecutable).toBe('cursor-agent');
	});

	it('preserves a draft source and lets the scanner validate its path', () => {
		const data = parsePluginData({
			settings: {
				recordingSources: [
					{
						id: 'dji',
						name: 'DJI',
						path: 'relative/path',
						extensions: ['wav'],
					},
				],
			},
		});
		expect(data.settings.recordingSources).toHaveLength(1);
		expect(data.settings.recordingSources[0]).toMatchObject({
			timestampSource: 'filename',
			timestampOffsetHours: 0,
		});
		expect(data.settings.recordingSources[0]?.filenameTimestampRegex).toContain(
			'?<year>',
		);
	});

	it('preserves an explicit filesystem timestamp strategy and offset', () => {
		const data = parsePluginData({
			settings: {
				recordingSources: [
					{
						id: 'generic',
						path: '/recordings',
						timestampSource: 'filesystem',
						timestampOffsetHours: -9,
					},
				],
			},
		});
		expect(data.settings.recordingSources[0]).toMatchObject({
			timestampSource: 'filesystem',
			timestampOffsetHours: -9,
		});
	});

	it('drops malformed persisted run state', () => {
		const data = parsePluginData({
			runtime: { lastRun: { status: 'invented' } },
		});
		expect(data.runtime.lastRun).toBeNull();
	});

});
