import { ItemView, Modal, Setting, setIcon } from 'obsidian';
import type { App, WorkspaceLeaf } from 'obsidian';
import { codingAgentName } from '../agents/coding-agent';
import type { ActivityEvent, ActivityKind, ActivityLog } from '../activity/log';
import type {
	CodingAgentHealth,
	PipelineProgress,
	ProviderHealth,
} from '../model';
import {
	classifyDiffLine,
	type VaultFileChange,
} from '../changes/vault-changes';

export const VOICE_JOURNAL_ACTIVITY_VIEW = 'voice-journal-activity';

type ActivityFilter = 'all' | Exclude<ActivityKind, 'run' | 'changes'>;

export interface ActivityViewHost {
	activity: ActivityLog;
	isRunning: () => boolean;
	getProgress: () => PipelineProgress | null;
	runPipeline: () => Promise<void>;
	cancelPipeline: () => void;
	openSettings: () => void;
	checkStt: () => Promise<ProviderHealth>;
	checkCodingAgent: () => Promise<CodingAgentHealth>;
	revertFileChange: (eventId: string, path: string) => Promise<void>;
	revertAllFileChanges: (eventId: string) => Promise<void>;
	openVaultFile: (path: string) => Promise<void>;
	acceptChanges: () => Promise<void>;
}

type ServiceHealthState = 'checking' | 'ready' | 'unavailable';

interface ServiceIndicator {
	containerEl: HTMLElement;
	labelEl: HTMLElement;
}

function displayTime(timestamp: string): string {
	const date = new Date(timestamp);
	return Number.isNaN(date.valueOf())
		? timestamp
		: date.toLocaleTimeString([], {
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit',
			});
}

function filterLabel(filter: ActivityFilter): string {
	return {
		all: 'All',
		pipeline: 'Pipeline',
		transcript: 'Transcripts',
		agent: 'Agent output',
	}[filter];
}

class RevertConfirmationModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly heading: string,
		private readonly message: string,
		private readonly settle: (confirmed: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		this.contentEl.createEl('p', { text: this.message });
		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText('Cancel').onClick(() => this.finish(false)),
			)
			.addButton((button) =>
				button
					.setButtonText('Revert')
					.setDestructive()
					.setCta()
					.onClick(() => this.finish(true)),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.settle(false);
		}
	}

	private finish(confirmed: boolean): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.settle(confirmed);
		this.close();
	}
}

