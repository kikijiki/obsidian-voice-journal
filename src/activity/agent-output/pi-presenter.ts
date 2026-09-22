import {
	type AgentProtocolPresenter,
	type FormattedAgentLine,
	formatAgentLine,
	nonEmptyString,
	numericValue,
	prettyValue,
	record,
	stringValue,
	toolIcon,
	toolTitle,
} from './shared';

interface PiContentBuffer {
	key: string;
	title: string;
	content: string;
}

interface PiToolBuffer {
	key: string;
	name: string;
	args?: unknown;
}

function primaryToolArgument(name: string, args: unknown): string | undefined {
	const values = record(args);
	if (values === null) {
		return undefined;
	}
	const pick = (...keys: string[]): string | undefined => {
		for (const key of keys) {
			const value = nonEmptyString(values[key]);
			if (value !== undefined) {
				return value;
			}
		}
		return undefined;
	};
	const lowerName = name.toLowerCase();
	if (lowerName === 'grep') {
		const pattern = pick('pattern', 'query');
		const location = pick('path', 'glob');
		return [pattern, location].filter(Boolean).join(' · ') || undefined;
	}
	if (lowerName === 'find') {
		const pattern = pick('pattern', 'query');
		const location = pick('path');
		return [pattern, location].filter(Boolean).join(' · ') || undefined;
	}
	return pick('path', 'file_path', 'query', 'pattern', 'command');
}

function toolResultText(result: unknown): string {
	if (typeof result === 'string') {
		return result;
	}
	const value = record(result);
	if (value === null) {
		return prettyValue(result);
	}
	const content = Array.isArray(value.content) ? value.content : [];
	const text = content
		.flatMap((part) => {
			const item = record(part);
			return item?.type === 'text' && typeof item.text === 'string'
				? [item.text]
				: [];
		})
		.join('\n');
	const details = record(value.details);
	const renderedDetails =
		details === null || Object.keys(details).length === 0
			? ''
			: `\n\nDetails\n${prettyValue(details)}`;
	return `${text}${renderedDetails}`.trim();
}

function toolDetail(args: unknown, result?: unknown): string {
	const sections = [`Input\n${prettyValue(args)}`];
	if (result !== undefined) {
		sections.push(`Output\n${toolResultText(result)}`);
	}
	return sections.join('\n\n');
}

function messageContent(value: Record<string, unknown>): unknown[] {
	const message = record(value.message);
	return Array.isArray(message?.content) ? message.content : [];
}

export class PiOutputPresenter implements AgentProtocolPresenter {
	private messageSequence = 0;
	private activeMessage = 0;
	private readonly content = new Map<number, PiContentBuffer>();
	private toolSequence = 0;
	private readonly tools = new Map<string, PiToolBuffer>();

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

		const assistantEvent = record(value.assistantMessageEvent);
		const assistantType = nonEmptyString(assistantEvent?.type);
		if (assistantEvent !== null && assistantType !== undefined) {
			return this.presentAssistantEvent(assistantType, assistantEvent);
		}

