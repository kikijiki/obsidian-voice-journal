import {
	type AgentProtocolPresenter,
	type FormattedAgentLine,
	formatAgentLine,
	nonEmptyString,
	prettyValue,
	record,
	stringValue,
	toolTitle,
} from './shared';

interface CodexItemBuffer {
	key: string;
	type: string;
	item: Record<string, unknown>;
}

interface CommandPresentation {
	title: string;
	message: string;
	icon: string;
}

function commandPaths(command: string): string[] {
	return [
		...command.matchAll(
			/((?:\.?[\p{L}\p{N}_-]+\/)+(?:[\p{L}\p{N}_. -]+)\.(?:md|txt|json|ya?ml))/giu,
		),
	].flatMap((match) => {
		const path = match[1]?.trim();
		return path === undefined ? [] : [path];
	});
}

function commandSearchRoot(command: string): string | undefined {
	const beforePipeline = command.split(/\||&&|;/u)[0] ?? command;
	const match = /\s([\p{L}\p{N}_./-]+)\s*['"]?$/u.exec(beforePipeline);
	const candidate = match?.[1];
	return candidate !== undefined && !candidate.startsWith('-')
		? candidate
		: undefined;
}

function commandPresentation(command: string): CommandPresentation {
	const firstPath = commandPaths(command)[0];
	if (/\b(?:rg|grep)\b/u.test(command)) {
		return {
			title: 'Search',
			message: firstPath ?? commandSearchRoot(command) ?? 'Vault',
			icon: 'search',
		};
	}
	if (/\bfind\s/u.test(command)) {
		const root = /\bfind\s+([^\s'"|;&]+)/u.exec(command)?.[1];
		return { title: 'Find files', message: root ?? 'Vault', icon: 'files' };
	}
	if (/\b(?:sed\s+-n|cat|head|tail)\b/u.test(command)) {
		return { title: 'Read', message: firstPath ?? 'File', icon: 'file-text' };
	}
	if (/\bmkdir\b/u.test(command)) {
		const path = /\bmkdir(?:\s+-\w+)*\s+([^\s'"|;&]+)/u.exec(command)?.[1];
		return {
			title: 'Create folder',
			message: path ?? 'Folder',
			icon: 'folder-plus',
		};
	}
	if (/\bls(?:\s|$)/u.test(command)) {
		const path = /\bls(?:\s+-\w+)*\s+([^\s'"|;&]+)/u.exec(command)?.[1];
		return { title: 'List files', message: path ?? 'Vault', icon: 'folder-open' };
	}
	return { title: 'Run command', message: 'Shell', icon: 'terminal' };
}

function commandDetail(
	command: string,
	output: string | undefined,
	exitCode: number | undefined,
): string {
	const sections = [`Command\n${command}`];
	if (output !== undefined) {
		sections.push(
			`Output\n${output.trim() === '' ? 'No output.' : output.trimEnd()}`,
		);
	}
	if (exitCode !== undefined) {
		sections.push(`Exit code: ${exitCode.toString()}`);
	}
	return sections.join('\n\n');
}

function fileChangePaths(item: Record<string, unknown>): string[] {
	const changes = Array.isArray(item.changes) ? item.changes : [];
	return changes.flatMap((value) => {
		const path = nonEmptyString(record(value)?.path);
		return path === undefined ? [] : [path];
	});
}

export class CodexOutputPresenter implements AgentProtocolPresenter {
	private readonly items = new Map<string, CodexItemBuffer>();

	constructor(private readonly scope: string) {}

	push(line: string): FormattedAgentLine[] {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line.trim());
		} catch {
			return [formatAgentLine(line)];
		}
		const value = record(parsed);
		if (value === null) {
			return [formatAgentLine(line)];
		}
		const eventType = nonEmptyString(value.type);
		if (
			eventType === 'thread.started' ||
			eventType === 'turn.started' ||
			eventType === 'turn.completed'
		) {
			return [];
		}
		if (eventType !== 'item.started' && eventType !== 'item.completed') {
			return [formatAgentLine(line)];
		}
		const item = record(value.item);
		const id = nonEmptyString(item?.id);
		if (item === null || id === undefined) {
			return [];
		}
		const ended = eventType === 'item.completed';
		const buffer = this.updateBuffer(id, item);
		if (ended) {
			this.items.delete(id);
		}
		return this.presentItem(buffer, ended);
	}

	flush(): FormattedAgentLine[] {
		const events = [...this.items.values()].flatMap((buffer) =>
			this.interruptedItem(buffer),
		);
		this.items.clear();
		return events;
	}

	private updateBuffer(
		id: string,
		item: Record<string, unknown>,
	): CodexItemBuffer {
		const existing = this.items.get(id);
		if (existing !== undefined) {
			existing.item = item;
			return existing;
		}
		const buffer = {
			key: `${this.scope}:codex-item:${id}`,
			type: nonEmptyString(item.type) ?? 'activity',
			item,
		};
		this.items.set(id, buffer);
		return buffer;
	}

	private presentItem(
		buffer: CodexItemBuffer,
		ended: boolean,
	): FormattedAgentLine[] {
		if (buffer.type === 'agent_message') {
			return ended
				? [
						{
							title: 'Agent response',
							message: nonEmptyString(buffer.item.text) ?? 'Completed.',
							presentation: 'message',
							icon: 'message-square',
							status: 'succeeded',
							replaceKey: buffer.key,
							persist: true,
						},
					]
				: [];
		}
		if (buffer.type === 'command_execution') {
			return [this.commandEvent(buffer, ended)];
		}
		if (buffer.type === 'file_change') {
			return [this.fileChangeEvent(buffer, ended)];
		}
		return [this.genericItemEvent(buffer, ended)];
	}

	private commandEvent(
		buffer: CodexItemBuffer,
		ended: boolean,
	): FormattedAgentLine {
		const command = nonEmptyString(buffer.item.command) ?? 'Unknown command';
		const presentation = commandPresentation(command);
		const exitCode =
			typeof buffer.item.exit_code === 'number'
				? buffer.item.exit_code
				: undefined;
		const failed = ended && exitCode !== undefined && exitCode !== 0;
		return {
			...presentation,
			detail: commandDetail(
				command,
				ended ? stringValue(buffer.item.aggregated_output) ?? '' : undefined,
				ended ? exitCode : undefined,
			),
			level: failed ? 'warning' : 'info',
			presentation: 'tool',
			status: ended ? (failed ? 'warning' : 'succeeded') : 'running',
			replaceKey: buffer.key,
			persist: ended,
		};
	}

	private fileChangeEvent(
		buffer: CodexItemBuffer,
		ended: boolean,
	): FormattedAgentLine {
		const paths = fileChangePaths(buffer.item);
		return {
			title: paths.length === 1 ? 'Edit file' : 'Edit files',
			message:
				paths.length === 0
					? 'Vault'
					: paths.length === 1
						? paths[0]
						: `${paths.length.toString()} files`,
			detail: prettyValue(buffer.item),
			presentation: 'tool',
			icon: 'file-pen-line',
			status: ended ? 'succeeded' : 'running',
			replaceKey: buffer.key,
			persist: ended,
		};
	}

	private genericItemEvent(
		buffer: CodexItemBuffer,
		ended: boolean,
	): FormattedAgentLine {
		return {
			title: toolTitle(buffer.type.replaceAll('_', ' ')),
			detail: prettyValue(buffer.item),
			presentation: 'tool',
			icon: 'wrench',
			status: ended ? 'succeeded' : 'running',
			replaceKey: buffer.key,
			persist: ended,
		};
	}

	private interruptedItem(buffer: CodexItemBuffer): FormattedAgentLine[] {
		if (buffer.type === 'agent_message') {
			return [];
		}
		const event =
			buffer.type === 'command_execution'
				? this.commandEvent(buffer, false)
				: buffer.type === 'file_change'
					? this.fileChangeEvent(buffer, false)
					: this.genericItemEvent(buffer, false);
		return [
			{
				...event,
				detail: `${event.detail ?? ''}\n\nCodex exited before reporting completion.`,
				level: 'warning',
				status: 'interrupted',
				persist: true,
			},
		];
	}
}