export class VoiceJournalActivityView extends ItemView {
	private filter: ActivityFilter = 'all';
	private events: readonly ActivityEvent[] = [];
	private feedEl: HTMLElement | null = null;
	private changeReportsEl: HTMLElement | null = null;
	private failureReportEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private runButton: HTMLButtonElement | null = null;
	private sttIndicator: ServiceIndicator | null = null;
	private agentIndicator: ServiceIndicator | null = null;
	private healthCheckPending = false;
	private healthCheckGeneration = 0;
	private unsubscribe: (() => void) | null = null;
	private pinnedToBottom = true;
	private readonly expandedDetails = new Set<string>();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: ActivityViewHost,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VOICE_JOURNAL_ACTIVITY_VIEW;
	}

	getDisplayText(): string {
		return 'Voice journal activity';
	}

	getIcon(): string {
		return 'audio-lines';
	}

	async onOpen(): Promise<void> {
		this.renderShell();
		this.unsubscribe = this.host.activity.subscribe((events) => {
			this.events = events;
			this.renderStatus();
			this.renderFailureReport();
			this.renderChangeReports();
			this.renderFeed();
		});
		this.registerInterval(
			window.setInterval(() => this.renderStatus(), 1_000),
		);
		this.registerInterval(
			window.setInterval(() => {
				void this.refreshServiceHealth();
			}, 60_000),
		);
		void this.refreshServiceHealth();
	}

	async onClose(): Promise<void> {
		this.healthCheckGeneration += 1;
		this.healthCheckPending = false;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.sttIndicator = null;
		this.agentIndicator = null;
		this.failureReportEl = null;
	}

	private renderShell(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('voice-journal-activity');

		const header = root.createDiv({ cls: 'voice-journal-activity__header' });
		const heading = header.createDiv();
		heading.createEl('h2', { text: 'Voice journal' });
		this.statusEl = heading.createDiv({
			cls: 'voice-journal-activity__status',
		});

		const actions = header.createDiv({ cls: 'voice-journal-activity__actions' });
		this.runButton = actions.createEl('button', {
			cls: 'voice-journal-activity__run-action',
			attr: { 'aria-label': 'Process new recordings' },
		});
		this.runButton.addEventListener('click', () => {
			if (this.host.isRunning()) {
				this.host.cancelPipeline();
			} else {
				void this.host.runPipeline();
			}
		});
		const clearButton = actions.createEl('button', {
			attr: { 'aria-label': 'Clear the visible activity' },
		});
		setIcon(clearButton, 'list-x');
		clearButton.addEventListener('click', () => {
			void this.host.activity.clearView();
		});
		const settingsButton = actions.createEl('button', {
			attr: { 'aria-label': 'Open voice journal settings' },
		});
		setIcon(settingsButton, 'settings');
		settingsButton.addEventListener('click', () => this.host.openSettings());

		const services = root.createDiv({
			cls: 'voice-journal-activity__services',
			attr: {
				'aria-live': 'polite',
				role: 'status',
			},
		});
		this.sttIndicator = this.createServiceIndicator(services, 'STT');
		this.agentIndicator = this.createServiceIndicator(services, 'Agent');

		this.failureReportEl = root.createDiv({
			cls: 'voice-journal-activity__failure-highlight',
			attr: {
				'aria-live': 'assertive',
				role: 'alert',
			},
		});
		this.failureReportEl.hidden = true;

		this.changeReportsEl = root.createDiv({
			cls: 'voice-journal-activity__changes-highlight',
		});
		this.changeReportsEl.hidden = true;

		const filters = root.createDiv({ cls: 'voice-journal-activity__filters' });
		for (const filter of ['all', 'pipeline', 'transcript', 'agent'] as const) {
			const button = filters.createEl('button', {
				text: filterLabel(filter),
				cls: 'voice-journal-activity__filter',
			});
			button.toggleClass('is-active', this.filter === filter);
			button.addEventListener('click', () => {
				this.filter = filter;
				for (const candidate of Array.from(
					filters.querySelectorAll('button'),
				)) {
					candidate.toggleClass('is-active', candidate === button);
				}
				this.renderFeed();
			});
		}

		this.feedEl = root.createDiv({ cls: 'voice-journal-activity__feed' });
		this.feedEl.addEventListener(
			'scroll',
			() => {
				const feed = this.feedEl;
				if (feed !== null) {
					this.pinnedToBottom =
						feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 32;
				}
			},
			{ passive: true },
		);
		this.renderStatus();
		this.renderFailureReport();
		this.renderChangeReports();
		this.renderFeed();
	}

	private renderFailureReport(): void {
		const container = this.failureReportEl;
		if (container === null) {
			return;
		}
		const failure = [...this.events].reverse().find(
			(event) => event.kind === 'run' && event.level === 'error',
		);
		container.empty();
		container.hidden = failure === undefined;
		if (failure === undefined) {
			return;
		}

		const header = container.createDiv({
			cls: 'voice-journal-activity__failure-header',
		});
		const icon = header.createSpan({
			cls: 'voice-journal-activity__failure-icon',
		});
		setIcon(icon, 'circle-x');
		const heading = header.createDiv({
			cls: 'voice-journal-activity__failure-heading',
		});
		heading.createEl('h3', { text: failure.title });
		if (failure.message !== undefined) {
			heading.createDiv({
				cls: 'voice-journal-activity__failure-message',
				text: failure.message,
			});
		}
		header.createEl('time', {
			text: displayTime(failure.timestamp),
			attr: { datetime: failure.timestamp },
		});

		const summary = failure.runSummary;
		if (summary !== undefined) {
			const counts = container.createDiv({
				cls: 'voice-journal-activity__failure-counts',
			});
			this.renderFailureCount(counts, summary.candidateCount, 'found');
			this.renderFailureCount(counts, summary.processedCount, 'processed');
			this.renderFailureCount(counts, summary.skippedCount, 'already complete');
			this.renderFailureCount(
				counts,
				summary.processingFailureCount + summary.scanErrorCount,
				'failed',
				true,
			);
			this.renderFailureCount(counts, summary.warningCount, 'warnings');

			if (summary.issues.length > 0) {
				const issues = container.createDiv({
					cls: 'voice-journal-activity__failure-issues',
				});
				for (const issue of summary.issues) {
					const row = issues.createDiv({
						cls: `voice-journal-activity__failure-issue is-${issue.severity}`,
					});
					const issueIcon = row.createSpan();
					setIcon(
						issueIcon,
						issue.severity === 'error' ? 'circle-x' : 'triangle-alert',
					);
					const body = row.createDiv({
						cls: 'voice-journal-activity__failure-issue-body',
					});
					body.createDiv({
						cls: 'voice-journal-activity__failure-issue-file',
						text: this.fileNameFromPath(issue.path),
						attr: { title: issue.path },
					});
					body.createDiv({
						cls: 'voice-journal-activity__failure-issue-message',
						text: issue.message,
					});
				}
			}
		}

		container.createDiv({
			cls: 'voice-journal-activity__failure-guidance',
			text: 'Processing stopped. Fix the issue and run again; completed transcription work will be reused.',
		});
	}

	private renderFailureCount(
		parent: HTMLElement,
		count: number,
		label: string,
		error = false,
	): void {
		parent.createSpan({
			cls: `voice-journal-activity__failure-count${error ? ' is-error' : ''}`,
			text: `${count.toString()} ${label}`,
		});
	}

	private fileNameFromPath(path: string): string {
		return path.replaceAll('\\', '/').split('/').at(-1) ?? path;
	}

	private createServiceIndicator(
		parent: HTMLElement,
		label: string,
	): ServiceIndicator {
		const containerEl = parent.createDiv({
			cls: 'voice-journal-activity__service is-checking',
			attr: {
				'aria-label': `${label} availability has not been checked yet.`,
			},
		});
		containerEl.createSpan({ cls: 'voice-journal-activity__service-dot' });
		const labelEl = containerEl.createSpan({ text: label });
		return { containerEl, labelEl };
	}

	private updateServiceIndicator(
		indicator: ServiceIndicator | null,
		state: ServiceHealthState,
		label: string,
		tooltip: string,
	): void {
		if (indicator === null) {
			return;
		}
		indicator.labelEl.setText(label);
		indicator.containerEl.removeClass(
			'is-checking',
			'is-ready',
			'is-unavailable',
		);
		indicator.containerEl.addClass(`is-${state}`);
		indicator.containerEl.setAttribute('aria-label', tooltip);
	}

	private async refreshServiceHealth(): Promise<void> {
		if (this.healthCheckPending || this.host.isRunning()) {
			return;
		}
		this.healthCheckPending = true;
		const generation = ++this.healthCheckGeneration;
		this.updateServiceIndicator(
			this.sttIndicator,
			'checking',
			'STT',
			'Checking speech-to-text availability…',
		);
		this.updateServiceIndicator(
			this.agentIndicator,
			'checking',
			'Agent',
			'Checking coding-agent availability…',
		);

		const [sttResult, agentResult] = await Promise.allSettled([
			this.host.checkStt(),
			this.host.checkCodingAgent(),
		]);
		if (generation !== this.healthCheckGeneration) {
			return;
		}

		if (sttResult.status === 'fulfilled') {
			const health = sttResult.value;
			const models =
				health.models.length > 0
					? health.models.join(', ')
					: 'No models reported';
			this.updateServiceIndicator(
				this.sttIndicator,
				health.ok ? 'ready' : 'unavailable',
				'STT',
				health.ok
					? `STT available · ${health.latencyMs.toString()} ms · ${models} · ${health.baseUrl}`
					: `STT unavailable · ${health.error ?? 'Unknown error'} · ${health.baseUrl}`,
			);
		} else {
			this.updateServiceIndicator(
				this.sttIndicator,
				'unavailable',
				'STT',
				`STT availability check failed · ${this.errorMessage(sttResult.reason)}`,
			);
		}

		if (agentResult.status === 'fulfilled') {
			const health = agentResult.value;
			const name = codingAgentName(health.type);
			const details = [
				health.version,
				`${health.latencyMs.toString()} ms`,
			].filter((value): value is string => value !== undefined);
			this.updateServiceIndicator(
				this.agentIndicator,
				health.ok ? 'ready' : 'unavailable',
				name,
				health.ok
					? `${name} available · ${details.join(' · ')}`
					: `${name} unavailable · ${health.error ?? 'Unknown error'}`,
			);
		} else {
			this.updateServiceIndicator(
				this.agentIndicator,
				'unavailable',
				'Agent',
				`Coding-agent availability check failed · ${this.errorMessage(agentResult.reason)}`,
			);
		}
		this.healthCheckPending = false;
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : 'Unknown error';
	}

	private renderStatus(): void {
		if (this.statusEl === null) {
			return;
		}
		const running = this.host.isRunning();
		const progress = this.host.getProgress();
		const latest = this.events.at(-1);
		let text = 'Idle';
		if (running) {
			const position =
				progress?.current !== undefined && progress.total !== undefined
					? `${progress.current.toString()}/${progress.total.toString()} · `
					: '';
			const quietSeconds =
				latest === undefined
					? 0
					: Math.max(
							0,
							Math.floor(
								(Date.now() - new Date(latest.timestamp).valueOf()) / 1000,
							),
						);
			text = `${position}${progress?.message ?? 'Running'} · last output ${quietSeconds.toString()}s ago`;
		} else if (latest !== undefined) {
			text = `${latest.title} · ${displayTime(latest.timestamp)}`;
		}
		this.statusEl.setText(text);
		this.statusEl.toggleClass('is-running', running);
		if (this.runButton !== null) {
			setIcon(this.runButton, running ? 'square' : 'play');
			this.runButton.setAttribute(
				'aria-label',
				running ? 'Stop the active run' : 'Process new recordings',
			);
			this.runButton.toggleClass('is-stop', running);
		}
	}

	private renderChangeReports(): void {
		const container = this.changeReportsEl;
		if (container === null) {
			return;
		}
		const reports = this.events.filter((event) => event.kind === 'changes');
		container.empty();
		container.hidden = reports.length === 0;
		if (reports.length === 0) {
			return;
		}
		const header = container.createDiv({
			cls: 'voice-journal-activity__changes-highlight-header',
		});
		const icon = header.createSpan();
		setIcon(icon, 'files');
		header.createEl('h3', { text: 'Vault changes' });
		const changedCount = reports.reduce(
			(total, report) => total + (report.changes?.length ?? 0),
			0,
		);
		header.createSpan({
			cls: 'voice-journal-activity__changes-count',
			text: `${changedCount.toString()} file change${changedCount === 1 ? '' : 's'}`,
		});
		const accept = header.createEl('button', {
			cls: 'voice-journal-activity__accept-changes mod-cta',
			text: 'Accept changes',
			attr: { 'aria-label': 'Accept vault changes and clear this activity' },
		});
		accept.disabled = this.host.isRunning();
		accept.addEventListener('click', () => {
			void this.acceptReportedChanges();
		});
		for (const report of reports) {
			const card = container.createDiv({
				cls: 'voice-journal-activity__change-card',
			});
			this.renderChangeReport(card, report);
		}
	}

	private renderFeed(): void {
		const feed = this.feedEl;
		if (feed === null) {
			return;
		}
		feed.empty();
		const visible = this.events.filter(
			(event) =>
				event.kind !== 'changes' &&
				!(event.kind === 'run' && event.level === 'error') &&
				(this.filter === 'all' ||
					event.kind === this.filter ||
					(this.filter === 'pipeline' && event.kind === 'run')),
		);
		if (visible.length === 0) {
			feed.createDiv({
				cls: 'voice-journal-activity__empty',
				text: 'No activity to show yet.',
			});
			return;
		}

		for (const event of visible) {
			this.renderEvent(feed, event);
		}
		if (this.pinnedToBottom) {
			window.requestAnimationFrame(() => {
				feed.scrollTop = feed.scrollHeight;
			});
		}
	}

	private renderEvent(parent: HTMLElement, event: ActivityEvent): void {
		const row = parent.createDiv({
			cls: `voice-journal-activity__event is-${event.kind} is-${event.level}`,
		});
		if (event.kind === 'agent') {
			this.renderAgentEvent(row, event);
			return;
		}
		this.renderCompactEvent(row, event);
	}

	private renderChangeReport(parent: HTMLElement, event: ActivityEvent): void {
		parent.addClass('voice-journal-activity__change-report');
		const changes = event.changes ?? [];
		const pending = changes.filter((change) => change.reverted !== true);
		const header = parent.createDiv({
			cls: 'voice-journal-activity__agent-summary',
		});
		const icon = header.createSpan({
			cls: 'voice-journal-activity__agent-icon',
		});
		setIcon(icon, 'files');
		const heading = header.createDiv({
			cls: 'voice-journal-activity__agent-heading',
		});
		heading.createSpan({
			cls: 'voice-journal-activity__agent-title',
			text: event.title,
		});
		if (event.message !== undefined) {
			heading.createSpan({
				cls: 'voice-journal-activity__event-summary-text',
				text: event.message,
			});
		}
		const trailing = header.createDiv({
			cls: 'voice-journal-activity__agent-trailing',
		});
		const revertAll = trailing.createEl('button', {
			cls: 'voice-journal-activity__revert-all',
			text: 'Revert all',
			attr: { 'aria-label': 'Revert all changes in this report' },
		});
		revertAll.disabled = pending.length === 0;
		revertAll.addEventListener('click', () => {
			void this.confirmRevert(
				'Revert all vault changes?',
				`This will restore ${pending.length.toString()} file${pending.length === 1 ? '' : 's'} to their state before this agent run.`,
			).then(async (confirmed) => {
				if (confirmed) {
					await this.host.revertAllFileChanges(event.id);
				}
			});
		});
		trailing.createEl('time', {
			text: displayTime(event.timestamp),
			attr: { datetime: event.timestamp },
		});
		this.renderStatusSlot(trailing);

		const list = parent.createDiv({
			cls: 'voice-journal-activity__change-list',
		});
		for (const change of changes) {
			this.renderFileChange(list, event.id, change);
		}
	}

	private renderFileChange(
		parent: HTMLElement,
		eventId: string,
		change: VaultFileChange,
	): void {
		const detailId = `${eventId}:${change.path}`;
		const row = parent.createDiv({
			cls: `voice-journal-activity__change is-${change.kind}${change.reverted === true ? ' is-reverted' : ''}`,
		});
		const summary = row.createDiv({
			cls: 'voice-journal-activity__change-summary',
		});
		const icon = summary.createSpan({
			cls: 'voice-journal-activity__agent-icon',
		});
		setIcon(
			icon,
			change.reverted === true
				? 'undo-2'
				: change.kind === 'created'
					? 'file-plus-2'
					: change.kind === 'deleted'
						? 'file-x-2'
						: 'file-pen-line',
		);
		summary.createSpan({
			cls: 'voice-journal-activity__change-path',
			text: change.path,
		});
		summary.createSpan({
			cls: 'voice-journal-activity__change-kind',
			text: change.reverted === true ? 'reverted' : change.kind,
		});
		const actions = summary.createDiv({
			cls: 'voice-journal-activity__change-actions',
		});
		if (change.kind !== 'deleted') {
			const open = actions.createEl('button', {
				cls: 'voice-journal-activity__change-action',
				attr: { 'aria-label': `Open ${change.path}` },
			});
			setIcon(open, 'external-link');
			open.disabled = change.kind === 'created' && change.reverted === true;
			open.addEventListener('click', (clickEvent) => {
				clickEvent.stopPropagation();
				void this.host.openVaultFile(change.path);
			});
		}
		const revert = actions.createEl('button', {
			cls: 'voice-journal-activity__change-action',
			attr: { 'aria-label': `Revert ${change.path}` },
		});
		setIcon(revert, 'undo-2');
		revert.disabled = change.reverted === true;
		revert.addEventListener('click', (clickEvent) => {
			clickEvent.stopPropagation();
			void this.confirmRevert(
				'Revert this file?',
				`Restore ${change.path} to its state before this agent run?`,
			).then(async (confirmed) => {
				if (confirmed) {
					await this.host.revertFileChange(eventId, change.path);
				}
			});
		});
		if (change.kind === 'modified') {
			const details = row.createEl('pre', {
				cls: 'voice-journal-activity__change-diff',
			});
			const code = details.createEl('code');
			for (const line of change.diff.split('\n')) {
				code.createSpan({
					cls: `voice-journal-activity__diff-line is-${classifyDiffLine(line)}`,
					text: line,
				});
			}
			details.hidden = !this.expandedDetails.has(detailId);
			this.makeExpandable(summary, detailId, details);
		}
	}

	private async confirmRevert(
		heading: string,
		message: string,
	): Promise<boolean> {
		return await new Promise((resolve) => {
			new RevertConfirmationModal(this.app, heading, message, resolve).open();
		});
	}

	private async acceptReportedChanges(): Promise<void> {
		await this.host.acceptChanges();
		this.expandedDetails.clear();
	}

	private renderCompactEvent(parent: HTMLElement, event: ActivityEvent): void {
		const summary = parent.createDiv({
			cls: 'voice-journal-activity__agent-summary',
		});
		const icon = summary.createSpan({
			cls: 'voice-journal-activity__agent-icon',
		});
		setIcon(icon, this.eventIcon(event));
		const content = summary.createDiv({
			cls: 'voice-journal-activity__agent-heading',
		});
		content.createSpan({
			cls: 'voice-journal-activity__agent-title',
			text: event.title,
		});
		const message = this.compactEventMessage(event);
		if (message !== '') {
			content.createSpan({
				cls: 'voice-journal-activity__event-summary-text',
				text: message,
			});
		}
		const trailing = summary.createDiv({
			cls: 'voice-journal-activity__agent-trailing',
		});
		trailing.createEl('time', {
			text: displayTime(event.timestamp),
			attr: { datetime: event.timestamp },
		});
		this.renderStatusSlot(trailing);
		if (event.detail !== undefined && event.detail !== '') {
			const detailsContent = parent.createEl('pre', {
				cls: 'voice-journal-activity__agent-detail-content',
				text: event.detail,
			});
			detailsContent.hidden = !this.expandedDetails.has(event.id);
			this.makeExpandable(parent, event.id, detailsContent);
		}
	}

	private compactEventMessage(event: ActivityEvent): string {
		const fileName = event.fileName?.trim() ?? '';
		const message = event.message?.trim() ?? '';
		if (fileName === '' || message.includes(fileName)) {
			return message || fileName;
		}
		return message === '' ? fileName : `${fileName} · ${message}`;
	}

	private eventIcon(event: ActivityEvent): string {
		if (event.level === 'error') {
			return 'circle-x';
		}
		if (event.level === 'warning') {
			return 'triangle-alert';
		}
		if (event.level === 'success') {
			return 'circle-check';
		}
		if (event.kind === 'run') {
			return 'play';
		}
		if (event.kind === 'transcript') {
			return 'text';
		}
		switch (event.stage) {
			case 'scanning':
				return 'search';
			case 'checking-services':
				return 'radio-tower';
			case 'stabilizing':
				return 'hourglass';
			case 'hashing':
				return 'fingerprint';
			case 'copying':
				return 'copy';
			case 'transcribing':
				return 'audio-lines';
			case 'editing-vault':
				return 'bot';
			case 'complete':
				return 'circle-check';
			case 'cancelled':
				return 'circle-stop';
			case 'failed':
				return 'circle-x';
			default:
				return 'activity';
		}
	}

	private renderAgentEvent(parent: HTMLElement, event: ActivityEvent): void {
		const presentation = event.presentation ?? 'event';
		parent.addClass(`is-agent-${presentation}`);
		const summary = parent.createDiv({
			cls: 'voice-journal-activity__agent-summary',
		});
		const icon = summary.createSpan({
			cls: 'voice-journal-activity__agent-icon',
		});
		setIcon(icon, event.icon ?? 'bot');
		const content = summary.createDiv({
			cls: 'voice-journal-activity__agent-heading',
		});
		content.createSpan({
			cls: 'voice-journal-activity__agent-title',
			text: event.title,
		});
		if (
			presentation === 'tool' &&
			event.message !== undefined &&
			event.message !== ''
		) {
			content.createSpan({
				cls: 'voice-journal-activity__agent-target',
				text: event.message,
			});
		}
		const trailing = summary.createDiv({
			cls: 'voice-journal-activity__agent-trailing',
		});
		const hasDetails = event.detail !== undefined && event.detail !== '';
		const detailsAreReadable =
			hasDetails &&
			!(
				event.presentation === undefined &&
				event.detail?.trimStart().startsWith('{') === true
			);
		trailing.createEl('time', {
			text: displayTime(event.timestamp),
			attr: { datetime: event.timestamp },
		});
		this.renderStatusSlot(trailing, event.status);

		const displayMessage = event.message?.trimEnd() ?? '';
		if (
			presentation !== 'tool' &&
			displayMessage !== ''
		) {
			parent.createDiv({
				cls: 'voice-journal-activity__agent-message',
				text: displayMessage,
			});
		}
		if (detailsAreReadable) {
			const detailsContent = parent.createEl('pre', {
				cls: 'voice-journal-activity__agent-detail-content',
				text: event.detail,
			});
			detailsContent.hidden = !this.expandedDetails.has(event.id);
			this.makeExpandable(parent, event.id, detailsContent);
		}
	}

	private renderStatusSlot(
		parent: HTMLElement,
		status?: ActivityEvent['status'],
	): void {
		const statusIcon = parent.createSpan({
			cls: `voice-journal-activity__agent-status${status === undefined ? ' is-placeholder' : ` is-${status}`}`,
			attr:
				status === undefined
					? { 'aria-hidden': 'true' }
					: { 'aria-label': status },
		});
		if (status !== undefined) {
			setIcon(
				statusIcon,
				{
					running: 'loader-circle',
					succeeded: 'circle-check',
					warning: 'triangle-alert',
					failed: 'circle-x',
					interrupted: 'circle-stop',
				}[status],
			);
		}
	}

	private makeExpandable(
		target: HTMLElement,
		eventId: string,
		details: HTMLElement,
	): void {
		target.addClass('is-expandable');
		target.tabIndex = 0;
		target.setAttribute('role', 'button');
		target.setAttribute(
			'aria-expanded',
			this.expandedDetails.has(eventId) ? 'true' : 'false',
		);
		const toggle = (): void => {
			const expanded = !this.expandedDetails.has(eventId);
			if (expanded) {
				this.expandedDetails.add(eventId);
			} else {
				this.expandedDetails.delete(eventId);
			}
			target.setAttribute('aria-expanded', expanded.toString());
			details.hidden = !expanded;
		};
		target.addEventListener('click', (event) => {
			const clicked = event.target;
			if (!(clicked instanceof Element) || clicked.closest('button') === null) {
				toggle();
			}
		});
		target.addEventListener('keydown', (event) => {
			if (
				event.target === target &&
				(event.key === 'Enter' || event.key === ' ')
			) {
				event.preventDefault();
				toggle();
			}
		});
	}

}
