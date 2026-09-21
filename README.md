# Better Lyrics with Furigana

A personal fork of [Better Lyrics](https://github.com/better-lyrics/better-lyrics) (based on v2.3.3), a browser extension that shows time-synced lyrics on YouTube Music. This fork adds **furigana** for Japanese lyrics and **LLM-powered translation**, plus a few UI tweaks.

> **Made with Claude Code.** Nearly all of the changes in this fork were written with [Claude Code](https://claude.com/claude-code), Anthropic's coding agent. They are lightly tested personal-use code, not an official release, and this fork is not affiliated with the upstream project.

**한국어 요약:** Better Lyrics v2.3.3 포크입니다. 일본어 가사에 후리가나를 붙이고, 사용자의 API 키로 LLM 번역(번역 → 구어체 수정 2단계)을 제공합니다. 변경 대부분은 Claude Code로 작성했습니다.

## What this fork adds

### Furigana

- Per-kanji readings above Japanese lyrics, highlighted in step with the karaoke sweep.
- Readings come from Google's romaji converted back to kana, cross-checked against a bundled offline dictionary ([kuromoji](https://github.com/takuyaa/kuromoji.js) via [kuroshiro](https://github.com/hexenq/kuroshiro)), plus a table of manual overrides for readings both get wrong.
- **AI furigana (optional):** the LLM is asked for the *sung* reading (including artistic readings such as ateji). The local result is shown first and quietly replaced when the AI answer arrives.
- **UtaTen source (optional, prototype):** can pull readings from utaten.com instead. It scrapes a third-party site, so check its terms before relying on it.

### LLM translation ("Best" mode)

- Bring your own key for **OpenAI, Anthropic or Google Gemini**. The whole song is translated in one request so every line has context. Google Translate output is shown first and swapped out when the LLM result is ready; on any failure the Google result simply stays.
- **Second pass:** the draft is handed back to the model to be rewritten as natural spoken language instead of stiff written style (can be turned off).
- **Custom prompt** with Apply / Reset, appended to the translation and revision prompts.
- Results are cached per song, so replays cost nothing.
- The API key is stored in `chrome.storage.local` only. It is never synced and never included in messages between extension parts.

### Smaller changes

- Seeking only from the left gutter bar, with drag-to-copy on the rest of the line and double-click to seek anywhere.
- Album art size slider.
- Unsynced lyrics are shown at full brightness, and auto-scroll stays at the end instead of jumping back to the top.
- Romanization is skipped for lyrics already in your default language.
- More reliable Google translation: batch context, normalized cache, and per-line fallback.

## Build and install

```bash
npm ci
npm run build
```

Then open `chrome://extensions`, enable Developer mode, and choose **Load unpacked** on `dist/chrome`. (`dist/firefox` and `dist/edge` are built as well.)

## Setup

1. Open the extension options and go to the **Language** tab.
2. Turn on translation and romanization (furigana rides on the romanization switch).
3. For LLM translation, set **Translation quality** to *Best*, pick a provider, and paste your API key. Leaving **Model** empty uses the provider's default.

Requests are billed by your provider. Free tiers have daily request limits, and each new song can use up to three requests (translation, revision, furigana).

## Staying in sync with upstream

```bash
git fetch upstream && git rebase upstream/master
```

## License

GPL-3.0, the same as upstream. See [LICENSE](LICENSE). All credit for the original extension goes to the [Better Lyrics](https://github.com/better-lyrics/better-lyrics) authors and contributors.
