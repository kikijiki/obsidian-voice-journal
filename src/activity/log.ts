import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
	PipelineMode,
	PipelineProgressStage,
	RunSummary,
	RunOrigin,
} from '../model';
import type { VaultFileChange } from '../changes/vault-changes';

export type ActivityKind =
	| 'run'
	| 'pipeline'
	| 'transcript'
	| 'agent'
	| 'changes';
export type ActivityLevel = 'info' | 'warning' | 'error' | 'success';
export type AgentEventPresentation = 'message' | 'thinking' | 'tool' | 'event';
export type ActivityStatus =
	| 'running'
	| 'succeeded'
	| 'warning'
	| 'failed'
	| 'interrupted';

export interface ActivityEvent {
	id: string;
	runId: string;
	sequence: number;
	timestamp: string;
	kind: ActivityKind;
	level: ActivityLevel;
	title: string;
	message?: string;
	detail?: string;
	fileName?: string;
	stage?: PipelineProgressStage;
	stream?: 'stdout' | 'stderr';
	presentation?: AgentEventPresentation;
	icon?: string;
	status?: ActivityStatus;
	replaceKey?: string;
	changes?: VaultFileChange[];
	runSummary?: RunSummary;
}

export interface NewActivityEvent {
	kind: ActivityKind;
	level?: ActivityLevel;
	title: string;
	message?: string;
	detail?: string;
	fileName?: string;
	stage?: PipelineProgressStage;
	stream?: 'stdout' | 'stderr';
	presentation?: AgentEventPresentation;
	icon?: string;
	status?: ActivityStatus;
	/** Update an existing in-memory row instead of appending another row. */
	replaceKey?: string;
	changes?: VaultFileChange[];
	/** Structured final state used by the prominent run report. */
	runSummary?: RunSummary;
	/** Transient stream updates stay in the UI until a final snapshot arrives. */
	persist?: boolean;
}

export type ActivityListener = (events: readonly ActivityEvent[]) => void;

const MAX_IN_MEMORY_EVENTS = 2_000;

function createRunId(now: Date): string {
	const timestamp = now.toISOString().replace(/[-:.]/gu, '');
	return `${timestamp}-${randomUUID()}`;
}

/** Session-only activity log with a bounded in-memory feed and one temporary JSONL file. */
export class ActivityLog {
	private events: ActivityEvent[] = [];
	private listeners = new Set<ActivityListener>();
	private runId: string | null = null;
	private sequence = 0;
	private outputPath: string | null = null;
	private runsDirectory: string | null = null;
	/** False after the view was cleared mid-run; the next write recreates it. */
	private runsDirectoryReady = false;
	private writeQueue: Promise<void> = Promise.resolve();

	getEvents(): readonly ActivityEvent[] {
		return this.events;
	}

	getRunId(): string | null {
		return this.runId;
	}

	subscribe(listener: ActivityListener): () => void {
		this.listeners.add(listener);
		listener(this.events);
		return () => this.listeners.delete(listener);
	}

	async startRun(
		artifactRoot: string,
		origin: RunOrigin,
		mode: PipelineMode,
	): Promise<string> {
		await this.writeQueue;
		const runsDirectory = join(artifactRoot, 'runs');
		await rm(runsDirectory, { recursive: true, force: true });
		await mkdir(runsDirectory, { recursive: true, mode: 0o700 });
		this.runId = createRunId(new Date());
		this.sequence = 0;
		this.events = [];
		this.outputPath = join(runsDirectory, `${this.runId}.jsonl`);
		this.runsDirectory = runsDirectory;
		this.runsDirectoryReady = true;
		this.notify();
		this.add({
			kind: 'run',
			title: mode === 'scan-only' ? 'Scan started' : 'Processing started',
			message: `Started from ${origin}.`,
		});
		return this.runId;
	}

