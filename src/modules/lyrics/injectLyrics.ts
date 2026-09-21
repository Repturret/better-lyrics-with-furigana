import {
  BACKGROUND_LYRIC_CLASS,
  EXPLICIT_WORD_CLASS,
  HAS_TRAILING_SPACE_CLASS,
  LOG_PREFIX,
  LYRICS_CLASS,
  LYRICS_FOUND_LOG,
  LYRICS_TAB_NOT_DISABLED_LOG,
  LYRICS_WRAPPER_ID,
  LYRICS_WRAPPER_NOT_VISIBLE_LOG,
  NO_LYRICS_FOUND_LOG,
  NO_LYRICS_TEXT_SELECTOR,
  ROMANIZATION_LANGUAGES,
  ROMANIZED_LYRICS_CLASS,
  RTL_CLASS,
  SYNC_DISABLED_LOG,
  TAB_HEADER_CLASS,
  TRANSLATED_LYRICS_CLASS,
  TRANSLATION_ENABLED_LOG,
  WORD_CLASS,
  ZERO_DURATION_ANIMATION_CLASS,
} from "@constants";
import { AppState } from "@core/appState";
import { t } from "@core/i18n";
import { createInstrumentalElement } from "@modules/lyrics/createInstrumentalElement";
import {
  annotateFurigana,
  annotateFuriganaFromRomaji,
  applyLlmFurigana,
  hasKana,
  setSongFuriganaOverrides,
  shouldFurigana,
} from "@modules/lyrics/furigana";
import { attachLineInteractions, hasActiveTextSelection, isInSeekGutter } from "@modules/lyrics/lineInteractions";
import {
  furiganaWithLlm,
  getLlmConfig,
  reviseTranslationWithLlm,
  translateLinesWithLlm,
} from "@modules/lyrics/llmTranslation";
import { containsNonLatin, detectNonLatinLanguage, testRtl } from "@modules/lyrics/lyricParseUtils";
import { applySegmentMapToLyrics, type LyricSourceResultWithMeta } from "@modules/lyrics/lyrics";
import type { Lyric, LyricPart } from "@modules/lyrics/providers/shared";
import type { UnisonData } from "@modules/lyrics/providers/unison";
import {
  getRomanizationFromCache,
  getTranslationFromCache,
  romanizeBatch,
  translateBatch,
} from "@modules/lyrics/translation";
import { getUtatenOverrides } from "@modules/lyrics/utatenFurigana";
import { registerThemeSetting } from "@modules/settings/themeOptions";
import { animEngineState, lyricsElementAdded } from "@modules/ui/animationEngine";
import { resizeCanvas } from "@modules/ui/animationEngineDebug";
import {
  addFooter,
  addNoLyricsButton,
  cleanup,
  createLyricsWrapper,
  flushLoader,
  renderLoader,
  setExtraHeight,
} from "@modules/ui/dom";
import { getRelativeBounds, langCodesMatch, languageMatchesAny, log } from "@utils";

let disableRichsync = registerThemeSetting("blyrics-disable-richsync", false, true);
let lineSyncedAnimationDelay = registerThemeSetting("blyrics-line-synced-animation-delay", 50, true);
let longWordThreshold = registerThemeSetting("blyrics-long-word-threshold", 1500, true);
let longWordWrapThreshold = registerThemeSetting("blyrics-long-word-wrap-threshold", 5, true);

function isRomanizationDisabledForLang(lang: string): boolean {
  return languageMatchesAny(lang, AppState.romanizationDisabledLanguages);
}

function isTranslationDisabledForLang(lang: string): boolean {
  return languageMatchesAny(lang, AppState.translationDisabledLanguages);
}

function findNearestAgent(lyrics: Lyric[], fromIndex: number): string | undefined {
  for (let i = fromIndex - 1; i >= 0; i--) {
    if (!lyrics[i].isInstrumental && lyrics[i].agent) {
      return lyrics[i].agent;
    }
  }
  for (let i = fromIndex + 1; i < lyrics.length; i++) {
    if (!lyrics[i].isInstrumental && lyrics[i].agent) {
      return lyrics[i].agent;
    }
  }
  return undefined;
}

function isNearestLyricRtl(lyrics: Lyric[], fromIndex: number): boolean {
  for (let i = fromIndex - 1; i >= 0; i--) {
    if (!lyrics[i].isInstrumental && lyrics[i].words?.trim()) {
      return testRtl(lyrics[i].words);
    }
  }
  for (let i = fromIndex + 1; i < lyrics.length; i++) {
    if (!lyrics[i].isInstrumental && lyrics[i].words?.trim()) {
      return testRtl(lyrics[i].words);
    }
  }
  return false;
}

let resizeObserver: ResizeObserver | null = null;

