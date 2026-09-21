import { TRANSLATE_IN_ROMAJI, TRANSLATE_LYRICS_URL, TRANSLATION_ERROR_LOG, UNISON_TRANSLATE_URL } from "@constants";
import { logCore } from "@core/logger";

interface TranslationResult {
  originalLanguage: string;
  translatedText: string;
}

interface TranslationCache {
  romanization: Map<string, string>;
  translation: Map<string, TranslationResult>;
}

const cache: TranslationCache = {
  romanization: new Map(),
  translation: new Map(),
};

interface BatchRequest {
  lines: string[];
  targetLanguage?: string; // For translations
  sourceLanguage?: string; // For romanizations
  videoId?: string;
  signal?: AbortSignal;
}

interface BatchTranslationResponse {
  results: (TranslationResult | null)[];
  detectedLanguage: string;
}

interface BatchRomanizationResponse {
  results: (string | null)[];
  detectedLanguage: string;
}

const BATCH_SEPARATOR = "\n\n;\n\n";
/**
 * Translation batches join lines with a bare newline: Google preserves it far
 * more reliably than a punctuation sentinel, and sending the lines as one
 * paragraph lets the model use the surrounding lines as context (subjects,
 * pronouns and tense that a lyric line rarely carries on its own).
 */
const LINE_SEPARATOR = "\n";
const MAX_URL_LENGTH = 15000;

interface UnisonTranslateLine {
  translation: string | null;
  romanization: string | null;
  needsTranslation: boolean;
}

const inFlightUnison = new Map<string, Promise<string | undefined>>();

// Coalesce the concurrent translate and romanize passes so a song hits /translate once, not twice.
function enrichViaUnison(
  items: { index: number; text: string }[],
  to: string,
  from: string | undefined,
  videoId: string | undefined,
  signal?: AbortSignal
): Promise<string | undefined> {
  if (items.length === 0) return Promise.resolve(undefined);
  const body = JSON.stringify({ lines: items.map(item => item.text), to, from, videoId });
  const existing = inFlightUnison.get(body);
  if (existing) return existing;
  const request = fetchUnison(body, items, to, signal);
  inFlightUnison.set(body, request);
  return request.finally(() => inFlightUnison.delete(body));
}

async function fetchUnison(
  body: string,
  items: { index: number; text: string }[],
  to: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  try {
    const response = await fetch(UNISON_TRANSLATE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal,
    });
    if (!response.ok) return;
    const data = (await response.json()) as { lines: UnisonTranslateLine[]; detectedLang: string };
    if (!Array.isArray(data.lines) || data.lines.length !== items.length) return;

    items.forEach((item, i) => {
      const line = data.lines[i];
      const lower = item.text.toLowerCase();
      if (line?.translation && line.needsTranslation && line.translation.toLowerCase() !== lower) {
        cache.translation.set(cacheKeyFor(to, item.text), {
          originalLanguage: data.detectedLang || "",
          translatedText: line.translation,
        });
      }
      if (line?.romanization && line.romanization.toLowerCase() !== lower) {
        cache.romanization.set(item.text, line.romanization);
      }
    });
    return data.detectedLang || undefined;
  } catch (error) {
    if ((error as Error).name !== "AbortError") {
      logCore(TRANSLATION_ERROR_LOG, error);
    }
  }
}

type Neighbor = { prev?: string; next?: string } | undefined;

interface TranslateBatchRequest {
  lines: string[];
  targetLanguage?: string;
  /** Detected source language, if already known - pins `sl` instead of `auto`. */
  sourceLanguage?: string;
  /** Parallel to `lines`: the immediately surrounding lines, for context. */
  neighbors?: Neighbor[];
  videoId?: string;
  signal?: AbortSignal;
}

/**
 * Key chorus / refrain lines onto one cache entry: case-, quote- and
 * trailing-punctuation-insensitive, so near-identical repeats translate once and
 * stay consistent.
 */
function normalizeCacheKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”"'‘’`「」『』（）()[\]【】]/g, "")
    .replace(/[.,!?;:…、。！？·・]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

const cacheKeyFor = (targetLanguage: string, text: string): string =>
  `${targetLanguage}\u001f${normalizeCacheKey(text)}`;

/** Concatenate the sentence chunks Google returns in data[0]. */
function joinTranslatedParts(data: unknown): string {
  const parts = (data as [string[][], ...unknown[]])?.[0];
  if (!Array.isArray(parts)) return "";
  let out = "";
  for (const part of parts) {
    if (part?.[0]) out += part[0];
  }
  return out;
}

const splitLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

async function fetchTranslation(
  targetLanguage: string,
  sourceLanguage: string,
  text: string,
  signal?: AbortSignal
): Promise<unknown> {
  const url = TRANSLATE_LYRICS_URL(targetLanguage, text, toGoogleSourceLanguage(sourceLanguage));
  const response = await fetch(url, { cache: "force-cache", signal });
  return response.json();
}

/**
 * Google's `sl` takes a bare language code (en, ja): a regional tag from a lyrics
 * provider's metadata (en-US, en-GB) is not recognised and the request fails, so
 * the whole song goes untranslated. Chinese keeps its script variant, which
 * Google does accept.
 */
function toGoogleSourceLanguage(lang: string): string {
  if (!lang || lang === "auto") return "auto";
  if (/^zh-(cn|tw)$/i.test(lang)) return lang;
  return lang.split("-")[0];
}

function commitTranslation(
  results: (TranslationResult | null)[],
  targetLanguage: string,
  item: { index: number; text: string },
  translated: string | undefined,
  detectedLanguage: string
): void {
  const trimmed = translated?.trim();
  if (!trimmed || trimmed.toLowerCase() === item.text.toLowerCase()) return;
  const result: TranslationResult = { originalLanguage: detectedLanguage || "", translatedText: trimmed };
  cache.translation.set(cacheKeyFor(targetLanguage, item.text), result);
  results[item.index] = result;
}

/**
 * Translate one line on its own, giving Google its neighbours as context and
 * keeping only the middle line back. Used when a batch response can't be split
 * 1:1 - this path always maps exactly one translation to one line.
 */
async function translateOneLine(
  targetLanguage: string,
  sourceLanguage: string,
  text: string,
  neighbor: Neighbor,
  signal?: AbortSignal
): Promise<string | null> {
  const prev = neighbor?.prev?.trim();
  const next = neighbor?.next?.trim();
  try {
    if (prev || next) {
      const windowLines = [prev, text, next].filter(Boolean) as string[];
      const data = await fetchTranslation(targetLanguage, sourceLanguage, windowLines.join(LINE_SEPARATOR), signal);
      const parts = splitLines(joinTranslatedParts(data));
      const mid = prev ? 1 : 0;
      if (parts.length === windowLines.length && parts[mid]) return parts[mid];
    }
    const solo = await fetchTranslation(targetLanguage, sourceLanguage, text, signal);
    return joinTranslatedParts(solo).trim() || null;
  } catch (error) {
    if ((error as Error).name !== "AbortError") logCore(TRANSLATION_ERROR_LOG, error);
    return null;
  }
}

async function translateChunk(
  chunk: { index: number; text: string }[],
  targetLanguage: string,
  sourceLanguage: string,
  neighbors: Neighbor[] | undefined,
  results: (TranslationResult | null)[],
  signal?: AbortSignal
): Promise<string> {
  let detected = "";
  try {
    const combined = chunk.map(item => item.text).join(LINE_SEPARATOR);
    const data = await fetchTranslation(targetLanguage, sourceLanguage, combined, signal);
    detected = (data as [unknown, unknown, string?])?.[2] || "";

    const full = joinTranslatedParts(data);
    let split = splitLines(full);
    if (split.length !== chunk.length) {
      // Second try: the old semicolon sentinel, in case Google kept that instead.
      const bySentinel = full
        .split(BATCH_SEPARATOR)
        .map(s => s.trim())
        .filter(Boolean);
      split = bySentinel.length === chunk.length ? bySentinel : [];
    }

    if (split.length === chunk.length) {
      chunk.forEach((item, i) => commitTranslation(results, targetLanguage, item, split[i], detected));
      return detected;
    }
    logCore(
      TRANSLATION_ERROR_LOG,
      `Batch translation split mismatch (expected ${chunk.length}); falling back to per-line.`
    );
  } catch (error) {
    if ((error as Error).name === "AbortError") return "";
    logCore(TRANSLATION_ERROR_LOG, error);
  }

  for (const item of chunk) {
    if (signal?.aborted) break;
    const line = await translateOneLine(
      targetLanguage,
      sourceLanguage || detected,
      item.text,
      neighbors?.[item.index],
      signal
    );
    if (line) commitTranslation(results, targetLanguage, item, line, sourceLanguage || detected);
  }
  return detected;
}

/**
 * Translates a batch of lyric lines, chunked to fit the request URL. Lines are
 * sent as one newline-joined paragraph so each is translated in context; if the
 * response can't be realigned to the input, the chunk is retried line by line.
 */
export async function translateBatch(request: TranslateBatchRequest): Promise<BatchTranslationResponse> {
  const { lines, targetLanguage, neighbors, signal } = request;
  if (!targetLanguage || lines.length === 0) {
    return { results: lines.map(() => null), detectedLanguage: "" };
  }

  let sourceLanguage = request.sourceLanguage && request.sourceLanguage !== "auto" ? request.sourceLanguage : "";

  const results: (TranslationResult | null)[] = new Array(lines.length).fill(null);
  let toTranslate: { index: number; text: string }[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "♪") return;

    const cached = cache.translation.get(cacheKeyFor(targetLanguage, trimmed));
    if (cached) {
      results[index] = cached;
    } else {
      toTranslate.push({ index, text: trimmed });
    }
  });

  if (toTranslate.length === 0) {
    return {
      results,
      detectedLanguage: sourceLanguage || results.find(r => r !== null)?.originalLanguage || "",
    };
  }

  const unisonLang = await enrichViaUnison(
    toTranslate,
    targetLanguage,
    sourceLanguage || undefined,
    request.videoId,
    signal
  );
  toTranslate = toTranslate.filter(({ index, text }) => {
    const hit = cache.translation.get(cacheKeyFor(targetLanguage, text));
    if (hit) {
      results[index] = hit;
      return false;
    }
    return true;
  });
  if (toTranslate.length === 0) {
    return { results, detectedLanguage: sourceLanguage || results.find(r => r !== null)?.originalLanguage || unisonLang || "" };
  }

  // Chunk by request URL length.
  const chunks: { index: number; text: string }[][] = [];
  let currentChunk: { index: number; text: string }[] = [];
  let currentEncodedLength = 0;

  const baseUrl = TRANSLATE_LYRICS_URL(targetLanguage, "");
  const separatorEncoded = encodeURIComponent(LINE_SEPARATOR);

  for (const item of toTranslate) {
    const itemEncoded = encodeURIComponent(item.text);
    const addedLength = (currentChunk.length > 0 ? separatorEncoded.length : 0) + itemEncoded.length;

    if (currentChunk.length > 0 && baseUrl.length + currentEncodedLength + addedLength > MAX_URL_LENGTH) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentEncodedLength = 0;
    }

    currentChunk.push(item);
    currentEncodedLength += (currentChunk.length > 1 ? separatorEncoded.length : 0) + itemEncoded.length;
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  for (const chunk of chunks) {
    const detected = await translateChunk(chunk, targetLanguage, sourceLanguage, neighbors, results, signal);
    if (!sourceLanguage && detected) sourceLanguage = detected;
  }

  return { results, detectedLanguage: sourceLanguage };
}

