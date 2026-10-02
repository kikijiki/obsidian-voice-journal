import {
	FileSystemAdapter,
	Notice,
	Plugin,
	requestUrl,
} from 'obsidian';
import { CodingAgentClient, codingAgentName } from './agents/coding-agent';
import { registerCommands } from './commands/register';
import type {
	PersistedPluginData,
	PipelineMode,
	PipelineProgress,
	PipelineRunResult,
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
import {
	compareVaultSnapshots,
	effectiveBaselineSnapshot,
	revertVaultFileChange,
	snapshotVaultNotes,
} from './changes/vault-changes';
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

// The STT key lives in Obsidian's secret storage instead of data.json, which
// is often synced or committed with the vault.
const STT_API_KEY_SECRET_ID = 'kikijiki-voice-journal-stt-api-key';

export default class VoiceJournalPlugin extends Plugin {
	settings!: VoiceJournalSettings;
	private runtime!: RuntimeState;
	private data!: PersistedPluginData;
	private coordinator!: PipelineCoordinator;
	private processor!: RecordingProcessor;
	private agent: CodingAgentClient | null = null;
	/**
	 * Set synchronously when a pipeline run is requested, before any await, so
	 * two quick triggers cannot both pass the busy check.
	 */
	private runActive = false;
	private followUpRunning = false;
	private revertRunning = false;
	/** Notes edited in an Obsidian editor while the agent was running. */
	private readonly editedDuringAgent = new Set<string>();
	private statusBarItem!: HTMLElement;
	private progressNotice: Notice | null = null;
	private currentProgress: PipelineProgress | null = null;
	private readonly activity = new ActivityLog();

	async onload(): Promise<void> {
		const loaded: unknown = await this.loadData();
		this.data = parsePluginData(loaded);
		this.settings = this.data.settings;
		this.runtime = this.data.runtime;
		await this.loadSttApiKey(loaded);
		this.registerEvent(
			this.app.workspace.on('editor-change', (_editor, info) => {
				if ((this.runActive || this.followUpRunning) && info.file !== null) {
					this.editedDuringAgent.add(info.file.path);
				}
			}),
		);
		await initializeArtifactStorage(this.getArtifactRoot());
		try {
			await this.activity.clearStorage(this.getArtifactRoot());
		} catch (error) {
			console.error('Voice journal could not clear stale activity logs.', error);
		}
		const agent = new CodingAgentClient();
		agent.setRunTimeoutMs(this.settings.codingAgentTimeoutSeconds * 1000);
		this.agent = agent;
		this.processor = new RecordingProcessor(
			new OpenAiTranscriptionProvider(requestUrl),
			agent,
		);
		this.registerView(
			VOICE_JOURNAL_ACTIVITY_VIEW,
			(leaf) =>
				new VoiceJournalActivityView(leaf, {
					activity: this.activity,
					isRunning: () => this.runActive || this.coordinator.isRunning(),
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
					getRecordingSources: () => this.settings.recordingSources,
					processFiles: async (paths) => this.processFiles(paths),
					sendFollowUpMessage: async (message) =>
						this.sendFollowUpMessage(message),
					isFollowUpRunning: () => this.followUpRunning,
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
			processor: this.processor,
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
			isRunning: () => this.runActive || this.coordinator.isRunning(),
		});
		this.addRibbonIcon('audio-lines', 'Process voice journal recordings', () => {
			void this.executePipeline('scan-and-process', 'ribbon');
		});

		this.app.workspace.onLayoutReady(() => this.scheduleStartupRun());
	}

	onunload(): void {
		this.coordinator?.cancel();
		this.agent?.dispose();
		this.agent = null;
		void this.activity.dispose();
	}

	async saveSettings(): Promise<void> {
		this.data.settings = this.settings;
		await this.persistData();
		this.agent?.setRunTimeoutMs(this.settings.codingAgentTimeoutSeconds * 1000);
	}

	/** Reads the key from secret storage, migrating a key left in data.json. */
	private async loadSttApiKey(loaded: unknown): Promise<void> {
		const storage = this.app.secretStorage;
		const legacyKey = this.settings.sttApiKey;
		const storedKey = storage.getSecret(STT_API_KEY_SECRET_ID);
		if (legacyKey !== '') {
			if (storedKey === null || storedKey === '') {
				storage.setSecret(STT_API_KEY_SECRET_ID, legacyKey);
			}
			if (loaded !== null && loaded !== undefined) {
				await this.persistData();
			}
		}
		this.settings.sttApiKey =
			storage.getSecret(STT_API_KEY_SECRET_ID) ?? legacyKey;
	}

	private async persistData(): Promise<void> {
		const storage = this.app.secretStorage;
		if ((storage.getSecret(STT_API_KEY_SECRET_ID) ?? '') !== this.settings.sttApiKey) {
			storage.setSecret(STT_API_KEY_SECRET_ID, this.settings.sttApiKey);
		}
		await this.saveData({
			...this.data,
			settings: { ...this.data.settings, sttApiKey: '' },
		});
	}

	/** One lock for everything that runs the agent or writes to the vault. */
	private isBusy(): boolean {
		return (
			this.runActive ||
			this.coordinator.isRunning() ||
			this.followUpRunning ||
			this.revertRunning
		);
	}

	/** Warns about notes the user edited while the agent was also writing. */
	private reportEditsDuringAgent(): void {
		if (this.editedDuringAgent.size === 0) {
			return;
		}
		const changed = new Set(
			this.activity
				.getEvents()
				.flatMap((event) => event.changes ?? [])
				.map((change) => change.path),
		);
		const overlapping = [...this.editedDuringAgent].filter((path) =>
			changed.has(path),
		);
		this.editedDuringAgent.clear();
		if (overlapping.length === 0) {
			return;
		}
		this.activity.add({
			kind: 'pipeline',
			level: 'warning',
			title: 'Notes edited during the agent run',
			message: `You edited ${overlapping.join(', ')} while the agent was running. The change report includes your edits, and reverting would discard them.`,
		});
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
		if (this.isBusy()) {
			new Notice('A voice journal pipeline run is already active.');
			return;
		}
		const report = await this.coordinator.checkProviders();
		new Notice(this.formatProviderReport(report), 8000);
	}

	async checkStt(): Promise<void> {
		if (this.isBusy()) {
			new Notice('A voice journal pipeline run is already active.');
			return;
		}
		const health = await this.coordinator.checkStt();
		new Notice(this.formatProviderHealth('STT', health), 8000);
	}

	async checkCodingAgent(): Promise<void> {
		if (this.isBusy()) {
			new Notice('A voice journal pipeline run is already active.');
			return;
		}
		const health = await this.coordinator.checkCodingAgent();
		new Notice(this.formatCodingAgentHealth(health), 8000);
	}

	async listCodingAgentModels(): Promise<string[]> {
		if (this.isBusy()) {
			throw new Error('Wait for the active voice journal run to finish.');
		}
		return await this.coordinator.listCodingAgentModels();
	}

	async listSttModels(): Promise<string[]> {
		if (this.coordinator.isRunning()) {
			throw new Error('Wait for the active voice journal run to finish.');
		}
		return await this.coordinator.listSttModels();
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
		await this.executeRun(mode, origin, () =>
			this.coordinator.run(mode, origin),
		);
	}

	private async processFiles(absolutePaths: string[]): Promise<void> {
		if (absolutePaths.length === 0) {
			return;
		}
		await this.executeRun('scan-and-process', 'manual', () =>
			this.coordinator.runManual(absolutePaths, 'manual'),
		);
	}

	private async executeRun(
		mode: PipelineMode,
		origin: RunOrigin,
		run: () => Promise<PipelineRunResult>,
	): Promise<void> {
		if (this.isBusy()) {
			new Notice('A voice journal run or follow-up is already active.');
			await this.openActivityView();
			return;
		}
		this.runActive = true;
		this.editedDuringAgent.clear();
		try {
			await this.openActivityView();
			await this.activity.startRun(
				this.getArtifactRoot(),
				origin,
				mode,
			);
		} catch (error) {
			this.runActive = false;
			throw error;
		}
		this.progressNotice = new Notice('Voice journal: starting…', 0);
		this.statusBarItem.setText('Voice journal: starting…');
		try {
			const result = await run();
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
			this.runActive = false;
			this.reportEditsDuringAgent();
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
		await this.persistData();
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
		if (this.followUpRunning) {
			this.processor.cancel();
			this.activity.add({
				kind: 'run',
				level: 'warning',
				title: 'Cancellation requested',
				message: 'Stopping the follow-up…',
			});
			return;
		}
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
		if (this.isBusy()) {
			new Notice('Wait for the voice journal run to finish before reverting.');
			return;
		}
		this.revertRunning = true;
		try {
			await this.revertFileChangeUnlocked(eventId, path);
		} finally {
			this.revertRunning = false;
		}
	}

	private async revertFileChangeUnlocked(
		eventId: string,
		path: string,
	): Promise<void> {
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
			const reverted = await revertVaultFileChange(
				this.getVaultRoot(),
				change,
				this.app.vault,
			);
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
		if (this.isBusy()) {
			new Notice('Wait for the voice journal run to finish before reverting.');
			return;
		}
		this.revertRunning = true;
		try {
			await this.revertAllFileChangesUnlocked(eventId);
		} finally {
			this.revertRunning = false;
		}
	}

	private async revertAllFileChangesUnlocked(eventId: string): Promise<void> {
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
					this.app.vault,
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
		if (this.isBusy()) {
			new Notice('Wait for the voice journal run to finish.');
			return;
		}
		await this.activity.clearView();
		new Notice('Vault changes accepted.');
	}

	private async sendFollowUpMessage(message: string): Promise<void> {
		const trimmed = message.trim();
		if (trimmed === '') {
			return;
		}
		if (this.isBusy()) {
			new Notice('Wait for the voice journal run to finish.');
			return;
		}
		const reportEvents = this.activity
			.getEvents()
			.filter((event) => event.kind === 'changes' && (event.changes?.length ?? 0) > 0);
		if (reportEvents.length === 0) {
			new Notice('There are no pending vault changes to follow up on.');
			return;
		}
		const priorChanges = reportEvents.flatMap((event) => event.changes ?? []);
		const changedPaths = [...new Set(priorChanges.map((change) => change.path))];
		this.followUpRunning = true;
		this.editedDuringAgent.clear();
		const vaultRoot = this.getVaultRoot();
		const artifactRoot = this.getArtifactRoot();
		const progressNotice = new Notice('Voice journal: sending follow-up…', 0);
		try {
			const preSnapshot = await snapshotVaultNotes(vaultRoot, artifactRoot);
			const { agentFailure, snapshotAfter } = await this.processor.runFollowUp({
				settings: this.settings,
				vaultRoot,
				artifactRoot,
				changedPaths,
				followUpMessage: trimmed,
				reportActivity: (event) => this.activity.add(event),
				reportProgress: (progress) => this.reportProgress(progress),
				reuseSnapshot: preSnapshot,
			});
			if (agentFailure !== undefined) {
				throw agentFailure instanceof Error
					? agentFailure
					: new Error('The coding agent failed to apply the follow-up.');
			}
			const baseline = effectiveBaselineSnapshot(preSnapshot.snapshot, priorChanges);
			const changes = compareVaultSnapshots(baseline, snapshotAfter.snapshot);
			const [primary, ...superseded] = reportEvents;
			if (primary !== undefined) {
				this.activity.updateChanges(primary.id, changes);
			}
			for (const event of superseded) {
				this.activity.updateChanges(event.id, []);
			}
			new Notice(
				changes.length > 0
					? `Follow-up applied: ${changes.length.toString()} file(s) changed.`
					: 'Follow-up applied: no file changes detected.',
			);
		} catch (error) {
			new Notice(
				error instanceof Error ? error.message : 'The follow-up request failed.',
				8000,
			);
		} finally {
			progressNotice.hide();
			this.currentProgress = null;
			this.updateStatusBar();
			this.followUpRunning = false;
			this.reportEditsDuringAgent();
		}
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
