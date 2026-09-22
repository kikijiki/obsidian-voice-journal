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
		expect(data.settings.activeConnectionProfileId).toBe('default');
		expect(data.settings.connectionProfiles[0]?.sttBaseUrl).toBe('');
		expect(data.settings.codingAgentType).toBe('pi');
		expect(data.settings.codingAgentExecutable).toBe('pi');
		expect(data.settings.codingAgentThinkingEnabled).toBe(false);
		expect(data.settings.codingAgentTimeoutSeconds).toBe(0);
		expect(data.settings.connectionProfiles[0]?.sttApiKey).toBe('');
		expect(data.settings.startupMode).toBe('off');
		expect(data.settings.recordingGrouping).toBe('day');
		expect(data.settings.agentAddNewEntries).toBe(true);
		expect(data.settings.agentUpdateExistingEntries).toBe(true);
		expect(data.settings.additionalAgentInstructions).toBe('');
		expect(data.settings.artifactCacheMaxMb).toBe(5_120);
		expect(data.settings.schemaVersion).toBe(1);
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

	it('preserves an explicit Tailscale profile as active', () => {
		const data = parsePluginData({
			settings: {
				activeConnectionProfileId: 'tailscale',
				connectionProfiles: [
					{
						id: 'tailscale',
						label: 'Tailscale',
						sttBaseUrl: 'http://example.ts.net:8001/v1',
						sttApiKey: 'secret-token',
						networkScope: 'private-network',
					},
				],
			},
		});
		expect(data.settings.activeConnectionProfileId).toBe('tailscale');
		expect(data.settings.connectionProfiles[0]?.networkScope).toBe(
			'private-network',
		);
		expect(data.settings.connectionProfiles[0]?.sttApiKey).toBe('secret-token');
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