/**
 * Romanizes a batch of lyric lines in a single request, chunked if necessary.
 */
export async function romanizeBatch(request: BatchRequest): Promise<BatchRomanizationResponse> {
  const { lines, sourceLanguage, signal } = request;
  if (lines.length === 0) {
    return { results: lines.map(() => null), detectedLanguage: "" };
  }

  const results: (string | null)[] = new Array(lines.length).fill(null);
  let toRomanize: { index: number; text: string }[] = [];

  // Check cache first
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "♪") return;

    if (cache.romanization.has(trimmed)) {
      results[index] = cache.romanization.get(trimmed)!;
    } else {
      toRomanize.push({ index, text: trimmed });
    }
  });

  if (toRomanize.length === 0) {
    return { results, detectedLanguage: sourceLanguage || "auto" };
  }

  let detectedLanguage = sourceLanguage || "auto";

  const unisonLang = await enrichViaUnison(
    toRomanize,
    request.targetLanguage || "en",
    sourceLanguage,
    request.videoId,
    signal
  );
  if (unisonLang) {
    detectedLanguage = unisonLang;
  }
  toRomanize = toRomanize.filter(({ index, text }) => {
    const hit = cache.romanization.get(text);
    if (hit) {
      results[index] = hit;
      return false;
    }
    return true;
  });
  if (toRomanize.length === 0) {
    return { results, detectedLanguage };
  }

  // Chunk toRomanize based on URL length limits
  const chunks: { index: number; text: string }[][] = [];
  let currentChunk: { index: number; text: string }[] = [];
  let currentEncodedLength = 0;

  const lang = sourceLanguage || "auto";
  const baseUrl = TRANSLATE_IN_ROMAJI(lang, "");
  const separatorEncoded = encodeURIComponent(BATCH_SEPARATOR);

  for (const item of toRomanize) {
    const itemEncoded = encodeURIComponent(item.text);
    const addedLength = (currentChunk.length > 0 ? separatorEncoded.length : 0) + itemEncoded.length;

    if (currentChunk.length > 0 && baseUrl.length + currentEncodedLength + addedLength > MAX_URL_LENGTH) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentEncodedLength = 0;
    }

    currentChunk.push(item);
    currentEncodedLength += (currentChunk.length > 1 ? separatorEncoded.length : 0) + itemEncoded.length;
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  for (const chunk of chunks) {
    try {
      const combinedText = chunk.map(item => item.text).join(BATCH_SEPARATOR);
      const url = TRANSLATE_IN_ROMAJI(lang, combinedText);

      const response = await fetch(url, { cache: "force-cache", signal });
      const data = await response.json();

      detectedLanguage = data[2] || detectedLanguage;

      let fullRomanizedText = "";
      for (const part of data[0]) {
        if (!part) continue;
        const romanized = part[3] || part[2];
        if (romanized) {
          fullRomanizedText += romanized;
        }
      }

      let romanizedLines = fullRomanizedText.split(BATCH_SEPARATOR);

      // Fallback: If Google merged the romanizations into fewer blocks than expected
      if (romanizedLines.length < chunk.length) {
        const semicolonSplit = fullRomanizedText.split(";").filter(l => l.trim().length > 0);
        if (semicolonSplit.length === chunk.length) {
          romanizedLines = semicolonSplit;
        } else {
          const singleNewlineSplit = fullRomanizedText.split(/\r?\n/).filter(l => l.trim().length > 0);
          if (singleNewlineSplit.length === chunk.length) {
            romanizedLines = singleNewlineSplit;
          } else if (romanizedLines.length === 1 && chunk.length > 1) {
            logCore(
              TRANSLATION_ERROR_LOG,
              `Batch romanization failed to split: expected ${chunk.length} lines, got 1.`
            );
            romanizedLines = [];
          }
        }
      }

      chunk.forEach((item, i) => {
        const romanizedText = romanizedLines[i]?.trim();
        if (romanizedText && romanizedText.toLowerCase() !== item.text.toLowerCase()) {
          cache.romanization.set(item.text, romanizedText);
          results[item.index] = romanizedText;
        }
      });
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        logCore(TRANSLATION_ERROR_LOG, error);
      }
    }
  }

  return { results, detectedLanguage };
}

export function clearCache(): void {
  cache.romanization.clear();
  cache.translation.clear();
}

export function getTranslationFromCache(text: string, targetLanguage: string): TranslationResult | null {
  return cache.translation.get(cacheKeyFor(targetLanguage, text)) || null;
}

export function getRomanizationFromCache(text: string): string | null {
  return cache.romanization.get(text.trim()) || null;
}
