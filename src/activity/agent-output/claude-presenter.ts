import {
	type AgentProtocolPresenter,
	type FormattedAgentLine,
	formatAgentLine,
	nonEmptyString,
	prettyValue,
	record,
	resultErrorEvent,
	toolIcon,
	toolTitle,
} from './shared';

interface ClaudeToolBuffer {
	key: string;
	name: string;
	input: unknown;
}

// Claude's built-in tool names don't match the read/write/edit/grep/find/ls
// vocabulary shared.ts's toolIcon() understands; map the ones with an obvious
// equivalent so they get a matching icon instead of the generic wrench.
const TOOL_ICON_ALIASES: Record<string, string> = {
	glob: 'find',
	bash: 'terminal',
	todowrite: 'list-checks',
	webfetch: 'globe',
	websearch: 'globe',
	task: 'bot',
	notebookedit: 'file-pen-line',
};

function claudeToolIcon(name: string): string {
	const lowered = name.toLowerCase();
	if (lowered in TOOL_ICON_ALIASES) {
		const alias = TOOL_ICON_ALIASES[lowered];
		return alias === undefined ? 'wrench' : toolIcon(alias);
	}
	return toolIcon(lowered);
}

function primaryToolArgument(name: string, input: unknown): string | undefined {
	const values = record(input);
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
	if (lowerName === 'grep' || lowerName === 'glob') {
		const pattern = pick('pattern');
		const location = pick('path', 'glob');
		return [pattern, location].filter(Boolean).join(' · ') || undefined;
	}
	if (lowerName === 'bash') {
		return pick('description') ?? pick('command');
	}
	return pick('file_path', 'path', 'pattern', 'query', 'prompt');
}

function toolResultText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.flatMap((part) => {
				const item = record(part);
				return item?.type === 'text' && typeof item.text === 'string'
					? [item.text]
					: [];
			})
			.join('\n');
	}
	return content === undefined ? '' : prettyValue(content);
}

function toolDetail(input: unknown, result?: unknown): string {
	const sections = [`Input\n${prettyValue(input)}`];
	if (result !== undefined) {
		sections.push(`Output\n${toolResultText(result)}`);
	}
	return sections.join('\n\n');
}

export class ClaudeOutputPresenter implements AgentProtocolPresenter {
	private readonly tools = new Map<string, ClaudeToolBuffer>();
	// Fallback identities for tool blocks without ids; monotonic so rows never
	// collide with (and overwrite) earlier ones.
	private fallbackSequence = 0;

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
		const type = nonEmptyString(value.type);
		// The init "system" message and a successful trailing "result" summary
		// carry no user-facing content; every other turn is a fully-formed
		// assistant or tool-result message (this CLI is not run with
		// partial-message deltas). Failed results surface as an error row.
		if (type === 'system') {
			return [];
		}
		if (type === 'result') {
			const error = resultErrorEvent(value, 'Claude');
			return error === null ? [] : [error];
		}
		if (type === 'assistant') {
			return this.presentContent(record(value.message)?.content, 'assistant');
		}
		if (type === 'user') {
			return this.presentContent(record(value.message)?.content, 'user');
		}
		return [formatAgentLine(line)];
	}

	flush(): FormattedAgentLine[] {
		const events = [...this.tools.values()].map((tool) =>
			this.interruptedTool(tool),
		);
		this.tools.clear();
		return events;
	}

	private presentContent(
		content: unknown,
		role: 'assistant' | 'user',
	): FormattedAgentLine[] {
		if (!Array.isArray(content)) {
			return [];
		}
		return content.flatMap((blockValue): FormattedAgentLine[] => {
			const block = record(blockValue);
			if (block === null) {
				return [];
			}
			const blockType = nonEmptyString(block.type);
			if (role === 'assistant' && blockType === 'text') {
				const text = nonEmptyString(block.text);
				return text === undefined ? [] : [this.contentEvent('Agent response', 'message-square', text)];
			}
			if (role === 'assistant' && blockType === 'thinking') {
				const thinking = nonEmptyString(block.thinking) ?? nonEmptyString(block.text);
				return thinking === undefined
					? []
					: [this.contentEvent('Agent reasoning', 'brain', thinking, 'thinking')];
			}
			if (role === 'assistant' && blockType === 'tool_use') {
				return [this.startTool(block)];
			}
			if (role === 'user' && blockType === 'tool_result') {
				return [this.finishTool(block)];
			}
			return [];
		});
	}

	private contentEvent(
		title: string,
		icon: string,
		message: string,
		presentation: 'message' | 'thinking' = 'message',
	): FormattedAgentLine {
		return {
			title,
			message,
			presentation,
			icon,
			status: 'succeeded',
			persist: true,
		};
	}

	private startTool(block: Record<string, unknown>): FormattedAgentLine {
		const name = nonEmptyString(block.name) ?? 'tool';
		const id = nonEmptyString(block.id) ?? this.fallbackId();
		const buffer: ClaudeToolBuffer = {
			key: `${this.scope}:claude-tool:${id}`,
			name,
			input: block.input,
		};
		this.tools.set(id, buffer);
		return {
			title: toolTitle(buffer.name),
			message: primaryToolArgument(buffer.name, buffer.input) ?? 'No input',
			detail: toolDetail(buffer.input),
			presentation: 'tool',
			icon: claudeToolIcon(buffer.name),
			status: 'running',
			replaceKey: buffer.key,
			persist: false,
		};
	}

	private finishTool(block: Record<string, unknown>): FormattedAgentLine {
		const id = nonEmptyString(block.tool_use_id);
		const buffer: ClaudeToolBuffer = (id === undefined
			? undefined
			: this.tools.get(id)) ?? {
			key: `${this.scope}:claude-tool:${id ?? this.fallbackId()}`,
			name: 'tool',
			input: undefined,
		};
		if (id !== undefined) {
			this.tools.delete(id);
		}
		const failed = block.is_error === true;
		return {
			title: toolTitle(buffer.name),
			message: primaryToolArgument(buffer.name, buffer.input) ?? 'No input',
			detail: toolDetail(buffer.input, block.content),
			level: failed ? 'warning' : 'info',
			presentation: 'tool',
			icon: claudeToolIcon(buffer.name),
			status: failed ? 'warning' : 'succeeded',
			replaceKey: buffer.key,
			persist: true,
		};
	}

	private fallbackId(): string {
		this.fallbackSequence += 1;
		return `unknown-${this.fallbackSequence.toString()}`;
	}

	private interruptedTool(buffer: ClaudeToolBuffer): FormattedAgentLine {
		return {
			title: toolTitle(buffer.name),
			message: primaryToolArgument(buffer.name, buffer.input) ?? 'No input',
			detail: `${toolDetail(buffer.input)}\n\nClaude exited before reporting the tool result.`,
			level: 'warning',
			presentation: 'tool',
			icon: claudeToolIcon(buffer.name),
			status: 'interrupted',
			replaceKey: buffer.key,
			persist: true,
		};
	}
}
