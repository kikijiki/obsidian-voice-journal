import { FileSystemAdapter, Notice, Plugin, requestUrl } from 'obsidian';
import { CodingAgentClient, codingAgentName } from './agents/coding-agent';
import { registerCommands } from './commands/register';
import type {
	PersistedPluginData,
	PipelineMode,
	PipelineProgress,
	CodingAgentHealth,
	ProviderHealth,
	ProviderHealthReport,
	RunOrigin,
	RuntimeState,
	VoiceJournalSettings,
} from './model';
import { SourceScanner } from './ingest/source-scanner';
import { PipelineCoordinator } from './pipeline/coordinator';
import { RecordingProcessor } from './pipeline/recording-processor';
import { OpenAiCompatibleProvider } from './providers/openai-compatible';
import { OpenAiTranscriptionProvider } from './providers/openai-transcription';
import { parsePluginData } from './settings/model';
import { VoiceJournalSettingTab } from './settings/tab';
import { ActivityLog } from './activity/log';
import { revertVaultFileChange } from './changes/vault-changes';
import {
	initializeArtifactStorage,
	resolvePluginArtifactRoot,
} from './storage/artifact-root';
import {
	VOICE_JOURNAL_ACTIVITY_VIEW,
	VoiceJournalActivityView,
} from './views/activity-view';

interface AppWithSettings {
	setting: {
		open: () => void;
		openTabById: (id: string) => void;
	};
}

export default class VoiceJournalPlugin extends Plugin {
	settings!: VoiceJournalSettings;
	private runtime!: RuntimeState;
	private data!: PersistedPluginData;
	private coordinator!: PipelineCoordinator;
	private agent: CodingAgentClient | null = null;
	private statusBarItem!: HTMLElement;
	private progressNotice: Notice | null = null;
	private currentProgress: PipelineProgress | null = null;
	private readonly activity = new ActivityLog();

	async onload(): Promise<void> {
		this.data = parsePluginData(await this.loadData());
		this.settings = this.data.settings;
		this.runtime = this.data.runtime;
		await initializeArtifactStorage(this.getArtifactRoot());
		const agent = new CodingAgentClient();
		agent.setRunTimeoutMs(this.settings.codingAgentTimeoutSeconds * 1000);
		this.agent = agent;
		this.registerView(
			VOICE_JOURNAL_ACTIVITY_VIEW,
			(leaf) =>
				new VoiceJournalActivityView(leaf, {
					activity: this.activity,
					isRunning: () => this.coordinator.isRunning(),
					getProgress: () => this.currentProgress,
					runPipeline: async () =>
						this.executePipeline('scan-and-process', 'command'),
					cancelPipeline: () => this.cancelPipeline(),
					openSettings: () => this.openPluginSettings(),
					checkStt: async () => this.coordinator.checkStt(),
					checkCodingAgent: async () =>
						this.coordinator.checkCodingAgent(),
					revertFileChange: async (eventId, path) =>
						this.revertFileChange(eventId, path),
					revertAllFileChanges: async (eventId) =>
						this.revertAllFileChanges(eventId),
					openVaultFile: async (path) => this.openVaultFile(path),
					acceptChanges: async () => this.acceptChanges(),
				}),
		);
		this.coordinator = new PipelineCoordinator({
			getSettings: () => this.settings,
			getRuntime: () => this.runtime,
			getVaultRoot: () => this.getVaultRoot(),
			getArtifactRoot: () => this.getArtifactRoot(),
			saveRuntime: async (runtime) => this.saveRuntime(runtime),
			reportProgress: (progress) => this.reportProgress(progress),
			reportActivity: (event) => {
				this.activity.add(event);
			},
			scanner: new SourceScanner(),
			provider: new OpenAiCompatibleProvider(requestUrl),
			agent,
			processor: new RecordingProcessor(
				new OpenAiTranscriptionProvider(requestUrl),
				agent,
			),
		});

		this.statusBarItem = this.addStatusBarItem();
		this.registerDomEvent(this.statusBarItem, 'click', () => {
			void this.openActivityView();
		});
		this.updateStatusBar();
		this.addSettingTab(new VoiceJournalSettingTab(this.app, this, this));
		registerCommands(this, {
			runScan: async () => this.executePipeline('scan-only', 'command'),
			runPipeline: async () =>
				this.executePipeline('scan-and-process', 'command'),
			checkProviders: async () => this.checkProviders(),
			showStatus: async () => this.openActivityView(),
			cancelPipeline: () => this.cancelPipeline(),
			isRunning: () => this.coordinator.isRunning(),
		});
		this.addRibbonIcon('audio-lines', 'Process voice journal recordings', () => {
			void this.executePipeline('scan-and-process', 'ribbon');
		});

		this.app.workspace.onLayoutReady(() => this.scheduleStartupRun());
		try {
			await this.activity.clearStorage(this.getArtifactRoot());
		} catch (error) {
			console.error('Voice journal could not clear stale activity logs.', error);
		}
	}

