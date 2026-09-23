import { Notice, PluginSettingTab, normalizePath } from 'obsidian';
import type {
	App,
	Plugin,
	SettingDefinitionItem,
	SettingDefinitionList,
	SettingDefinitionPage,
	SettingGroupItem,
} from 'obsidian';
import type {
	CodingAgentType,
	RecordingSource,
	RecordingGrouping,
	RecordingTimestampSource,
	StartupMode,
	SttProviderType,
	VoiceJournalSettings,
} from '../model';
import { DEFAULT_AGENT_EXECUTABLES, normalizeVaultRelativePath } from './model';
import { DEFAULT_DJI_FILENAME_TIMESTAMP_REGEX } from '../ingest/recording-timestamp';
import { OPENROUTER_STT_BASE_URL } from '../providers/openrouter';
import { VOICE_JOURNAL_SOURCES_PROPERTY } from '../pipeline/recording-processor';

export interface SettingsHost {
	settings: VoiceJournalSettings;
	saveSettings: () => Promise<void>;
	checkCodingAgent: () => Promise<void>;
	listCodingAgentModels: () => Promise<string[]>;
	checkStt: () => Promise<void>;
	listSttModels: () => Promise<string[]>;
}

function createId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}`;
}

export class VoiceJournalSettingTab extends PluginSettingTab {
	private codingAgentModels: string[] = [];
	private modelDiscoveryKey = '';
	private modelDiscoveryState: 'idle' | 'loading' | 'loaded' | 'failed' = 'idle';
	private sttModels: string[] = [];
	private sttModelDiscoveryKey = '';
	private sttModelDiscoveryState: 'idle' | 'loading' | 'loaded' | 'failed' =
		'idle';

	constructor(
		app: App,
		plugin: Plugin,
		private readonly host: SettingsHost,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ type: 'group', heading: 'Triggers', items: this.triggerDefinitions() },
			{
				type: 'group',
				heading: 'Coding agent',
				items: this.codingAgentDefinitions(),
			},
			{
				type: 'group',
				heading: 'Speech-to-text',
				items: this.sttDefinitions(),
			},
			{
				type: 'group',
				heading: 'Recording sources',
				items: this.recordingSourcesGroup(),
			},
			this.recordingSourcesList(),
			{
				type: 'group',
				heading: 'Journal',
				items: this.journalDefinitions(),
			},
		];
	}

	private triggerDefinitions(): SettingGroupItem[] {
		return [
			{
				name: 'Run at startup',
				desc: 'Runs only after the Obsidian workspace is ready.',
				render: (setting) => {
					setting.addDropdown((dropdown) =>
						dropdown
							.addOptions({
								off: 'Off',
								'scan-only': 'Scan only',
								'scan-and-process': 'Process new recordings',
							})
							.setValue(this.host.settings.startupMode)
							.onChange(async (value) => {
								this.host.settings.startupMode = value as StartupMode;
								await this.host.saveSettings();
							}),
					);
				},
			},
			{
				name: 'Startup delay',
				desc: 'Milliseconds to wait after the workspace is ready.',
				render: (setting) => {
					setting.addText((text) =>
						text
							.setValue(this.host.settings.startupDelayMs.toString())
							.onChange(async (value) => {
								const delay = Number.parseInt(value, 10);
								if (Number.isFinite(delay) && delay >= 0) {
									this.host.settings.startupDelayMs = delay;
									await this.host.saveSettings();
								}
							}),
					);
				},
			},
		];
	}

	private codingAgentDefinitions(): SettingGroupItem[] {
		this.ensureCodingAgentModels();
		const definitions: SettingGroupItem[] = [
			{
				name: 'Coding agent',
				desc: 'The command-line agent that inspects and edits the vault after transcription.',
				render: (setting) => {
					setting.addDropdown((dropdown) =>
						dropdown
							.addOptions({
								pi: 'Pi',
								claude: 'Claude Code',
								codex: 'Codex',
								cursor: 'Cursor',
							})
							.setValue(this.host.settings.codingAgentType)
							.onChange(async (value) => {
								const previous = this.host.settings.codingAgentType;
								const next = value as CodingAgentType;
								if (
									this.host.settings.codingAgentExecutable ===
									DEFAULT_AGENT_EXECUTABLES[previous]
								) {
									this.host.settings.codingAgentExecutable =
										DEFAULT_AGENT_EXECUTABLES[next];
								}
								this.host.settings.codingAgentType = next;
								this.host.settings.codingAgentModel = '';
								this.invalidateCodingAgentModels();
								await this.host.saveSettings();
								this.update();
							}),
					);
				},
			},
			this.textFieldDefinition(
				'Coding-agent executable',
				this.host.settings.codingAgentExecutable,
				async (value) => {
					this.host.settings.codingAgentExecutable = value;
					this.invalidateCodingAgentModels();
					await this.host.saveSettings();
					this.update();
				},
			),
		];

		definitions.push(
			{
				name: 'Coding-agent model',
				desc:
					this.modelDiscoveryState === 'failed'
						? 'The selected CLI could not enumerate models. The current value is preserved; use Refresh to try again.'
						: 'Models reported by the selected coding-agent CLI. Choose agent default to omit the model flag.',
				render: (setting) => {
					setting.settingEl.addClass(
						'voice-journal-setting--stacked-control',
					);
					const configured = this.host.settings.codingAgentModel;
					const models =
						configured === '' || this.codingAgentModels.includes(configured)
							? this.codingAgentModels
							: [configured, ...this.codingAgentModels];
					setting
						.addDropdown((dropdown) => {
							dropdown.selectEl.addClass(
								'voice-journal-setting-control--model',
							);
							return dropdown
								.addOption('', 'Agent default')
								.addOptions(
									Object.fromEntries(models.map((model) => [model, model])),
								)
								.setValue(configured)
								.onChange(async (value) => {
									this.host.settings.codingAgentModel = value;
									await this.host.saveSettings();
								});
						})
						.addButton((button) =>
							button
								.setButtonText(
									this.modelDiscoveryState === 'loading'
										? 'Loading…'
										: 'Refresh',
								)
								.setDisabled(this.modelDiscoveryState === 'loading')
								.onClick(async () => this.refreshCodingAgentModels(true)),
						)
						.addButton((button) =>
							button.setButtonText('Test').onClick(async () => {
								try {
									await this.host.checkCodingAgent();
								} catch (error) {
									new Notice(
										error instanceof Error
											? error.message
											: 'Coding-agent test failed.',
									);
								}
							}),
						);
				},
			},
			{
				name: 'Model thinking',
				desc: 'Enable extended reasoning for compatible models. Off by default.',
				render: (setting) => {
					setting.addToggle((toggle) =>
						toggle
							.setValue(this.host.settings.codingAgentThinkingEnabled)
							.onChange(async (value) => {
								this.host.settings.codingAgentThinkingEnabled = value;
								await this.host.saveSettings();
							}),
					);
				},
			},
			{
				name: 'Coding-agent timeout',
				desc: 'Seconds before an agent run is aborted. 0 disables the timeout.',
				render: (setting) => {
					setting.addText((text) => {
						text.inputEl.type = 'number';
						text.inputEl.min = '0';
						return text
							.setValue(
								this.host.settings.codingAgentTimeoutSeconds.toString(),
							)
							.onChange(async (value) => {
								const seconds = Number.parseInt(value, 10);
								if (Number.isFinite(seconds) && seconds >= 0) {
									this.host.settings.codingAgentTimeoutSeconds = seconds;
									await this.host.saveSettings();
								}
							});
					});
				},
			},
		);
		return definitions;
	}

	private sttDefinitions(): SettingGroupItem[] {
		this.ensureSttModels();
		const settings = this.host.settings;
		const definitions: SettingGroupItem[] = [
			{
				name: 'Provider',
				desc: 'OpenRouter uses a fixed endpoint, sends audio as base64 JSON (larger uploads than the standard multipart format), and lists ASR-capable models from its catalog using your API key.',
				render: (setting) => {
					setting.addDropdown((dropdown) =>
						dropdown
							.addOptions({
								custom: 'Custom endpoint',
								openrouter: 'OpenRouter',
							})
							.setValue(settings.sttProvider)
							.onChange(async (value) => {
								settings.sttProvider = value as SttProviderType;
								if (settings.sttProvider === 'openrouter') {
									settings.sttBaseUrl = OPENROUTER_STT_BASE_URL;
								}
								this.invalidateSttModels();
								await this.host.saveSettings();
								this.update();
							}),
					);
				},
			},
		];

		if (settings.sttProvider === 'custom') {
			definitions.push(
				this.textFieldDefinition('Base URL', settings.sttBaseUrl, async (value) => {
					settings.sttBaseUrl = value;
					this.invalidateSttModels();
					await this.host.saveSettings();
				}),
			);
		} else {
			definitions.push({
				name: 'Base URL',
				desc: 'Fixed OpenRouter endpoint.',
				render: (setting) => {
					setting.addText((text) => {
						text.setValue(OPENROUTER_STT_BASE_URL).setDisabled(true);
					});
				},
			});
		}

		definitions.push(
			{
				name: 'API key',
				desc: 'Bearer token sent to the speech-to-text endpoint. Leave blank when the endpoint requires no authentication.',
				render: (setting) => {
					setting.addText((text) => {
						text.inputEl.type = 'password';
						return text
							.setPlaceholder('Optional')
							.setValue(settings.sttApiKey)
							.onChange(async (value) => {
								settings.sttApiKey = value.trim();
								this.invalidateSttModels();
								await this.host.saveSettings();
							});
					});
				},
			},
			{
				name: 'Model',
				desc:
					this.sttModelDiscoveryState === 'failed'
						? 'Models could not be enumerated. The current value is preserved; use Refresh to try again.'
						: settings.sttProvider === 'openrouter'
							? 'ASR-capable models reported by OpenRouter for your API key. Leave blank to use the only model returned.'
							: 'Models reported by the endpoint’s /models. Leave blank to use the only model returned.',
				render: (setting) => {
					setting.settingEl.addClass(
						'voice-journal-setting--stacked-control',
					);
					const configured = settings.sttModel;
					const models =
						configured === '' || this.sttModels.includes(configured)
							? this.sttModels
							: [configured, ...this.sttModels];
					setting
						.addDropdown((dropdown) => {
							dropdown.selectEl.addClass(
								'voice-journal-setting-control--model',
							);
							return dropdown
								.addOption('', 'Provider default')
								.addOptions(
									Object.fromEntries(models.map((model) => [model, model])),
								)
								.setValue(configured)
								.onChange(async (value) => {
									settings.sttModel = value;
									await this.host.saveSettings();
								});
						})
						.addButton((button) =>
							button
								.setButtonText(
									this.sttModelDiscoveryState === 'loading'
										? 'Loading…'
										: 'Refresh',
								)
								.setDisabled(this.sttModelDiscoveryState === 'loading')
								.onClick(async () => this.refreshSttModels(true)),
						)
						.addButton((button) =>
							button.setButtonText('Test').onClick(async () => {
								try {
									await this.host.checkStt();
								} catch (error) {
									new Notice(
										error instanceof Error
											? error.message
											: 'Provider test failed.',
									);
								}
							}),
						);
				},
			},
			{
				name: 'Split long recordings',
				desc: 'Splits recordings larger than about 20 MB or longer than 5 minutes into parts with ffmpeg, transcribes each part, and stitches the text back together. Uses OpenRouter’s request limits for every provider, including local servers.',
				render: (setting) => {
					setting.addToggle((toggle) =>
						toggle
							.setValue(settings.sttSplitLongRecordings)
							.onChange(async (value) => {
								settings.sttSplitLongRecordings = value;
								await this.host.saveSettings();
							}),
					);
				},
			},
			{
				name: 'ffmpeg executable',
				desc: 'Used to read recording durations and split long recordings. Only needed when splitting is on.',
				render: (setting) => {
					setting.addText((text) =>
						text
							.setValue(settings.ffmpegExecutable)
							.onChange(async (value) => {
								settings.ffmpegExecutable = value.trim();
								await this.host.saveSettings();
							}),
					);
				},
			},
		);
		return definitions;
	}

	private currentModelDiscoveryKey(): string {
		return `${this.host.settings.codingAgentType}\0${this.host.settings.codingAgentExecutable}`;
	}

	private invalidateCodingAgentModels(): void {
		this.modelDiscoveryKey = '';
		this.modelDiscoveryState = 'idle';
		this.codingAgentModels = [];
	}

	private ensureCodingAgentModels(): void {
		const key = this.currentModelDiscoveryKey();
		if (
			this.modelDiscoveryKey === key &&
			this.modelDiscoveryState !== 'idle'
		) {
			return;
		}
		void this.refreshCodingAgentModels(false);
	}

	private async refreshCodingAgentModels(showFailure: boolean): Promise<void> {
		const key = this.currentModelDiscoveryKey();
		this.modelDiscoveryKey = key;
		this.modelDiscoveryState = 'loading';
		try {
			const models = await this.host.listCodingAgentModels();
			if (this.currentModelDiscoveryKey() !== key) {
				return;
			}
			this.codingAgentModels = models;
			this.modelDiscoveryState = 'loaded';
		} catch (error) {
			if (this.currentModelDiscoveryKey() !== key) {
				return;
			}
			this.codingAgentModels = [];
			this.modelDiscoveryState = 'failed';
			if (showFailure) {
				new Notice(
					error instanceof Error
						? error.message
						: 'Could not load coding-agent models.',
				);
			}
		} finally {
			if (this.currentModelDiscoveryKey() === key) {
				this.update();
			}
		}
	}

	private currentSttModelDiscoveryKey(): string {
		const settings = this.host.settings;
		return `${settings.sttProvider}\0${settings.sttBaseUrl}\0${settings.sttApiKey}`;
	}

	private invalidateSttModels(): void {
		this.sttModelDiscoveryKey = '';
		this.sttModelDiscoveryState = 'idle';
		this.sttModels = [];
	}

	private ensureSttModels(): void {
		const key = this.currentSttModelDiscoveryKey();
		if (
			this.sttModelDiscoveryKey === key &&
			this.sttModelDiscoveryState !== 'idle'
		) {
			return;
		}
		void this.refreshSttModels(false);
	}

	private async refreshSttModels(showFailure: boolean): Promise<void> {
		const key = this.currentSttModelDiscoveryKey();
		this.sttModelDiscoveryKey = key;
		this.sttModelDiscoveryState = 'loading';
		try {
			const models = await this.host.listSttModels();
			if (this.currentSttModelDiscoveryKey() !== key) {
				return;
			}
			this.sttModels = models;
			this.sttModelDiscoveryState = 'loaded';
		} catch (error) {
			if (this.currentSttModelDiscoveryKey() !== key) {
				return;
			}
			this.sttModels = [];
			this.sttModelDiscoveryState = 'failed';
			if (showFailure) {
				new Notice(
					error instanceof Error
						? error.message
						: 'Could not load speech-to-text models.',
				);
			}
		} finally {
			if (this.currentSttModelDiscoveryKey() === key) {
				this.update();
			}
		}
	}

	private textFieldDefinition(
		name: string,
		value: string,
		onChange: (value: string) => Promise<void>,
	): SettingGroupItem {
		return {
			name,
			render: (setting) => {
				setting.addText((text) =>
					text.setValue(value).onChange(async (newValue) => {
						await onChange(newValue.trim());
					}),
				);
			},
		};
	}

	private recordingSourcesGroup(): SettingGroupItem[] {
		return [
			{
				name: 'Maximum scan entries',
				desc: 'Safety limit across files and folders in one scan.',
				render: (setting) => {
					setting.addText((text) =>
						text
							.setValue(this.host.settings.maxEntriesPerScan.toString())
							.onChange(async (value) => {
								const maximum = Number.parseInt(value, 10);
								if (Number.isFinite(maximum) && maximum >= 1) {
									this.host.settings.maxEntriesPerScan = maximum;
									await this.host.saveSettings();
								}
							}),
					);
				},
			},
		];
	}

	private recordingSourcesList(): SettingDefinitionList {
		return {
			type: 'list',
			emptyState: 'No recording sources configured yet.',
			addItem: {
				name: 'Add recording source',
				action: () => {
					void (async () => {
						this.host.settings.recordingSources.push({
							id: createId('source'),
							name: 'DJI microphone',
							path: '',
							recursive: true,
							extensions: ['.wav', '.mp3', '.m4a'],
							minimumAgeSeconds: 10,
							timestampSource: 'filename',
							filenameTimestampRegex: DEFAULT_DJI_FILENAME_TIMESTAMP_REGEX,
							timestampOffsetHours: 0,
						});
						await this.host.saveSettings();
						this.update();
					})();
				},
			},
			onDelete: (index) => {
				void (async () => {
					this.host.settings.recordingSources.splice(index, 1);
					await this.host.saveSettings();
					this.update();
				})();
			},
			items: this.host.settings.recordingSources.map((source) =>
				this.sourcePageDefinition(source),
			),
		};
	}

	private sourcePageDefinition(source: RecordingSource): SettingDefinitionPage {
		return {
			type: 'page',
			name: source.name === '' ? 'Unnamed source' : source.name,
			desc: source.path === '' ? 'Path not configured.' : source.path,
			status: source.path === '' ? 'warning' : null,
			items: this.sourceFieldDefinitions(source),
		};
	}

	private sourceFieldDefinitions(source: RecordingSource): SettingGroupItem[] {
		return [
			this.textFieldDefinition('Source name', source.name, async (value) => {
				source.name = value;
				await this.host.saveSettings();
			}),
			{
				name: 'Source path',
				render: (setting) => {
					setting.addText((text) =>
						text
							.setPlaceholder('/absolute/path/to/recordings')
							.setValue(source.path)
							.onChange(async (value) => {
								source.path = value.trim();
								await this.host.saveSettings();
							}),
					);
				},
			},
			{
				name: 'Scan recursively',
				render: (setting) => {
					setting.addToggle((toggle) =>
						toggle.setValue(source.recursive).onChange(async (value) => {
							source.recursive = value;
							await this.host.saveSettings();
						}),
					);
				},
			},
			{
				name: 'Audio extensions',
				desc: 'Comma-separated filename extensions.',
				render: (setting) => {
					setting.addText((text) =>
						text
							.setPlaceholder('.wav, .mp3, .m4a')
							.setValue(source.extensions.join(', '))
							.onChange(async (value) => {
								source.extensions = value
									.split(',')
									.map((extension) => extension.trim())
									.filter((extension) => extension !== '');
								await this.host.saveSettings();
							}),
					);
				},
			},
			{
				name: 'Minimum file age',
				desc: 'Seconds since the last modification before a file is listed. Filesystem clock skew is verified by stability instead.',
				render: (setting) => {
					setting.addText((text) =>
						text
							.setValue(source.minimumAgeSeconds.toString())
							.onChange(async (value) => {
								const seconds = Number.parseInt(value, 10);
								if (Number.isFinite(seconds) && seconds >= 0) {
									source.minimumAgeSeconds = seconds;
									await this.host.saveSettings();
								}
							}),
					);
				},
			},
			{
				name: 'Recording timestamp source',
				desc: 'Choose how the journal date and recording time are determined.',
				render: (setting) => {
					setting.addDropdown((dropdown) =>
						dropdown
							.addOptions({
								filename: 'Filename',
								filesystem: 'Filesystem metadata',
							})
							.setValue(source.timestampSource)
							.onChange(async (value) => {
								source.timestampSource = value as RecordingTimestampSource;
								await this.host.saveSettings();
								this.update();
							}),
					);
				},
			},
			...(source.timestampSource === 'filename'
				? [
						{
							name: 'Filename timestamp regex',
							desc: 'Case-insensitive regular expression with named year, month, day, hour, minute, and second groups.',
							render: (setting) => {
								setting.settingEl.addClass(
									'voice-journal-setting--stacked-control',
								);
								setting.addText((text) => {
									text.inputEl.addClass(
										'voice-journal-setting-control--wide',
									);
									return text
										.setPlaceholder(DEFAULT_DJI_FILENAME_TIMESTAMP_REGEX)
										.setValue(source.filenameTimestampRegex)
										.onChange(async (value) => {
											source.filenameTimestampRegex = value;
											await this.host.saveSettings();
										});
								});
							},
						} satisfies SettingGroupItem,
					]
				: []),
			{
				name: 'Timestamp offset',
				desc: 'Hours added after parsing. Use a negative value when the reported time is ahead.',
				render: (setting) => {
					setting.addText((text) => {
						text.inputEl.type = 'number';
						text.inputEl.step = '0.25';
						return text
							.setPlaceholder('0')
							.setValue(source.timestampOffsetHours.toString())
							.onChange(async (value) => {
								const trimmed = value.trim();
								const hours = trimmed === '' ? 0 : Number(trimmed);
								if (Number.isFinite(hours)) {
									source.timestampOffsetHours = hours;
									await this.host.saveSettings();
								}
							});
					});
				},
			},
		];
	}

	private journalDefinitions(): SettingGroupItem[] {
		return [
			{
				name: 'Agent call grouping',
				desc: 'Combine prepared transcripts into one coding-agent call. Weekly groups start on Monday.',
				render: (setting) => {
					setting.addDropdown((dropdown) =>
						dropdown
							.addOptions({
								none: 'No grouping',
								day: 'Group by day',
								week: 'Group by week',
								month: 'Group by month',
								all: 'Group all available',
							})
							.setValue(this.host.settings.recordingGrouping)
							.onChange(async (value) => {
								this.host.settings.recordingGrouping =
									value as RecordingGrouping;
								await this.host.saveSettings();
							}),
					);
				},
			},
			{
				name: 'Journal directory',
				desc: 'The vault-relative folder containing journal entries.',
				render: (setting) => {
					setting.addText((text) =>
						text
							.setPlaceholder('Journal')
							.setValue(this.host.settings.journalDirectory)
							.onChange(async (value) => {
								this.host.settings.journalDirectory =
									normalizeVaultRelativePath(normalizePath(value));
								await this.host.saveSettings();
							}),
					);
				},
			},
			{
				name: 'Hide source markers property',
				desc: `Hides the ${VOICE_JOURNAL_SOURCES_PROPERTY} property (long recording hashes) in the Properties panel. Only affects display; the frontmatter is unchanged and still visible in Source mode.`,
				render: (setting) => {
					setting.addToggle((toggle) =>
						toggle
							.setValue(this.host.settings.hideSourcesProperty)
							.onChange(async (value) => {
								this.host.settings.hideSourcesProperty = value;
								await this.host.saveSettings();
							}),
					);
				},
			},
			{
				name: 'Add new entries',
				desc: 'Allow the agent to create missing linked notes outside the journal, following the vault’s existing conventions.',
				render: (setting) => {
					setting.addToggle((toggle) =>
						toggle
							.setValue(this.host.settings.agentAddNewEntries)
							.onChange(async (value) => {
								this.host.settings.agentAddNewEntries = value;
								await this.host.saveSettings();
							}),
					);
				},
			},
			{
				name: 'Update existing entries',
				desc: 'Allow the agent to enrich relevant existing notes with facts explicitly present in the transcript.',
				render: (setting) => {
					setting.addToggle((toggle) =>
						toggle
							.setValue(this.host.settings.agentUpdateExistingEntries)
							.onChange(async (value) => {
								this.host.settings.agentUpdateExistingEntries = value;
								await this.host.saveSettings();
							}),
					);
				},
			},
			{
				name: 'Additional agent instructions',
				desc: 'Optional trusted instructions about your vault conventions, writing style, metadata, or preferred agent behavior.',
				render: (setting) => {
					setting.settingEl.addClass(
						'voice-journal-setting--stacked-control',
					);
					setting.addTextArea((text) => {
						text.inputEl.addClass(
							'voice-journal-setting-control--instructions',
						);
						return text
							.setPlaceholder(
								'Example: Preserve my informal tone. Infer habit tags from nearby journal entries when clearly supported.',
							)
							.setValue(this.host.settings.additionalAgentInstructions)
							.onChange(async (value) => {
								this.host.settings.additionalAgentInstructions = value;
								await this.host.saveSettings();
							});
					});
				},
			},
			{
				name: 'Artifact cache maximum size',
				desc: 'Maximum retained transcript cache size in MiB. Audio copies are deleted as soon as a recording is transcribed. Oldest recording artifacts are removed first; files in the current run are protected.',
				render: (setting) => {
					setting.addText((text) => {
						text.inputEl.type = 'number';
						text.inputEl.min = '1';
						return text
							.setValue(this.host.settings.artifactCacheMaxMb.toString())
							.onChange(async (value) => {
								const maximum = Number.parseInt(value, 10);
								if (Number.isFinite(maximum) && maximum >= 1) {
									this.host.settings.artifactCacheMaxMb = maximum;
									await this.host.saveSettings();
								}
							});
					});
				},
			},
		];
	}
}