function getResizeObserver(): ResizeObserver {
  if (!resizeObserver) {
    resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target.id === LYRICS_WRAPPER_ID) {
          if (
            AppState.lyricData &&
            (entry.target.clientWidth !== AppState.lyricData.lyricWidth ||
              entry.target.clientHeight !== AppState.lyricData.lyricHeight)
          ) {
            animEngineState.doneFirstInstantScroll = false;
            animEngineState.nextScrollAllowedTime = 0;
            calculateLyricPositions();
          }
        }
      }
    });
  }
  return resizeObserver;
}

export function disconnectResizeObserver(): void {
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
}

export interface PartData {
  /**
   * Time of this part in seconds
   */
  time: number;

  /**
   * Duration of this part in seconds
   */
  duration: number;
  lyricElement: HTMLElement;
  animationStartTimeMs: number;
}

export type LineData = {
  parts: PartData[];
  isScrolled: boolean;
  isAnimationPlayStatePlaying: boolean;
  accumulatedOffsetMs: number;
  isAnimating: boolean;
  lastAnimSetupAt: number;
  isSelected: boolean;
  height: number;
  position: number;
} & PartData;

export type SyncType = "richsync" | "synced" | "none";

export interface LyricsData {
  lines: LineData[];
  syncType: SyncType;
  lyricWidth: number;
  lyricHeight: number;
  isMusicVideoSynced: boolean;
  tabSelector: HTMLElement;
  lyricsContainer: HTMLElement;
  hasNonLatin: boolean;
}

/**
 * Processes lyrics data and prepares it for rendering.
 * Sets language settings, validates data, and initiates DOM injection.
 *
 * @param data - Processed lyrics data
 * @param keepLoaderVisible
 * @param signal - AbortSignal to cancel async operations
 * @param data.language - Language code for the lyrics
 * @param data.lyrics - Array of lyric lines
 */
export function processLyrics(data: LyricSourceResultWithMeta, keepLoaderVisible = false, signal?: AbortSignal): void {
  const lyrics = data.lyrics;
  if (!lyrics || lyrics.length === 0) {
    throw new Error(NO_LYRICS_FOUND_LOG);
  }

  log(LYRICS_FOUND_LOG);

  const ytMusicLyrics = document.querySelector(NO_LYRICS_TEXT_SELECTOR)?.parentElement;
  if (ytMusicLyrics) {
    ytMusicLyrics.classList.add("blyrics-hidden");
  }

  try {
    const lyricsElement = document.getElementsByClassName(LYRICS_CLASS)[0] as HTMLElement;
    lyricsElement.replaceChildren();
  } catch (_err) {
    log(LYRICS_TAB_NOT_DISABLED_LOG);
  }

  injectLyrics(data, keepLoaderVisible, signal);
}

const TRAILING_ATTACHED_PUNCT_REGEX = /^[\p{Pe}\p{Pf}\p{Po}]+$/u;

/**
 * Fallback for issue #307: split a part whose core text exceeds the wrap threshold into smaller
 * sub-parts at natural word boundaries (via Intl.Segmenter). This creates wrap opportunities for
 * unbroken runs such as SEA-language lyrics. Duration is distributed linearly across sub-parts.
 */
function splitLongPart(part: LyricPart, threshold: number): LyricPart[] {
  let segments: string[];
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    segments = Array.from(segmenter.segment(part.words), s => s.segment);
  } catch {
    segments = Array.from(part.words);
  }

  // Combine punctuation with previous words
  segments = segments.reduce((acc, curr) => {
    if (acc.length > 0 && TRAILING_ATTACHED_PUNCT_REGEX.test(curr)) {
      acc[acc.length - 1] += curr;
    } else {
      acc.push(curr);
    }
    return acc;
  }, [] as string[]);

  const totalChars = part.words.length;
  const subParts: LyricPart[] = [];
  let charsBefore = 0;
  for (let i = 0; i < segments.length; i++) {
    const chunk = segments[i];
    const subStart = part.startTimeMs + Math.round((part.durationMs * charsBefore) / totalChars);
    const subEnd =
      i === segments.length - 1
        ? part.startTimeMs + part.durationMs
        : part.startTimeMs + Math.round((part.durationMs * (charsBefore + chunk.length)) / totalChars);
    subParts.push({
      startTimeMs: subStart,
      durationMs: subEnd - subStart,
      words: chunk,
      isBackground: part.isBackground,
      explicit: part.explicit,
    });
    charsBefore += chunk.length;
  }
  return subParts;
}