	onunload(): void {
		this.coordinator?.cancel();
		this.agent?.dispose();
		this.agent = null;
		void this.activity.dispose();
	}

	async saveSettings(): Promise<void> {
		this.data.settings = this.settings;
		await this.saveData(this.data);
		this.agent?.setRunTimeoutMs(this.settings.codingAgentTimeoutSeconds * 1000);
	}

	private openPluginSettings(): void {
		const app = this.app as typeof this.app & AppWithSettings;
		app.setting.open();
		app.setting.openTabById(this.manifest.id);
		window.requestAnimationFrame(() => {
			app.setting.openTabById(this.manifest.id);
		});
	}

	async checkProviders(): Promise<void> {
		if (this.coordinator.isRunning()) {
			new Notice('A voice journal pipeline run is already active.');
			return;
		}
		const report = await this.coordinator.checkProviders();
		new Notice(this.formatProviderReport(report), 8000);
	}

	async checkStt(): Promise<void> {
		if (this.coordinator.isRunning()) {
			new Notice('A voice journal pipeline run is already active.');
			return;
		}
		const health = await this.coordinator.checkStt();
		new Notice(this.formatProviderHealth('STT', health), 8000);
	}

	async checkCodingAgent(): Promise<void> {
		if (this.coordinator.isRunning()) {
			new Notice('A voice journal pipeline run is already active.');
			return;
		}
		const health = await this.coordinator.checkCodingAgent();
		new Notice(this.formatCodingAgentHealth(health), 8000);
	}

	async listCodingAgentModels(): Promise<string[]> {
		if (this.coordinator.isRunning()) {
			throw new Error('Wait for the active voice journal run to finish.');
		}
		return await this.coordinator.listCodingAgentModels();
	}

	private scheduleStartupRun(): void {
		if (this.settings.startupMode === 'off') {
			return;
		}
		const mode: PipelineMode = this.settings.startupMode;
		const timeout = window.setTimeout(() => {
			void this.executePipeline(mode, 'startup');
		}, this.settings.startupDelayMs);
		this.register(() => window.clearTimeout(timeout));
	}

	private async executePipeline(
		mode: PipelineMode,
		origin: RunOrigin,
	): Promise<void> {
		if (this.coordinator.isRunning()) {
			new Notice('A voice journal pipeline run is already active.');
			await this.openActivityView();
			return;
		}
		await this.openActivityView();
		await this.activity.startRun(
			this.getArtifactRoot(),
			origin,
			mode,
		);
		this.progressNotice = new Notice('Voice journal: starting…', 0);
		this.statusBarItem.setText('Voice journal: starting…');
		try {
			const result = await this.coordinator.run(mode, origin);
			this.activity.add({
				kind: 'run',
				level:
					result.summary.status === 'succeeded'
						? 'success'
						: result.summary.status === 'cancelled'
							? 'warning'
							: 'error',
				title:
					result.summary.status === 'succeeded'
						? 'Run completed'
						: result.summary.status === 'cancelled'
							? 'Run cancelled'
							: 'Run completed with errors',
				message: result.summary.message,
				runSummary: result.summary,
			});
			new Notice(
				`Voice journal: ${result.summary.message}`,
				10_000,
			);
		} catch (error) {
			this.activity.add({
				kind: 'run',
				level: 'error',
				title: 'Run failed',
				message:
					error instanceof Error
						? error.message
						: 'Voice journal pipeline failed.',
			});
			new Notice(
				error instanceof Error ? error.message : 'Voice journal pipeline failed.',
				8000,
			);
		} finally {
			this.progressNotice?.hide();
			this.progressNotice = null;
			this.currentProgress = null;
			this.updateStatusBar();
			await this.activity.flush();
		}
	}

	private async saveRuntime(runtime: RuntimeState): Promise<void> {
		this.runtime = runtime;
		this.data.runtime = runtime;
		await this.saveData(this.data);
		this.updateStatusBar();
	}

	private reportProgress(progress: PipelineProgress): void {
		this.currentProgress = progress;
		this.activity.add({
			kind: 'pipeline',
			level:
				progress.stage === 'failed'
					? 'error'
					: progress.stage === 'cancelled'
						? 'warning'
						: progress.stage === 'complete'
							? 'success'
							: 'info',
			title: progress.message,
			fileName: progress.fileName,
			stage: progress.stage,
		});
		const position =
			progress.current !== undefined && progress.total !== undefined
				? ` (${progress.current.toString()}/${progress.total.toString()})`
				: '';
		const message = `Voice journal${position}: ${progress.message}`;
		this.statusBarItem.setText(message);
		this.progressNotice?.setMessage(message);
	}

