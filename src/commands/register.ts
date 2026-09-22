import { Plugin } from 'obsidian';

export interface VoiceJournalActions {
	runScan: () => Promise<void>;
	runPipeline: () => Promise<void>;
	checkProviders: () => Promise<void>;
	showStatus: () => Promise<void>;
	cancelPipeline: () => void;
	isRunning: () => boolean;
}

export function registerCommands(
	plugin: Plugin,
	actions: VoiceJournalActions,
): void {
	plugin.addCommand({
		id: 'scan-recordings',
		name: 'Scan recording sources',
		callback: actions.runScan,
	});
	plugin.addCommand({
		id: 'run-pipeline',
		name: 'Process new voice recordings',
		callback: actions.runPipeline,
	});
	plugin.addCommand({
		id: 'check-providers',
		name: 'Check inference providers',
		callback: actions.checkProviders,
	});
	plugin.addCommand({
		id: 'show-status',
		name: 'Open activity panel',
		callback: actions.showStatus,
	});
	plugin.addCommand({
		id: 'cancel-pipeline',
		name: 'Cancel active run',
		checkCallback: (checking) => {
			if (!actions.isRunning()) {
				return false;
			}
			if (!checking) {
				actions.cancelPipeline();
			}
			return true;
		},
	});
}