		const eventType = nonEmptyString(value.type);
		if (eventType === 'message_start') {
			const message = record(value.message);
			if (message?.role === 'assistant') {
				this.activeMessage = ++this.messageSequence;
				this.content.clear();
			}
			return [];
		}
		if (eventType === 'message_end') {
			return this.finishMessage(value);
		}
		if (eventType === 'auto_retry_start' || eventType === 'auto_retry_end') {
			return [this.retryEvent(eventType, value)];
		}
		if (
			eventType === 'tool_execution_start' ||
			eventType === 'tool_execution_end'
		) {
			return [this.toolEvent(eventType, value)];
		}
		if (
			eventType === 'session' ||
			eventType === 'agent_start' ||
			eventType === 'agent_end' ||
			eventType === 'agent_settled' ||
			eventType === 'tool_execution_update' ||
			eventType === 'turn_start' ||
			eventType === 'turn_end'
		) {
			return [];
		}
		return [formatAgentLine(line)];
	}

	flush(): FormattedAgentLine[] {
		const events: FormattedAgentLine[] = [];
		for (const buffer of this.content.values()) {
			events.push({
				...this.contentEvent(buffer, true),
				detail: 'Pi exited before completing this message.',
				level: 'warning',
				status: 'interrupted',
			});
		}
		this.content.clear();
		for (const tool of this.tools.values()) {
			events.push({
				title: toolTitle(tool.name),
				message: primaryToolArgument(tool.name, tool.args) ?? 'No input',
				detail: 'Pi exited before reporting the tool result.',
				level: 'warning',
				presentation: 'tool',
				icon: toolIcon(tool.name),
				status: 'interrupted',
				replaceKey: tool.key,
				persist: true,
			});
		}
		this.tools.clear();
		return events;
	}

	private presentAssistantEvent(
		type: string,
		event: Record<string, unknown>,
	): FormattedAgentLine[] {
		const contentIndex = numericValue(event.contentIndex, 0);
		const isText = type.startsWith('text_');
		const title = isText ? 'Agent response' : 'Agent reasoning';
		if (type === 'text_start' || type === 'thinking_start') {
			return [this.startContent(contentIndex, title)];
		}
		if (type === 'text_delta' || type === 'thinking_delta') {
			return [
				this.updateContent(
					contentIndex,
					title,
					stringValue(event.delta) ?? '',
				),
			];
		}
		if (type === 'text_end' || type === 'thinking_end') {
			const buffer = this.ensureContent(contentIndex, title);
			buffer.content = stringValue(event.content) ?? buffer.content;
			return [this.contentEvent(buffer, false)];
		}
		return [];
	}

	private retryEvent(
		type: 'auto_retry_start' | 'auto_retry_end',
		value: Record<string, unknown>,
	): FormattedAgentLine {
		const attempt = numericValue(value.attempt, 1);
		if (type === 'auto_retry_start') {
			const maximum = numericValue(value.maxAttempts, attempt);
			const delayMs = numericValue(value.delayMs, 0);
			const error = nonEmptyString(value.errorMessage) ?? 'request failed';
			return {
				title: 'Retrying model request',
				message: `Attempt ${attempt.toString()} of ${maximum.toString()} in ${(delayMs / 1_000).toString()}s · ${error}`,
				level: 'warning',
				presentation: 'event',
				icon: 'refresh-cw',
				status: 'running',
				replaceKey: `${this.scope}:pi-auto-retry`,
				persist: false,
			};
		}
		const succeeded = value.success === true;
		return {
			title: succeeded ? 'Model request recovered' : 'Model request failed',
			message: succeeded
				? `Recovered after ${attempt.toString()} retry attempt${attempt === 1 ? '' : 's'}.`
				: nonEmptyString(value.finalError) ??
					`Failed after ${attempt.toString()} attempts.`,
			level: succeeded ? 'success' : 'error',
			presentation: 'event',
			icon: succeeded ? 'refresh-cw' : 'circle-x',
			status: succeeded ? 'succeeded' : 'failed',
			replaceKey: `${this.scope}:pi-auto-retry`,
			persist: true,
		};
	}

	private toolEvent(
		type: 'tool_execution_start' | 'tool_execution_end',
		value: Record<string, unknown>,
	): FormattedAgentLine {
		const tool = nonEmptyString(value.toolName) ?? 'tool';
		const toolCallId =
			nonEmptyString(value.toolCallId) ??
			`unknown-${(++this.toolSequence).toString()}`;
		const ended = type === 'tool_execution_end';
		const failed = ended && value.isError === true;
		let activeTool = this.tools.get(toolCallId);
		if (activeTool === undefined) {
			activeTool = {
				key: `${this.scope}:pi-tool:${toolCallId}`,
				name: tool,
				args: value.args,
			};
			this.tools.set(toolCallId, activeTool);
		}
		if (ended) {
			this.tools.delete(toolCallId);
		}
		return {
			title: toolTitle(activeTool.name),
			message: primaryToolArgument(activeTool.name, activeTool.args) ?? 'No input',
			detail: toolDetail(activeTool.args, ended ? value.result : undefined),
			level: failed ? 'warning' : 'info',
			presentation: 'tool',
			icon: toolIcon(activeTool.name),
			status: ended ? (failed ? 'warning' : 'succeeded') : 'running',
			replaceKey: activeTool.key,
			persist: ended,
		};
	}

	private ensureContent(index: number, title: string): PiContentBuffer {
		let buffer = this.content.get(index);
		if (buffer === undefined) {
			if (this.activeMessage === 0) {
				this.activeMessage = ++this.messageSequence;
			}
			buffer = {
				key: `${this.scope}:pi-message:${this.activeMessage.toString()}:${index.toString()}`,
				title,
				content: '',
			};
			this.content.set(index, buffer);
		}
		return buffer;
	}

	private startContent(index: number, title: string): FormattedAgentLine {
		const buffer = this.ensureContent(index, title);
		buffer.content = '';
		return this.contentEvent(buffer, false);
	}

	private updateContent(
		index: number,
		title: string,
		delta: string,
	): FormattedAgentLine {
		const buffer = this.ensureContent(index, title);
		buffer.content += delta;
		return this.contentEvent(buffer, false);
	}

	private contentEvent(
		buffer: PiContentBuffer,
		persist: boolean,
	): FormattedAgentLine {
		const thinking = buffer.title === 'Agent reasoning';
		return {
			title: buffer.title,
			message: buffer.content === '' ? 'Streaming…' : buffer.content,
			presentation: thinking ? 'thinking' : 'message',
			icon: thinking ? 'brain' : 'message-square',
			status: persist ? 'succeeded' : 'running',
			replaceKey: buffer.key,
			persist,
		};
	}

	private finishMessage(value: Record<string, unknown>): FormattedAgentLine[] {
		const message = record(value.message);
		if (message?.role !== 'assistant') {
			return [];
		}
		const events: FormattedAgentLine[] = [];
		for (const [index, itemValue] of messageContent(value).entries()) {
			const item = record(itemValue);
			if (item?.type === 'text') {
				const buffer = this.ensureContent(index, 'Agent response');
				buffer.content = stringValue(item.text) ?? buffer.content;
				events.push(this.contentEvent(buffer, true));
			} else if (item?.type === 'thinking') {
				const buffer = this.ensureContent(index, 'Agent reasoning');
				buffer.content =
					stringValue(item.thinking) ?? stringValue(item.text) ?? buffer.content;
				events.push(this.contentEvent(buffer, true));
			}
		}
		for (const [index, buffer] of this.content) {
			if (!events.some((event) => event.replaceKey === buffer.key)) {
				events.push(this.contentEvent(buffer, true));
			}
			this.content.delete(index);
		}
		this.activeMessage = 0;
		return events;
	}
}
