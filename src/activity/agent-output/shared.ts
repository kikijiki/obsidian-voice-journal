export interface FormattedAgentLine {
	title: string;
	message?: string;
	detail?: string;
	level?: 'info' | 'warning' | 'error' | 'success';
	presentation?: 'message' | 'thinking' | 'tool' | 'event';
	icon?: string;
	status?: 'running' | 'succeeded' | 'warning' | 'failed' | 'interrupted';
	replaceKey?: string;
	persist?: boolean;
}

export interface AgentProtocolPresenter {
	push: (line: string) => FormattedAgentLine[];
	flush: () => FormattedAgentLine[];
}

export function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

export function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function record(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function prettyValue(value: unknown, indentation = 0): string {
	const prefix = ' '.repeat(indentation);
	if (value === null) {
		return 'null';
	}
	if (typeof value === 'string') {
		if (!value.includes('\n')) {
			return value;
		}
		return `|\n${value
			.split('\n')
			.map((line) => `${prefix}  ${line}`)
			.join('\n')}`;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => {
				const rendered = prettyValue(item, indentation + 2);
				return `${prefix}- ${rendered}`;
			})
			.join('\n');
	}
	const object = record(value);
	if (object !== null) {
		return Object.entries(object)
			.map(([key, item]) => {
				const rendered = prettyValue(item, indentation + 2);
				const separator =
					Array.isArray(item) || record(item) !== null || rendered.includes('\n')
						? '\n'
						: ' ';
				return `${prefix}${key}:${separator}${rendered}`;
			})
			.join('\n');
	}
	return 'Unsupported value';
}

export function toolIcon(name: string): string {
	return {
		read: 'file-text',
		write: 'file-plus-2',
		edit: 'file-pen-line',
		grep: 'search',
		find: 'files',
		ls: 'folder-open',
	}[name.toLowerCase()] ?? 'wrench';
}

export function toolTitle(name: string): string {
	return name.length === 0
		? 'Tool'
		: `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

export function formatAgentLine(line: string): FormattedAgentLine {
	const trimmed = line.trim();
	if (trimmed === '') {
		return { title: 'Agent output', presentation: 'event', icon: 'bot' };
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		const value = record(parsed);
		if (value === null) {
			return genericOutput(trimmed);
		}
		const assistantEvent = record(value.assistantMessageEvent);
		const type =
			nonEmptyString(assistantEvent?.type) ??
			nonEmptyString(value.type) ??
			'event';
		const text = firstText(value);
		const tool = firstTool(value);
		return {
			title: tool === undefined ? `Agent · ${type}` : `Agent · ${tool}`,
			message: text,
			detail: prettyValue(parsed),
			presentation: 'event',
			icon: tool === undefined ? 'bot' : toolIcon(tool),
		};
	} catch {
		return genericOutput(trimmed);
	}
}

export function numericValue(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isInteger(value)
		? value
		: fallback;
}

function genericOutput(message: string): FormattedAgentLine {
	return {
		title: 'Agent output',
		message,
		presentation: 'event',
		icon: 'bot',
	};
}

function firstText(value: Record<string, unknown>): string | undefined {
	const part = record(value.part);
	const item = record(value.item);
	const message = record(value.message);
	const assistantEvent = record(value.assistantMessageEvent);
	return (
		nonEmptyString(value.text) ??
		nonEmptyString(value.result) ??
		nonEmptyString(value.delta) ??
		nonEmptyString(part?.text) ??
		nonEmptyString(item?.text) ??
		nonEmptyString(message?.text) ??
		nonEmptyString(assistantEvent?.delta)
	);
}

function firstTool(value: Record<string, unknown>): string | undefined {
	const part = record(value.part);
	const item = record(value.item);
	const assistantEvent = record(value.assistantMessageEvent);
	return (
		nonEmptyString(value.tool) ??
		nonEmptyString(value.toolName) ??
		nonEmptyString(value.name) ??
		nonEmptyString(part?.tool) ??
		nonEmptyString(part?.name) ??
		nonEmptyString(item?.name) ??
		nonEmptyString(assistantEvent?.toolName)
	);
}
