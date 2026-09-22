import { Notice, PluginSettingTab, normalizePath } from 'obsidian';
import type {
	App,
	Plugin,
	SettingDefinitionItem,
	SettingGroupItem,
} from 'obsidian';
import type {
	CodingAgentType,
	ConnectionProfile,
	NetworkScope,
	RecordingSource,
	RecordingGrouping,
	RecordingTimestampSource,
	StartupMode,
	VoiceJournalSettings,
} from '../model';
import { DEFAULT_AGENT_EXECUTABLES, getActiveProfile, normalizeVaultRelativePath } from './model';
import { DEFAULT_DJI_FILENAME_TIMESTAMP_REGEX } from '../ingest/recording-timestamp';

export interface SettingsHost {
	settings: VoiceJournalSettings;
	saveSettings: () => Promise<void>;
	checkCodingAgent: () => Promise<void>;
	listCodingAgentModels: () => Promise<string[]>;
	checkStt: () => Promise<void>;
}

function createId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}`;
}

export class VoiceJournalSettingTab extends PluginSettingTab {
	private codingAgentModels: string[] = [];
	private modelDiscoveryKey = '';
	private modelDiscoveryState: 'idle' | 'loading' | 'loaded' | 'failed' = 'idle';

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
				heading: 'Coding agent and speech-to-text',
				items: this.connectionDefinitions(),
			},
			{
				type: 'group',
				heading: 'Recording sources',
				items: this.sourceDefinitions(),
			},
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

	private connectionDefinitions(): SettingGroupItem[] {
		this.ensureCodingAgentModels();
		const profileOptions = Object.fromEntries(
			this.host.settings.connectionProfiles.map((profile) => [
				profile.id,
				profile.label,
			]),
		);
		const activeProfile = getActiveProfile(this.host.settings);
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
								this.host.settings.codingAgentProfile = '';
								this.host.settings.codingAgentModel = '';
								this.invalidateCodingAgentModels();
								await this.host.saveSettings();
								this.update();
							}),
					);
				},
			},
			this.profileTextDefinition(
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

		if (
			this.host.settings.codingAgentType === 'claude' ||
			this.host.settings.codingAgentType === 'codex'
		) {
			definitions.push(
				this.profileTextDefinition(
					this.host.settings.codingAgentType === 'codex'
						? 'Coding-agent profile'
						: 'Coding-agent agent',
					this.host.settings.codingAgentProfile,
					async (value) => {
						this.host.settings.codingAgentProfile = value;
						await this.host.saveSettings();
					},
				),
			);
		}

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
			{
				name: 'Speech-to-text profile',
				desc: 'The plugin never fails over to another profile automatically.',
				render: (setting) => {
					setting.addDropdown((dropdown) =>
						dropdown
							.addOptions(profileOptions)
							.setValue(this.host.settings.activeConnectionProfileId)
							.onChange(async (value) => {
								this.host.settings.activeConnectionProfileId = value;
								await this.host.saveSettings();
								this.update();
							}),
					);
				},
			},
		);

		if (activeProfile !== null) {
			definitions.push(...this.activeProfileDefinitions(activeProfile));
		}

		definitions.push({
			name: 'Add connection profile',
			desc: 'Create another speech-to-text endpoint profile.',
			render: (setting) => {
				setting.addButton((button) =>
					button.setButtonText('Add profile').onClick(async () => {
						const id = createId('profile');
						this.host.settings.connectionProfiles.push({
							id,
							label: 'New connection',
							sttBaseUrl: '',
							sttApiKey: '',
							networkScope: 'unknown',
						});
						this.host.settings.activeConnectionProfileId = id;
						await this.host.saveSettings();
						this.update();
					}),
				);
			},
		});
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

	private activeProfileDefinitions(
		profile: ConnectionProfile,
	): SettingGroupItem[] {
		return [
			this.profileTextDefinition('Profile name', profile.label, async (value) => {
				profile.label = value;
				await this.host.saveSettings();
			}),
			this.profileTextDefinition(
				'Speech-to-text base URL',
				profile.sttBaseUrl,
				async (value) => {
					profile.sttBaseUrl = value;
					await this.host.saveSettings();
				},
			),
			{
				name: 'Speech-to-text API key',
				desc: 'Bearer token sent to the speech-to-text endpoint. Leave blank when the endpoint requires no authentication.',
				render: (setting) => {
					setting.addText((text) => {
						text.inputEl.type = 'password';
						return text
							.setPlaceholder('Optional')
							.setValue(profile.sttApiKey)
							.onChange(async (value) => {
								profile.sttApiKey = value.trim();
								await this.host.saveSettings();
							});
					});
				},
			},
			{
				name: 'Speech-to-text network scope',
				desc: 'Audio is sent to this destination for transcription.',
				render: (setting) => {
					setting.addDropdown((dropdown) =>
						dropdown
							.addOptions({
								loopback: 'Loopback',
								'private-network': 'Private network',
								'public-network': 'Public network',
								unknown: 'Unknown',
							})
							.setValue(profile.networkScope)
							.onChange(async (value) => {
								profile.networkScope = value as NetworkScope;
								await this.host.saveSettings();
							}),
					);
				},
			},
			{
				name: 'Speech-to-text model',
				desc: 'Leave blank to use the only model returned by /models.',
				render: (setting) => {
					setting
						.addText((text) =>
							text
								.setPlaceholder('Model ID')
								.setValue(this.host.settings.sttModel)
								.onChange(async (value) => {
									this.host.settings.sttModel = value.trim();
									await this.host.saveSettings();
								}),
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
				name: 'Remove active profile',
				desc: 'At least one connection profile must remain.',
				render: (setting) => {
					setting.addButton((button) =>
						button
							.setButtonText('Remove')
							.setDestructive()
							.setDisabled(this.host.settings.connectionProfiles.length <= 1)
							.onClick(async () => {
								this.host.settings.connectionProfiles =
									this.host.settings.connectionProfiles.filter(
										(candidate) => candidate.id !== profile.id,
									);
								this.host.settings.activeConnectionProfileId =
									this.host.settings.connectionProfiles[0]?.id ?? '';
								await this.host.saveSettings();
								this.update();
							}),
					);
				},
			},
		];
	}

	private profileTextDefinition(
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

	private sourceDefinitions(): SettingGroupItem[] {
		const definitions = this.host.settings.recordingSources.flatMap(
			(source) => this.sourceDefinition(source),
		);
		definitions.push({
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
		});
		definitions.push({
			name: 'Add recording source',
			desc: 'The path must be absolute and explicitly configured.',
			render: (setting) => {
				setting.addButton((button) =>
					button.setButtonText('Add source').onClick(async () => {
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
					}),
				);
			},
		});
		return definitions;
	}

	private sourceDefinition(source: RecordingSource): SettingGroupItem[] {
		return [
			{
				name: source.name,
				desc: source.path === '' ? 'Path not configured.' : source.path,
				render: (setting) => {
					setting
						.addText((text) =>
							text
								.setPlaceholder('Source name')
								.setValue(source.name)
								.onChange(async (value) => {
									source.name = value.trim();
									await this.host.saveSettings();
								}),
						)
						.addExtraButton((button) =>
							button
								.setIcon('trash')
								.setTooltip('Remove source')
								.onClick(async () => {
									this.host.settings.recordingSources =
										this.host.settings.recordingSources.filter(
											(candidate) => candidate.id !== source.id,
										);
									await this.host.saveSettings();
									this.update();
								}),
						);
				},
			},
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
				desc: 'Maximum retained audio and transcript cache size in MiB. Oldest recording artifacts are removed first; files in the current run are protected.',
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