function createLyricsLine(parts: LyricPart[], line: LineData, lyricElement: HTMLDivElement) {
  // To add rtl elements in reverse to the dom
  let rtlBuffer: HTMLSpanElement[] = [];
  let isAllRtl = true;

  let lyricElementsBuffer = [] as HTMLSpanElement[];
  let lastEmittedSpan: HTMLSpanElement | null = null;
  const wrapThreshold = longWordWrapThreshold.getNumberValue();

  parts = parts.flatMap(original => {
    const parts = original.words.match(/^(\s*)([\s\S]*?)(\s*)$/u);
    let returnArray: LyricPart[] = [];
    if (parts && parts.length > 0) {
      const beginWhitespace = parts[1];
      const core = parts[2];
      const endWhitespace = parts[3];
      if (core.length === 0) {
        return [original];
      }

      if (beginWhitespace.length > 0) {
        returnArray.push({
          startTimeMs: original.startTimeMs,
          words: beginWhitespace,
          durationMs: 0,
          explicit: original.explicit,
          isBackground: original.isBackground,
        });
      }
      returnArray.push({
        startTimeMs: original.startTimeMs,
        words: core,
        durationMs: original.durationMs,
        explicit: original.explicit,
        isBackground: original.isBackground,
      });
      if (endWhitespace.length > 0) {
        returnArray.push({
          startTimeMs: original.startTimeMs + original.durationMs,
          words: endWhitespace,
          durationMs: 0,
          explicit: original.explicit,
          isBackground: original.isBackground,
        });
      }
    }
    return returnArray;
  });

  parts.forEach(originalPart => {
    if (originalPart.words.trim().length === 0) {
      if (lastEmittedSpan) {
        lastEmittedSpan.classList.add(HAS_TRAILING_SPACE_CLASS);
      }
      return;
    }

    const subParts = splitLongPart(originalPart, wrapThreshold);

    subParts.forEach((part, subIdx) => {
      const isLastSub = subIdx === subParts.length - 1;
      let isRtl = testRtl(part.words);
      if (!isRtl && part.words.trim().length > 0) {
        isAllRtl = false;
        rtlBuffer.reverse().forEach(p => {
          lyricElementsBuffer.push(p);
        });
        rtlBuffer = [];
      }

      let span = document.createElement("span");
      span.classList.add(WORD_CLASS);
      if (part.durationMs === 0) {
        span.classList.add(ZERO_DURATION_ANIMATION_CLASS);
      }
      if (isRtl) {
        span.classList.add(RTL_CLASS);
      }

      let partData: PartData = {
        time: part.startTimeMs / 1000,
        duration: part.durationMs / 1000,
        lyricElement: span,
        animationStartTimeMs: Infinity,
      };

      span.textContent = part.words;
      span.dataset.time = String(partData.time);
      span.dataset.duration = String(partData.duration);
      span.dataset.content = part.words;
      span.style.setProperty("--blyrics-duration", part.durationMs + "ms");
      if (part.durationMs > longWordThreshold.getNumberValue()) {
        span.dataset.longWord = "true";
      }
      if (part.isBackground) {
        span.classList.add(BACKGROUND_LYRIC_CLASS);
      }
      if (part.explicit) {
        span.classList.add(EXPLICIT_WORD_CLASS);
      }

      // Non-final sub-parts signal a group-flush (wrap opportunity) without a trailing-space
      // visual gap — the original text was contiguous.
      if (!isLastSub) {
        span.dataset.wrapAfter = "true";
      }

      line.parts.push(partData);

      if (isRtl) {
        rtlBuffer.push(span);
      } else {
        lyricElementsBuffer.push(span);
      }

      lastEmittedSpan = span;
    });
  });

  //Add remaining rtl elements
  if (isAllRtl && rtlBuffer.length > 0) {
    lyricElement.classList.add(RTL_CLASS);
    rtlBuffer.forEach(part => {
      lyricElementsBuffer.push(part);
    });
  } else if (rtlBuffer.length > 0) {
    rtlBuffer.reverse().forEach(part => {
      lyricElementsBuffer.push(part);
    });
  }

  groupByWordAndInsert(lyricElement, lyricElementsBuffer);
}

function createBreakElem(lyricElement: HTMLElement, order: number) {
  let breakElm: HTMLSpanElement = document.createElement("span");
  breakElm.classList.add("blyrics--break");
  breakElm.style.order = String(order);
  lyricElement.appendChild(breakElm);
}

/**
 * Injects lyrics into the DOM with timing, click handlers, and animations.
 * Creates the complete lyrics interface including synchronization support.
 *
 * @param data - Complete lyrics data object
 * @param keepLoaderVisible
 * @param signal - AbortSignal to cancel async operations
 * @param data.lyrics - Array of lyric lines with timing
 * @param [data.source] - Source attribution for lyrics
 * @param [data.sourceHref] - URL for source link
 */