	add(input: NewActivityEvent): ActivityEvent | null {
		if (this.runId === null) {
			return null;
		}
		const existingIndex =
			input.replaceKey === undefined
				? -1
				: this.events.findLastIndex(
						(event) =>
							event.runId === this.runId &&
							event.replaceKey === input.replaceKey,
					);
		const existing =
			existingIndex === -1 ? undefined : this.events[existingIndex];
		const event: ActivityEvent = {
			id:
				existing?.id ??
				`${this.runId}:${(this.sequence + 1).toString()}`,
			runId: this.runId,
			sequence: existing?.sequence ?? ++this.sequence,
			timestamp: new Date().toISOString(),
			kind: input.kind,
			level: input.level ?? existing?.level ?? 'info',
			title: input.title,
			message: input.message,
			detail: input.detail,
			fileName: input.fileName,
			stage: input.stage,
			stream: input.stream,
			presentation: input.presentation,
			icon: input.icon,
			status: input.status,
			replaceKey: input.replaceKey,
			changes: input.changes,
			runSummary: input.runSummary,
		};
		// Mutate in place: streamed agent output replaces rows many times per
		// second, and copying the whole feed on each token is wasteful. Consumers
		// compare individual event objects (each update is a new object).
		if (existingIndex === -1) {
			this.events.push(event);
			this.evictOverflow();
		} else {
			this.events[existingIndex] = event;
		}
		this.notify();
		if (this.outputPath !== null && input.persist !== false) {
			this.persist(this.outputPath, event);
		}
		return event;
	}

	updateChanges(eventId: string, changes: VaultFileChange[]): ActivityEvent | null {
		const index = this.events.findIndex((event) => event.id === eventId);
		const existing = this.events[index];
		if (index < 0 || existing === undefined || existing.kind !== 'changes') {
			return null;
		}
		const event: ActivityEvent = {
			...existing,
			changes,
			message: this.changeSummary(changes),
		};
		this.events[index] = event;
		this.notify();
		return event;
	}

	/**
	 * Clears the visible feed and deletes the persisted JSONL. The current run
	 * (if any) keeps its id, so events added afterwards — e.g. while a run is
	 * still active — are still logged to a freshly created file.
	 */
	async clearView(): Promise<void> {
		this.events = [];
		this.notify();
		const runsDirectory = this.runsDirectory;
		if (runsDirectory === null) {
			await this.writeQueue;
			return;
		}
		this.runsDirectoryReady = false;
		this.writeQueue = this.writeQueue
			.then(async () => rm(runsDirectory, { recursive: true, force: true }))
			.catch((error: unknown) => {
				console.error('Voice journal could not delete the activity log.', error);
			});
		await this.writeQueue;
	}

	async clearStorage(artifactRoot: string): Promise<void> {
		await this.writeQueue;
		this.outputPath = null;
		this.runsDirectory = null;
		this.runId = null;
		this.sequence = 0;
		this.events = [];
		this.notify();
		await rm(join(artifactRoot, 'runs'), { recursive: true, force: true });
	}

	async dispose(): Promise<void> {
		const runsDirectory = this.runsDirectory;
		this.outputPath = null;
		this.runsDirectory = null;
		this.runId = null;
		this.events = [];
		this.listeners.clear();
		await this.writeQueue;
		if (runsDirectory !== null) {
			await rm(runsDirectory, { recursive: true, force: true });
		}
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	private persist(outputPath: string, event: ActivityEvent): void {
		const line = `${JSON.stringify(event)}\n`;
		const runsDirectory = this.runsDirectory;
		const recreateDirectory = !this.runsDirectoryReady && runsDirectory !== null;
		this.runsDirectoryReady = true;
		this.writeQueue = this.writeQueue
			.then(async () => {
				if (recreateDirectory && runsDirectory !== null) {
					await mkdir(runsDirectory, { recursive: true, mode: 0o700 });
				}
				await appendFile(outputPath, line, 'utf8');
			})
			.catch((error: unknown) => {
				console.error('Voice journal could not persist activity output.', error);
			});
	}

	/**
	 * Drops the oldest events beyond the in-memory cap. Change reports are never
	 * evicted: they hold the only copy of the pre-change content used to revert.
	 */
	private evictOverflow(): void {
		let excess = this.events.length - MAX_IN_MEMORY_EVENTS;
		if (excess <= 0) {
			return;
		}
		this.events = this.events.filter((event) => {
			if (excess > 0 && event.kind !== 'changes') {
				excess -= 1;
				return false;
			}
			return true;
		});
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener(this.events);
		}
	}

	private changeSummary(changes: VaultFileChange[]): string {
		const reverted = changes.filter((change) => change.reverted === true).length;
		return reverted === 0
			? `${changes.length.toString()} file(s) changed.`
			: `${changes.length.toString()} file(s) changed · ${reverted.toString()} reverted.`;
	}
}
