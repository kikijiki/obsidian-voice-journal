# Obsidian Voice Journal

Imports voice recordings into Obsidian, transcribes them with a configured speech-to-text service, and lets a coding agent write the resulting notes into your vault. Desktop only, local-first, no telemetry.

The plugin does the mechanical work: it scans recording sources, waits for a stable file, deduplicates by content hash, copies the audio, transcribes it, and runs the selected agent. The agent does the semantic work: it cleans the transcript, inspects your vault, links existing notes, and creates or updates entries.

## Requirements

- Obsidian 1.13.0 or newer, on desktop.
- A speech-to-text service exposing the OpenAI-compatible `/audio/transcriptions` API.
- One of Pi, Claude Code, Codex, or Cursor installed and configured.

## Install

The plugin has not been submitted to the community plugin directory yet, so installation is manual:

1. Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/kikijiki-voice-journal/`.
2. Enable **Kikijiki Voice Journal** under Community plugins.
3. Reload Obsidian after replacing a development build.

## Use

1. Open the plugin settings and configure the recording source path(s), the timestamp strategy, the journal directory, a speech-to-text profile, and the coding agent.
2. Run **Voice journal: Check inference providers** to verify the endpoints.
3. Run **Voice journal: Process new voice recordings** from the command palette or the ribbon icon.

The plugin copies each stable recording, transcribes it, and invokes the agent once per group. The activity panel opens automatically and shows progress, full transcripts, agent output, and a diff of every changed note. Each file, or the whole report, can be reverted. Completed recordings are never processed again.

## Settings

### Recording sources

Each source is an absolute path outside the vault, such as mounted microphone storage. Per source: `path`, `recursive`, and `extensions` control what is scanned, and symbolic links are always skipped. `minimumAgeSeconds` skips files modified too recently. `timestampSource` is `filename` or `filesystem`. `filenameTimestampRegex` is a case-insensitive expression with named `year`, `month`, `day`, `hour`, `minute`, and `second` groups; the default matches DJI transmitter names such as `TX01_MIC002_20260921_190443_orig.wav`. `timestampOffsetHours` is added after parsing and may be fractional or negative. A filename that does not match is reported as a scan error, and the plugin does not guess a different date.

### Agent call grouping

`recordingGrouping` decides which prepared transcripts share one agent call: `none`, `day`, `week`, `month`, or `all`. Boundaries use the host local timezone and weeks start on Monday. Copying and transcription stay per-file and resumable. The default is `day`.

### Journal directory

The single vault-structure setting. It tells the agent where the journal is. It does not stop the agent from reading or updating other notes the recording refers to. There are no settings for people, topics, projects, books, or provenance; the agent learns those conventions from the vault.

### Coding agent

- `codingAgentType`: `pi`, `claude`, `codex`, or `cursor`.
- `codingAgentExecutable`: executable name or absolute path.
- `codingAgentProfile`: Claude agent or Codex profile. Pi and Cursor ignore it.
- `codingAgentModel`: optional model ID understood by that CLI.
- `codingAgentThinkingEnabled`: Pi's native `high` thinking level. Off by default.
- `codingAgentTimeoutSeconds`: optional wall-clock limit for one agent run. `0` disables it.
- **Add new entries**: allow the agent to create a missing note outside the journal when the recording refers to it.
- **Update existing entries**: allow the agent to enrich an existing note outside the journal with facts from the recording.
- **Additional agent instructions**: trusted vault-specific guidance appended to the agent contract.

The CLI owns the model endpoint and credentials through its own configuration.

### Speech-to-text profiles

A profile holds the `sttBaseUrl`, an optional `sttApiKey` sent as a bearer token, and a `networkScope` label. There is no automatic failover between profiles, because switching between loopback and another host changes the privacy boundary. Set `sttModel` to the model ID the service serves.

### Operational cache

`artifactCacheMaxMb` bounds retained audio, raw transcripts, and STT responses. It defaults to 5120 MiB. After processing, the oldest artifacts are deleted first, and recordings in the current batch are protected.

## What it writes

- A journal entry in the configured journal directory, with provenance in a `voice_journal_sources` YAML list of `sha256:<hash>` values and `date` on newly created daily notes. HTML provenance comments are never used.
- When **Add new entries** or **Update existing entries** is enabled, notes outside the journal that the recording refers to. With both off, the agent edits only the journal entry.
- Retained audio and raw transcripts in the plugin's own `.voice-journal` cache.

The activity panel snapshots Markdown notes around each agent call and shows a diff of every change. Revert refuses to overwrite a file that was manually changed after the run.

## Privacy

- Audio is sent only to the speech-to-text endpoint saved in the active profile.
- Transcripts are sent to whatever model the selected coding agent CLI is configured to use.
- There is no telemetry, no cloud fallback, and no automatic profile failover.
- Activity logs are session-only and stored in the plugin-local ignored cache.

## Desktop and filesystem access

This plugin is desktop-only because it reads recording directories outside the vault, such as mounted microphone storage. Every external path is entered by the user, symbolic links are skipped, recordings are copied and verified before processing, and nothing is ever deleted from the source device.

## Development

```bash
npm run setup   # install dependencies
npm run dev     # watch build
npm run check   # build, lint, test, whitespace check
```

A Nix flake provides Node.js 24 and can be entered with `nix develop` or direnv.
