# voice-translate-realtime

Chrome extension for near real-time translation of active tab audio using the OpenAI Realtime API.

## Quick start

Repository:

`https://github.com/proger89/voice-translate-realtime.git`

```bash
git clone https://github.com/proger89/voice-translate-realtime.git
cd voice-translate-realtime
```

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the project folder.
4. Open a tab with video or audio content.
5. Click the extension icon, enter your `OpenAI API key` (`sk-...`), then click **Save**.
6. Choose source/target languages, model, and voice.
7. Click **Start**.

## Updating from Git

```bash
git pull
```

## Usage

- The extension captures active tab audio, translates speech, and plays translated voiceover.
- Live status and controls are available in the popup.
- If needed, click **Download log** and share the file for troubleshooting.

## Useful settings

- `Model`: `gpt-realtime-mini` is faster, `gpt-realtime` is usually higher quality.
- `VAD / segmentation`: if phrases are cut off or translation stalls, try `semantic_vad`.
- `VAD threshold` and `Silence (ms)`: tune pause sensitivity.
- `Translation speech speed`: values around `1.05–1.15` often feel natural and help keep up with the speaker.

## UI language

- The extension supports English and Russian UI.
- On first install, UI language is auto-selected from browser UI language (`ru*` -> Russian, otherwise English).
- You can always switch UI language manually in the popup.

## Security note

- API key is stored in `chrome.storage.sync`.
- For Chrome Web Store production release, it is recommended to issue ephemeral tokens from your own backend instead of exposing a long-lived API key in the extension.
