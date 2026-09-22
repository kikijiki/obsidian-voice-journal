import type { CodingAgentType } from '../model';
import { CodexOutputPresenter } from './agent-output/codex-presenter';
import { PiOutputPresenter } from './agent-output/pi-presenter';
import {
	type AgentProtocolPresenter,
	type FormattedAgentLine,
	formatAgentLine,
	record,
} from './agent-output/shared';

export type { FormattedAgentLine } from './agent-output/shared';
export { formatAgentLine } from './agent-output/shared';
export { AgentLineBuffer } from './agent-output/line-buffer';

class GenericOutputPresenter implements AgentProtocolPresenter {
	push(line: string): FormattedAgentLine[] {
		return [formatAgentLine(line)];
	}

	flush(): FormattedAgentLine[] {
		return [];
	}
}

export function agentTurnStarted(line: string): boolean {
	try {
		const type = record(JSON.parse(line.trim()))?.type;
		return type === 'turn_start' || type === 'turn.started';
	} catch {
		return false;
	}
}

export class AgentOutputPresenter implements AgentProtocolPresenter {
	private readonly presenter: AgentProtocolPresenter;

	constructor(type: CodingAgentType, scope = 'agent') {
		this.presenter =
			type === 'pi'
				? new PiOutputPresenter(scope)
				: type === 'codex'
					? new CodexOutputPresenter(scope)
					: new GenericOutputPresenter();
	}

	push(line: string): FormattedAgentLine[] {
		return this.presenter.push(line);
	}

	flush(): FormattedAgentLine[] {
		return this.presenter.flush();
	}
}