function injectLyrics(data: LyricSourceResultWithMeta, keepLoaderVisible = false, signal?: AbortSignal): void {
  const injectionId = AppState.currentInjectionId;
  const isStale = () => AppState.currentInjectionId !== injectionId;

  const lyrics = data.lyrics!;
  cleanup();

  let lyricsWrapper = createLyricsWrapper();

  lyricsWrapper.replaceChildren();
  const lyricsContainer = document.createElement("div");
  lyricsContainer.className = LYRICS_CLASS;
  lyricsWrapper.appendChild(lyricsContainer);
  attachLineInteractions(lyricsContainer);

  lyricsWrapper.removeAttribute("is-empty");

  if (AppState.isTranslateEnabled) {
    log(TRANSLATION_ENABLED_LOG, AppState.translationLanguage);
  }

  const allZero = lyrics.every(item => item.startTimeMs === 0);

  if (keepLoaderVisible) {
    renderLoader(true);
  } else {
    flushLoader(allZero && lyrics[0].words !== t("lyrics_notFound"));
  }

  let lines: LineData[] = [];
  let syncType: SyncType = allZero ? "none" : "synced";

  // Pre-process all lines and add to DOM
  lyrics.forEach((lyricItem, lineIndex) => {
    if (lyricItem.isInstrumental) {
      const instrumentalElement = createInstrumentalElement(lyricItem.durationMs, lineIndex);
      instrumentalElement.classList.add("blyrics--line");
      instrumentalElement.dataset.time = String(lyricItem.startTimeMs / 1000);
      instrumentalElement.dataset.duration = String(lyricItem.durationMs / 1000);
      instrumentalElement.dataset.lineNumber = String(lineIndex);
      instrumentalElement.dataset.instrumental = "true";

      const agent = findNearestAgent(lyrics, lineIndex);
      if (agent) {
        instrumentalElement.dataset.agent = agent;
      }

      if (isNearestLyricRtl(lyrics, lineIndex)) {
        instrumentalElement.classList.add(RTL_CLASS);
      }

      if (!allZero) {
        const seekTime = lyricItem.startTimeMs / 1000;
        instrumentalElement.addEventListener("click", () => {
          log(LOG_PREFIX, `Seeking to ${seekTime.toFixed(2)}s`);
          document.dispatchEvent(new CustomEvent("blyrics-seek-to", { detail: seekTime }));
          animEngineState.scrollResumeTime = 0;
        });
      }

      const line: LineData = {
        lyricElement: instrumentalElement,
        time: lyricItem.startTimeMs / 1000,
        duration: lyricItem.durationMs / 1000,
        parts: [],
        isScrolled: false,
        animationStartTimeMs: Infinity,
        isAnimationPlayStatePlaying: false,
        accumulatedOffsetMs: 0,
        isAnimating: false,
        lastAnimSetupAt: 0,
        isSelected: false,
        height: -1,
        position: -1,
      };

      lines.push(line);
      lyricsContainer.appendChild(instrumentalElement);
      return;
    }

    if (!lyricItem.parts) {
      lyricItem.parts = [];
    }

    let item = lyricItem as Required<Pick<Lyric, "parts">> & Lyric;

    if (item.parts.length === 0 || disableRichsync.getBooleanValue()) {
      lyricItem.parts = [];
      const words = item.words.split(" ");

      words.forEach((word, index) => {
        word = word.trim().length < 1 ? word : word;
        item.parts.push({
          startTimeMs: item.startTimeMs + index * lineSyncedAnimationDelay.getNumberValue(),
          words: word,
          durationMs: 0,
        });
        item.parts.push({
          startTimeMs: item.startTimeMs + index * lineSyncedAnimationDelay.getNumberValue(),
          words: " ",
          durationMs: 0,
        });
      });
    }

    if (!item.parts.every(part => part.durationMs === 0)) {
      syncType = "richsync";
    }

    let lyricElement = document.createElement("div");
    lyricElement.classList.add("blyrics--line");

    let line: LineData = {
      lyricElement: lyricElement,
      time: item.startTimeMs / 1000,
      duration: item.durationMs / 1000,
      parts: [],
      isScrolled: false,
      animationStartTimeMs: Infinity,
      isAnimationPlayStatePlaying: false,
      accumulatedOffsetMs: 0,
      isAnimating: false,
      lastAnimSetupAt: 0,
      isSelected: false,
      height: -1,
      position: -1,
    };

    createLyricsLine(item.parts, line, lyricElement);
    createBreakElem(lyricElement, 1);

    lyricElement.dataset.time = String(line.time);
    lyricElement.dataset.duration = String(line.duration);
    lyricElement.dataset.lineNumber = String(lineIndex);
    lyricElement.style.setProperty("--blyrics-duration", item.durationMs + "ms");
    if (item.agent) {
      lyricElement.dataset.agent = item.agent;
    }

    if (!allZero) {
      const seekFromEvent = (e: MouseEvent, requireGutter: boolean): void => {
        const target = e.target as HTMLElement;
        const container = lyricElement.closest(`.${LYRICS_CLASS}`) as HTMLElement | null;
        const isRichsync = container?.dataset.sync === "richsync";
        const isWordSeek = isRichsync && e.altKey;

        // Single click only seeks from the leading-edge gutter, so the rest of the
        // line stays free for selecting text; Alt+click and double-click seek from
        // anywhere on the line.
        if (requireGutter && !isWordSeek && (hasActiveTextSelection() || !isInSeekGutter(lyricElement, e.clientX))) {
          return;
        }

        let seekTime: number;
        if (isRichsync && e.altKey) {
          let wordElement = target.closest(`.${WORD_CLASS}`) as HTMLElement | null;

          if (!wordElement) {
            const words = lyricElement.querySelectorAll(`.${WORD_CLASS}`);
            let closestDist = Infinity;
            words.forEach(word => {
              const rect = word.getBoundingClientRect();
              const centerX = rect.left + rect.width / 2;
              const centerY = rect.top + rect.height / 2;
              const dist = Math.hypot(e.clientX - centerX, e.clientY - centerY);
              if (dist < closestDist) {
                closestDist = dist;
                wordElement = word as HTMLElement;
              }
            });
          }

          if (!wordElement) return;
          seekTime = parseFloat(wordElement.dataset.time || "0");
        } else {
          seekTime = parseFloat(lyricElement.dataset.time || "0");
        }

        log(LOG_PREFIX, `Seeking to ${seekTime.toFixed(2)}s`);
        document.dispatchEvent(new CustomEvent("blyrics-seek-to", { detail: seekTime }));
        animEngineState.scrollResumeTime = 0;
      };

      lyricElement.addEventListener("click", e => seekFromEvent(e, true));
      // Double-click anywhere on the line seeks too; drop the word selection the
      // double-click just made so it doesn't get copied.
      lyricElement.addEventListener("dblclick", e => {
        seekFromEvent(e, false);
        window.getSelection()?.removeAllRanges();
      });
    } else {
      // Unsynced lyrics cannot be seeked, so there is no gutter at all.
      lyricElement.dataset.noSeek = "true";
    }

    lines.push(line);
    lyricsContainer.appendChild(lyricElement);
  });

  // Handle Translations and Romanizations in Batch
  processBatchTranslationsAndRomanizations(data, lines, isStale, signal, keepLoaderVisible);

  animEngineState.skipScrolls = 2;
  animEngineState.skipScrollsDecayTimes = [];
  for (let i = 0; i < animEngineState.skipScrolls; i++) {
    animEngineState.skipScrollsDecayTimes.push(Date.now() + 2000);
  }
  animEngineState.scrollResumeTime = 0;

  const tabSelector = document.getElementsByClassName(TAB_HEADER_CLASS)[1] as HTMLElement;

  let lyricsData = {
    lines: lines,
    syncType: syncType,
    lyricWidth: lyricsContainer.clientWidth,
    lyricHeight: lyricsContainer.clientHeight,
    isMusicVideoSynced: data.musicVideoSynced === true,
    tabSelector,
    lyricsContainer,
    hasNonLatin: lyrics.some(item => !!item.words && containsNonLatin(item.words)),
  };

  if (data.segmentMap) {
    applySegmentMapToLyrics(lyricsData, data.segmentMap);
  }

  if (lyrics[0].words !== t("lyrics_notFound")) {
    // Set before addFooter so the dock controls read the current song's lyric data.
    AppState.lyricData = lyricsData;
    const unisonData =
      data.source === "Unison" && "unisonData" in data ? (data as { unisonData: UnisonData }).unisonData : undefined;
    addFooter(
      data.source,
      data.sourceHref,
      data.song,
      data.artist,
      data.album,
      data.duration,
      data.providerKey,
      data.videoId,
      unisonData,
      syncType === "none"
    );
  } else {
    AppState.lyricData = null;
    addNoLyricsButton(data.song, data.artist, data.album, data.duration, data.videoId);
  }

  lyricsContainer.dataset.sync = syncType;
  lyricsContainer.dataset.loaderVisible = String(keepLoaderVisible);
  if (lyrics[0].words === t("lyrics_notFound")) {
    lyricsContainer.dataset.noLyrics = "true";
  }

  AppState.areLyricsTicking = true;
  calculateLyricPositions();
  getResizeObserver().observe(lyricsWrapper);
  if (allZero) {
    log(SYNC_DISABLED_LOG);
  }

  AppState.areLyricsLoaded = true;
}

