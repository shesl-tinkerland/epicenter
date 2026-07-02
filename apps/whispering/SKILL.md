---
name: Whispering Voice Transcription
description: >
  Set up and use Whispering, a local-first open-source speech-to-text desktop
  app. Configure provider, shortcuts, transformations, and troubleshoot common
  issues across macOS, Windows, and Linux.
---

# Whispering Voice Transcription

Whispering is an open-source, local-first speech-to-text application built with
Tauri and Svelte 5. The user presses a keyboard shortcut, speaks, and the app
transcribes, optionally transforms with AI, then copies and pastes the result at
the cursor.

## Provenance

- **Source repository**: <https://github.com/epicenter-so/epicenter/tree/main/apps/whispering>
- **Discovery URL**: <https://news.ycombinator.com/item?id=44942731>
- **Project homepage**: <https://whispering.epicenter.so>
- **License**: AGPL-3.0

## When to Use This Skill

Use this skill when the user needs help with any of the following:

- Installing or updating Whispering on macOS, Windows, or Linux
- Choosing between local (Whisper C++) and cloud (Groq, OpenAI, ElevenLabs) transcription providers
- Configuring global keyboard shortcuts and push-to-talk or voice-activated recording modes
- Setting up AI-powered post-transcription transformations (custom prompts/models)
- Troubleshooting microphone permissions, App Nap issues, or shortcut conflicts
- Estimating transcription costs across different providers
- Understanding Whispering's privacy model and data flow

## Inputs

The user may provide:

- **Platform info**: which OS and architecture they are on
- **Provider preference**: local-only vs. cloud (Groq, OpenAI, ElevenLabs, etc.)
- **Use case context**: dictation, meeting notes, coding with voice, accessibility
- **Error or issue description**: what went wrong during setup or daily use
- **Transformation goals**: how they want transcribed text modified (grammar, formatting, translation)

## Workflow

### 1. Determine the User's Goal

Ask which of these the user needs:

| Goal | Route |
|---|---|
| Fresh install | Go to **Installation** |
| Choose or switch transcription provider | Go to **Provider Setup** |
| Configure shortcuts or recording mode | Go to **Recording Configuration** |
| Set up AI transformations | Go to **Transformations** |
| Fix a problem | Go to **Troubleshooting** |
| Understand costs / privacy | Go to **Cost & Privacy** |

### 2. Installation

Whispering ships as a lightweight ~22 MB desktop app via Tauri.

- **macOS**: `brew install --cask whispering` (recommended) or download `.dmg` from GitHub Releases. Apple Silicon only for direct downloads.
- **Windows**: MSI or EXE installer from GitHub Releases.
- **Linux**: AppImage (universal), `.deb` (Debian/Ubuntu), or `.rpm` (Fedora/RHEL).
- **Browser**: Try without install at <https://whispering.epicenter.so> (no global shortcuts in web mode).

All downloads: <https://github.com/EpicenterHQ/epicenter/releases/latest>

### 3. Provider Setup

Two transcription approaches:

**Local (Whisper C++)** -- complete privacy, offline, free forever.
Settings > Transcription > Whisper C++ > download a model (start with `Small`).

**Cloud (Groq recommended)** -- near-instant, high accuracy, cheap ($0.04/hr with `whisper-large-v3-turbo`).
Get a free API key at <https://console.groq.com/keys>, then Settings > Transcription > Groq > paste key > choose model.

Other supported cloud providers: OpenAI (`gpt-4o-mini-transcribe`), ElevenLabs.

### 4. Recording Configuration

- **Push-to-talk**: hold shortcut to record, release to transcribe (default).
- **Voice-activated mode**: hands-free, detects speech start/stop automatically. Recommended on macOS to avoid App Nap suspending background shortcuts.
- Global shortcut is configurable in Settings.

### 5. Transformations

After transcription, Whispering can transform the text using any AI model and custom prompt. Examples: grammar correction, code formatting, translation, summarization. Configure in Settings > Transformations.

### 6. Troubleshooting

Common issues:

- **Shortcut not working on macOS**: App Nap suspends background apps. Use Voice Activated mode or keep Whispering in foreground.
- **No transcription**: verify API key in Settings > Transcription.
- **Microphone denied**: re-enable in System Settings > Privacy > Microphone (macOS) or Windows Privacy settings.
- **"App is damaged" on macOS**: run `xattr -cr /Applications/Whispering.app` in Terminal.

### 7. Cost & Privacy

| Provider | Cost/Hour | Light (20 min/day) | Moderate (1 hr/day) | Heavy (3 hr/day) |
|---|---|---|---|---|
| Groq whisper-large-v3-turbo | $0.04 | $0.40/mo | $1.20/mo | $3.60/mo |
| Groq whisper-large-v3 | $0.111 | $1.11/mo | $3.33/mo | $9.99/mo |
| OpenAI gpt-4o-mini-transcribe | $0.18 | $1.80/mo | $5.40/mo | $16.20/mo |
| Local (Whisper C++) | $0.00 | $0.00/mo | $0.00/mo | $0.00/mo |

Data flow: audio goes directly from the user's machine to the chosen provider (local or cloud). No middleman servers. All data stored locally on-device.

## Output

Respond with clear, actionable guidance tailored to the user's platform and goal. Include specific settings paths, commands, and links. When troubleshooting, ask for OS version and error details before suggesting fixes.
