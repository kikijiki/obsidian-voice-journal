import type { VoiceJournalSettings } from '../model';

export const OPENROUTER_STT_BASE_URL = 'https://openrouter.ai/api/v1';

/** The endpoint to call; `sttBaseUrl` only holds the custom provider's URL. */
export function effectiveSttBaseUrl(
	settings: Pick<VoiceJournalSettings, 'sttProvider' | 'sttBaseUrl'>,
): string {
	return settings.sttProvider === 'openrouter'
		? OPENROUTER_STT_BASE_URL
		: settings.sttBaseUrl;
}

export const OPENROUTER_STT_MODEL_QUERY: Record<string, string> = {
	output_modalities: 'transcription',
};