/**
 * Handles batch translation and romanization processing.
 */
async function processBatchTranslationsAndRomanizations(
  data: LyricSourceResultWithMeta,
  linesData: LineData[],
  isStale: () => boolean,
  signal?: AbortSignal,
  // Placeholder lyrics shown while the real (synced) ones load: they are replaced
  // moments later, so skip the LLM passes that would only burn quota on them.
  isTemporary = false
): Promise<void> {
  const lyrics = data.lyrics!;
  const targetTranslationLang = AppState.translationLanguage;
  const isRomanizationEnabled = AppState.isRomanizationEnabled;
  const isTranslateEnabled = AppState.isTranslateEnabled;

  const romanizationBatch: { index: number; text: string }[] = [];
  const translationBatch: { index: number; text: string }[] = [];
  // Every translatable line, in order - the "Best" (LLM) pass re-translates the
  // whole song at once for cross-line context, then swaps its lines in.
  const llmTranslationLines: { index: number; text: string; official: boolean }[] = [];
  // Japanese lines: furigana instead of romaji. We still route them through the
  // romanization batch (it fills the reading cache), then convert that romaji to
  // kana; kuromoji is the offline fallback.
  const furiganaLines: { index: number; lineData: LineData; text: string }[] = [];
  setSongFuriganaOverrides([]);

  let sourceLanguage = data.language;
  // Lyrics already in the user's default (target) language need no romanization.
  // The setting stays on - it just doesn't apply to this song.
  const isDefaultLanguage = !!sourceLanguage && langCodesMatch(targetTranslationLang, sourceLanguage);

  // If any line has kana the whole song is Japanese, even if detection said
  // otherwise - so its kanji-only lines also get furigana rather than romaji.
  const songIsJapanese = lyrics.some(item => !item.isInstrumental && hasKana(item.words));
  const furiganaSourceLang = songIsJapanese ? "ja" : sourceLanguage;

  // 1. Identify what needs to be translated/romanized
  lyrics.forEach((item, index) => {
    if (item.isInstrumental) return;

    const lineData = linesData[index];
    const lyricElement = lineData.lyricElement;

    // --- Romanization ---
    const isLanguageDisabledForRomanization = sourceLanguage && isRomanizationDisabledForLang(sourceLanguage);
    // A Japanese song still gets furigana even if the detected language is on the
    // romanization block list (detection can be wrong; kana can't).
    if (
      isRomanizationEnabled &&
      (songIsJapanese || !isLanguageDisabledForRomanization) &&
      shouldFurigana(item.words, furiganaSourceLang)
    ) {
      furiganaLines.push({ index, lineData, text: item.words });
      // Pull romaji through the batch so its cache fills; the furigana pass after
      // Promise.all reads it back and cross-checks against kuromoji.
      if (!item.romanization && !getRomanizationFromCache(item.words)) {
        romanizationBatch.push({ index, text: item.words });
      }
    } else if (isRomanizationEnabled && !isLanguageDisabledForRomanization && !isDefaultLanguage) {
      let romanizedResult: string | null = null;
      let timedRomanization: LyricPart[] | null = null;

      if (item.romanization) {
        romanizedResult = item.romanization;
        timedRomanization = item.timedRomanization || null;
      } else {
        romanizedResult = getRomanizationFromCache(item.words);
      }

      if (romanizedResult && !isSameText(romanizedResult, item.words)) {
        injectRomanization(lyricElement, lineData, romanizedResult, timedRomanization);
      } else {
        const shouldRomanize =
          (sourceLanguage && languageMatchesAny(sourceLanguage, ROMANIZATION_LANGUAGES)) ||
          containsNonLatin(item.words);
        if (shouldRomanize || !sourceLanguage) {
          const detectedLang = detectNonLatinLanguage(item.words);
          if (!detectedLang || !isRomanizationDisabledForLang(detectedLang)) {
            romanizationBatch.push({ index, text: item.words });
          }
        }
      }
    }

    // --- Translation ---
    const isSourceLangDisabled = !!sourceLanguage && isTranslationDisabledForLang(sourceLanguage);

    if (isTranslateEnabled && !isSourceLangDisabled) {
      let translationResult: string | null = null;

      const matchedLang =
        item.translations && Object.keys(item.translations).find(lang => langCodesMatch(targetTranslationLang, lang));
      const hasOfficial =
        !!(item.translations && matchedLang) ||
        !!(item.translation && langCodesMatch(targetTranslationLang, item.translation.lang));
      if (item.translations && matchedLang) {
        translationResult = item.translations[matchedLang];
      } else if (item.translation && langCodesMatch(targetTranslationLang, item.translation.lang)) {
        translationResult = item.translation.text;
      } else {
        const cached = getTranslationFromCache(item.words, targetTranslationLang);
        translationResult = cached?.translatedText || null;
      }

      llmTranslationLines.push({ index, text: item.words, official: hasOfficial });

      if (translationResult && !isSameText(translationResult, item.words)) {
        injectTranslation(lyricElement, translationResult);
      } else if (sourceLanguage !== targetTranslationLang || containsNonLatin(item.words) || !sourceLanguage) {
        translationBatch.push({ index, text: item.words });
      }
    }
  });

  if (isStale()) return;

  // Ask the LLM for the sung readings while the batches below are in flight; the
  // answer is swapped in over the local furigana once that is on screen.
  const llmFuriganaRequest =
    furiganaLines.length > 0 && AppState.isLlmFuriganaEnabled && !isTemporary
      ? getLlmConfig()
          .then(cfg =>
            cfg
              ? furiganaWithLlm(
                  furiganaLines.map(l => l.text),
                  cfg,
                  signal
                )
              : null
          )
          .catch(() => null)
      : Promise.resolve(null);

  // 2. Perform Batch Requests
  const promises: Promise<void>[] = [];

  if (romanizationBatch.length > 0) {
    promises.push(
      (async () => {
        const response = await romanizeBatch({
          lines: romanizationBatch.map(b => b.text),
          sourceLanguage: sourceLanguage || "auto",
          signal,
        });
        if (isStale()) return;

        if (!sourceLanguage && response.detectedLanguage) {
          sourceLanguage = response.detectedLanguage;
          log(LOG_PREFIX, "Determined language via romanization batch: " + sourceLanguage);
        }

        if (isRomanizationDisabledForLang(sourceLanguage || "")) return;

        const furiganaIndices = new Set(furiganaLines.map(f => f.index));
        response.results.forEach((result, i) => {
          if (result && !furiganaIndices.has(romanizationBatch[i].index)) {
            const originalIndex = romanizationBatch[i].index;
            injectRomanization(linesData[originalIndex].lyricElement, linesData[originalIndex], result);
          }
        });
        lyricsElementAdded();
      })()
    );
  }

  if (translationBatch.length > 0) {
    promises.push(
      (async () => {
        const contextLine = (i: number): string | undefined => {
          const l = lyrics[i];
          return l && !l.isInstrumental ? l.words : undefined;
        };
        const response = await translateBatch({
          lines: translationBatch.map(b => b.text),
          neighbors: translationBatch.map(b => ({
            prev: contextLine(b.index - 1),
            next: contextLine(b.index + 1),
          })),
          targetLanguage: targetTranslationLang,
          sourceLanguage: sourceLanguage || undefined,
          signal,
        });
        if (isStale()) return;

        if (!sourceLanguage && response.detectedLanguage) {
          sourceLanguage = response.detectedLanguage;
          log(LOG_PREFIX, "Determined language via translation batch: " + sourceLanguage);
        }

        if (isTranslationDisabledForLang(sourceLanguage || "")) return;

        response.results.forEach((result, i) => {
          if (result) {
            const originalIndex = translationBatch[i].index;
            injectTranslation(linesData[originalIndex].lyricElement, result.translatedText);
          }
        });
        lyricsElementAdded();
      })()
    );
  }

  await Promise.all(promises);

  // "Best" quality: re-translate the whole song through the user's LLM for
  // cross-line context, then swap the improved lines in over the Google ones.
  // Silently no-ops when the mode is off / no API key / the request fails.
  const swapInLlmTranslation = async (): Promise<void> => {
    if (
      isTemporary ||
      !isTranslateEnabled ||
      llmTranslationLines.length === 0 ||
      isStale() ||
      (sourceLanguage && isTranslationDisabledForLang(sourceLanguage))
    ) {
      return;
    }
    const cfg = await getLlmConfig();
    if (!cfg || isStale()) return;

    const texts = llmTranslationLines.map(l => l.text);
    const improved = await translateLinesWithLlm(texts, targetTranslationLang, sourceLanguage, cfg, signal);
    if (isStale()) return;

    let applied = 0;
    improved.forEach((translated, i) => {
      const line = llmTranslationLines[i];
      if (!translated || line.official || isSameText(translated, line.text)) return;
      upsertTranslation(linesData[line.index].lyricElement, translated);
      applied++;
    });
    if (applied > 0) lyricsElementAdded();

    // Second pass: give the model the drafts back to be rewritten as natural
    // spoken language, then swap the revised lines in over the first-pass ones.
    if (!AppState.isLlmRevisionEnabled) return;
    const drafts = improved.map((translated, i) => {
      const line = llmTranslationLines[i];
      return translated && !line.official && !isSameText(translated, line.text) ? translated : null;
    });
    const revised = await reviseTranslationWithLlm(texts, drafts, targetTranslationLang, cfg, signal);
    if (isStale()) return;

    let revisedCount = 0;
    revised.forEach((text, i) => {
      if (!text || !drafts[i] || text === drafts[i] || isSameText(text, llmTranslationLines[i].text)) return;
      upsertTranslation(linesData[llmTranslationLines[i].index].lyricElement, text);
      revisedCount++;
    });
    if (revisedCount > 0) lyricsElementAdded();
  };
  // Started now so the round trip overlaps the local furigana pass below.
  const llmTranslationTask = swapInLlmTranslation();

  if (furiganaLines.length > 0) {
    setSongFuriganaOverrides(
      AppState.furiganaSource === "utaten" ? await getUtatenOverrides(data.song, data.artist, signal) : []
    );
    if (isStale()) return;
    for (const { lineData, text } of furiganaLines) {
      const el = lineData.lyricElement;
      const romaji = getRomanizationFromCache(text);
      // With romaji: align it and cross-check against kuromoji. Without: kuromoji
      // only. Both no-op if the line already has furigana.
      const done = romaji ? await annotateFuriganaFromRomaji(el, text, romaji) : false;
      if (!done) await annotateFurigana(el, text);
    }
    lyricsElementAdded();
  }

  // AI furigana: everything above stays as the first answer; once the LLM's
  // sung readings arrive they quietly replace the lines they differ on.
  const pairsByLine = await llmFuriganaRequest;
  if (pairsByLine && !isStale()) {
    let changed = 0;
    furiganaLines.forEach(({ lineData, text }, i) => {
      if (applyLlmFurigana(lineData.lyricElement, text, pairsByLine[i] ?? [])) changed++;
    });
    if (changed > 0) lyricsElementAdded();
  }

  await llmTranslationTask;
}