	private updateStatusBar(): void {
		const lastRun = this.runtime.lastRun;
		this.statusBarItem.setText(
			this.currentProgress !== null
				? `Voice journal: ${this.currentProgress.message}`
				: lastRun === null
				? 'Voice journal: idle'
				: `Voice journal: ${lastRun.message}`,
		);
	}

	private getVaultRoot(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error('Voice journal requires a desktop filesystem vault.');
		}
		return adapter.getBasePath();
	}

	private getArtifactRoot(): string {
		return resolvePluginArtifactRoot(
			this.getVaultRoot(),
			this.app.vault.configDir,
			this.manifest.id,
		);
	}

	private cancelPipeline(): void {
		if (!this.coordinator.cancel()) {
			new Notice('No voice journal run is active.');
			return;
		}
		this.activity.add({
			kind: 'run',
			level: 'warning',
			title: 'Cancellation requested',
			message: 'Stopping the active operation safely…',
		});
	}

	private async revertFileChange(eventId: string, path: string): Promise<void> {
		const event = this.activity
			.getEvents()
			.find((candidate) => candidate.id === eventId);
		const changes = event?.changes;
		const change = changes?.find((candidate) => candidate.path === path);
		if (event === undefined || changes === undefined || change === undefined) {
			new Notice('That change report is no longer available.');
			return;
		}
		try {
			const reverted = await revertVaultFileChange(this.getVaultRoot(), change);
			this.activity.updateChanges(
				eventId,
				changes.map((candidate) =>
					candidate.path === path ? reverted : candidate,
				),
			);
			new Notice(`Reverted ${path}.`);
		} catch (error) {
			new Notice(
				error instanceof Error ? error.message : `Could not revert ${path}.`,
				8000,
			);
		}
	}

	private async revertAllFileChanges(eventId: string): Promise<void> {
		const event = this.activity
			.getEvents()
			.find((candidate) => candidate.id === eventId);
		if (event?.changes === undefined) {
			new Notice('That change report is no longer available.');
			return;
		}
		let changes = event.changes;
		let revertedCount = 0;
		const failures: string[] = [];
		for (const change of changes) {
			if (change.reverted === true) {
				continue;
			}
			try {
				const reverted = await revertVaultFileChange(
					this.getVaultRoot(),
					change,
				);
				changes = changes.map((candidate) =>
					candidate.path === change.path ? reverted : candidate,
				);
				this.activity.updateChanges(eventId, changes);
				revertedCount += 1;
			} catch (error) {
				failures.push(
					error instanceof Error ? error.message : `Could not revert ${change.path}.`,
				);
			}
		}
		new Notice(
			failures.length === 0
				? `Reverted ${revertedCount.toString()} file(s).`
				: `Reverted ${revertedCount.toString()} file(s); ${failures.length.toString()} failed. ${failures.join(' ')}`,
			8000,
		);
	}

	private async openVaultFile(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (file === null) {
			new Notice(`${path} no longer exists.`);
			return;
		}
		await this.app.workspace.getLeaf(false).openFile(file);
	}

	private async acceptChanges(): Promise<void> {
		if (this.coordinator.isRunning()) {
			new Notice('Wait for the voice journal run to finish.');
			return;
		}
		await this.activity.clearView();
		new Notice('Vault changes accepted.');
	}

	private async openActivityView(): Promise<void> {
		try {
			let leaf = this.app.workspace.getLeavesOfType(
				VOICE_JOURNAL_ACTIVITY_VIEW,
			)[0];
			if (leaf === undefined) {
				leaf =
					this.app.workspace.getRightLeaf(true) ??
					this.app.workspace.getLeaf(false);
				await leaf.setViewState({
					type: VOICE_JOURNAL_ACTIVITY_VIEW,
					active: true,
				});
			}
			await this.app.workspace.revealLeaf(leaf);
		} catch (error) {
			console.error(
				'Voice journal could not open the activity panel.',
				error,
			);
		}
	}

	private formatProviderReport(report: ProviderHealthReport): string {
		return `${this.formatCodingAgentHealth(report.agent)}\n${this.formatProviderHealth('STT', report.stt)}`;
	}

	private formatCodingAgentHealth(health: CodingAgentHealth): string {
		const name = codingAgentName(health.type);
		return health.ok
			? `${name}: ready${health.version ? ` (${health.version}, ${health.latencyMs.toString()} ms)` : ''}`
			: `${name}: unavailable (${health.error ?? 'unknown error'})`;
	}

	private formatProviderHealth(label: string, health: ProviderHealth): string {
		const models =
			health.models.length > 0 ? health.models.join(', ') : 'no models reported';
		return health.ok
			? `${label}: ready (${models}, ${health.latencyMs.toString()} ms)`
			: `${label}: unavailable (${health.error ?? 'unknown error'})`;
	}
}