/** Replace the translation row's text in place, or add it if not present yet. */
function upsertTranslation(lyricElement: HTMLElement, text: string): void {
  const existing = lyricElement.querySelector<HTMLElement>(`.${TRANSLATED_LYRICS_CLASS}`);
  if (existing) {
    if (existing.textContent !== text) existing.textContent = text;
    return;
  }
  injectTranslation(lyricElement, text);
}

function injectRomanization(
  lyricElement: HTMLElement,
  lineData: LineData,
  text: string,
  timedRomanization: LyricPart[] | null = null
) {
  if (lyricElement.querySelector(`.${ROMANIZED_LYRICS_CLASS}`)) return;

  // Negative order puts the romanization above the lyric, furigana style.
  createBreakElem(lyricElement, -1);
  const romanizedLine = document.createElement("div");
  romanizedLine.classList.add(ROMANIZED_LYRICS_CLASS);
  romanizedLine.style.order = "-2";

  if (timedRomanization && timedRomanization.length > 0 && !disableRichsync.getBooleanValue()) {
    createLyricsLine(timedRomanization, lineData, romanizedLine);
  } else {
    romanizedLine.textContent = text;
  }
  lyricElement.appendChild(romanizedLine);
}

function injectTranslation(lyricElement: HTMLElement, text: string) {
  if (lyricElement.querySelector(`.${TRANSLATED_LYRICS_CLASS}`)) return;

  createBreakElem(lyricElement, 6);
  const translatedLine = document.createElement("div");
  translatedLine.classList.add(TRANSLATED_LYRICS_CLASS);
  translatedLine.style.order = "7";
  translatedLine.textContent = text;
  lyricElement.appendChild(translatedLine);
}

export function calculateLyricPositions() {
  setExtraHeight();
  if (AppState.lyricData && AppState.areLyricsTicking) {
    const lyricsElement = document.getElementsByClassName(LYRICS_CLASS)[0] as HTMLElement;

    const data = AppState.lyricData;
    data.lyricWidth = lyricsElement.clientWidth;

    data.lines.forEach(line => {
      let bounds = getRelativeBounds(lyricsElement, line.lyricElement);
      line.position = bounds.y;
      line.height = bounds.height;
    });
    animEngineState.wasUserScrolling = true; // trigger rescrolls
    resizeCanvas();
  }
}

/**
 * Take elements from the buffer and group them together to control where wrapping happens
 * @param lyricElement element to push to
 * @param lyricElementsBuffer elements to add
 */
function groupByWordAndInsert(lyricElement: HTMLDivElement, lyricElementsBuffer: HTMLSpanElement[]) {
  let wordGroupBuffer = [] as HTMLSpanElement[];
  let isCurrentBufferBg = false;

  const pushWordGroupBuffer = () => {
    if (wordGroupBuffer.length > 0) {
      let span = document.createElement("span");
      wordGroupBuffer.forEach(word => {
        span.appendChild(word);
      });

      if (isCurrentBufferBg) {
        span.classList.add(BACKGROUND_LYRIC_CLASS);
      }

      lyricElement.appendChild(span);
      wordGroupBuffer = [];
    }
  };

  lyricElementsBuffer.forEach(part => {
    const partIsBg = part.classList.contains(BACKGROUND_LYRIC_CLASS);
    const isNonMatchingType = isCurrentBufferBg !== partIsBg;
    const hasTrailingSpace = part.classList.contains(HAS_TRAILING_SPACE_CLASS);
    const wrapAfter = part.dataset.wrapAfter === "true";

    if (isNonMatchingType) {
      pushWordGroupBuffer();
      isCurrentBufferBg = partIsBg;
    }
    wordGroupBuffer.push(part);

    if (hasTrailingSpace || wrapAfter) {
      pushWordGroupBuffer();
    }
  });

  pushWordGroupBuffer();
}

/**
 * Compares strings without care for punctuation or capitalization
 * @param str1
 * @param str2
 */
function isSameText(str1: string, str2: string): boolean {
  str1 = str1
    .toLowerCase()
    .replaceAll(/(\p{P})/gu, "")
    .trim();
  str2 = str2
    .toLowerCase()
    .replaceAll(/(\p{P})/gu, "")
    .trim();

  return str1 === str2;
}
