/**
 * Opt-in "Best" translation: hand the whole song to a user-configured LLM so
 * every line is translated in the context of the rest, with a prompt that asks
 * for natural, singable phrasing instead of the literal gloss a per-line MT
 * gives. Falls back silently (returns nulls) whenever anything is missing or
 * fails - the Google pass has already populated the lines by then.
 *
 * The API key lives in chrome.storage.local (never synced); provider/model come
 * from AppState. Direct fetch from the content script, matching translation.ts.
 */
import { LOG_PREFIX, TRANSLATION_ERROR_LOG } from "@constants";
import { AppState } from "@core/appState";
import { log } from "@utils";

// Deliberately not "blyrics_"-prefixed: clearCache() and the low-space cleanup in
// the CSS editor delete every blyrics_* key, which would wipe the user's API key.
const API_KEY_STORAGE_KEY = "llmApiKey";
const LEGACY_API_KEY_STORAGE_KEY = "blyrics_llm_api_key";
const SONG_CACHE_KEY = "blyrics_llm_translation_cache";
const SONG_CACHE_MAX = 300;

type LlmProvider = "openai" | "anthropic" | "gemini";

interface LlmConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
}

const DEFAULT_MODEL: Record<LlmProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  // Cheapest/fastest Flash tier - good enough for lyric translation. Override in
  // the Model field for a newer or auto-tracking model (e.g. gemini-3.6-flash,
  // gemini-flash-latest).
  gemini: "gemini-3.5-flash-lite",
};

const PROVIDERS = new Set<LlmProvider>(["openai", "anthropic", "gemini"]);

/**
 * Resolves the active LLM config, or null when "Best" mode is off / no key is
 * stored. Reads the key straight from local storage so it never rides in the
 * settings message.
 */
export async function getLlmConfig(): Promise<LlmConfig | null> {
  if (AppState.translationQuality !== "best") return null;
  let apiKey = "";
  try {
    const stored = await chrome.storage.local.get([API_KEY_STORAGE_KEY, LEGACY_API_KEY_STORAGE_KEY]);
    apiKey = String(stored?.[API_KEY_STORAGE_KEY] || stored?.[LEGACY_API_KEY_STORAGE_KEY] || "").trim();
  } catch {
    return null;
  }
  if (!apiKey) return null;

  const provider = (
    PROVIDERS.has(AppState.llmProvider as LlmProvider) ? AppState.llmProvider : "openai"
  ) as LlmProvider;
  const model = (AppState.llmModel || "").trim() || DEFAULT_MODEL[provider];
  return { provider, model, apiKey };
}

// -- Prompt -------------------------------------------------------------------

/** The user's own instructions, appended after the built-in rules. */
function customInstructions(customPrompt?: string): string {
  const extra = (customPrompt ?? "").trim();
  if (!extra) return "";
  return `\n\nAdditional instructions from the user (follow them unless they conflict with the output format above):\n${extra}`;
}

function buildPrompt(
  lines: string[],
  targetLanguage: string,
  sourceLanguage?: string | null,
  customPrompt?: string
): { system: string; user: string } {
  const from = sourceLanguage ? ` from ${sourceLanguage}` : "";
  const system =
    `You translate song lyrics${from} into the target language BCP-47 code "${targetLanguage}". ` +
    "Translate for meaning and singability, preserving the emotional register and imagery; " +
    "do not translate idioms word-for-word. Keep proper nouns, names and interjections. " +
    "If a line is already in the target language, or is only punctuation/symbols, return it unchanged. " +
    'The input is {"lines": [{"id": 0, "text": "..."}, ...]}. Return ONLY a JSON object of the form ' +
    '{"lines": [{"id": 0, "text": "<translation>"}, ...]} with one entry per input id, using the same ids in the ' +
    "same order. Never merge, split, skip or reorder lines: every id gets the translation of its own text. " +
    "No commentary." +
    customInstructions(customPrompt);
  const user = JSON.stringify({ lines: lines.map((text, id) => ({ id, text })) });
  return { system, user };
}

/**
 * Reads a `{"lines": [{"id", "text"}, ...]}` answer into one slot per input id
 * (null where the model skipped or merged a line). Keying on ids means a model
 * that drops a line costs that line, not the whole song; a truncated response is
 * salvaged entry by entry. A plain string array is still accepted, but only when
 * its length lines up exactly. Returns null when nothing usable came back.
 */
function parseIndexedLines(raw: string, expected: number): (string | null)[] | null {
  let text = raw.trim();
  // Strip ```json ... ``` fences if the model added them.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const out: (string | null)[] = new Array(expected).fill(null);
  let found = 0;
  const put = (id: unknown, value: unknown): void => {
    const i = typeof id === "number" ? id : Number(id);
    if (!Number.isInteger(i) || i < 0 || i >= expected || typeof value !== "string") return;
    if (out[i] === null) found++;
    out[i] = value;
  };

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  const arr = Array.isArray(data) ? data : (data as { lines?: unknown } | undefined)?.lines;

  if (Array.isArray(arr)) {
    if (arr.length > 0 && arr.every(v => typeof v === "string")) {
      return arr.length === expected ? (arr as string[]) : null;
    }
    for (const item of arr) put((item as { id?: unknown })?.id, (item as { text?: unknown })?.text);
  } else {
    // Truncated or otherwise malformed JSON: pull out every complete entry.
    const entry = /"id"\s*:\s*(\d+)\s*,\s*"text"\s*:\s*("(?:[^"\\]|\\.)*")/g;
    for (const m of text.matchAll(entry)) {
      try {
        put(Number(m[1]), JSON.parse(m[2]));
      } catch {
        /* skip a broken entry */
      }
    }
  }
  return found > 0 ? out : null;
}

// -- Providers --------------------------------------------------------------

async function callProvider(
  cfg: LlmConfig,
  prompt: { system: string; user: string },
  signal?: AbortSignal
): Promise<string> {
  if (cfg.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 8192,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text().catch(() => "")}`);
    const json = await res.json();
    return String(json?.content?.[0]?.text ?? "");
  }

  if (cfg.provider === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      cfg.model
    )}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: "user", parts: [{ text: prompt.user }] }],
        generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
      }),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text().catch(() => "")}`);
    const json = await res.json();
    return String(json?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "");
  }

  // openai (and openai-compatible)
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text().catch(() => "")}`);
  const json = await res.json();
  return String(json?.choices?.[0]?.message?.content ?? "");
}

// -- Per-song cache (chrome.storage.local) ---------------------------------

function hashKey(input: string): string {
  // djb2, hex - deterministic and sync.
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

type CacheEntry = { t: number; lines: string[] };
type CacheShape = Record<string, CacheEntry>;

async function readSongCache(key: string, expected: number): Promise<string[] | null> {
  try {
    const stored = await chrome.storage.local.get(SONG_CACHE_KEY);
    const map = (stored?.[SONG_CACHE_KEY] ?? {}) as CacheShape;
    const hit = map[key];
    return hit && hit.lines.length === expected ? hit.lines : null;
  } catch {
    return null;
  }
}

async function writeSongCache(key: string, lines: string[]): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(SONG_CACHE_KEY);
    const map = (stored?.[SONG_CACHE_KEY] ?? {}) as CacheShape;
    map[key] = { t: Date.now(), lines };
    const keys = Object.keys(map);
    if (keys.length > SONG_CACHE_MAX) {
      keys
        .sort((a, b) => map[a].t - map[b].t)
        .slice(0, keys.length - SONG_CACHE_MAX)
        .forEach(k => delete map[k]);
    }
    await chrome.storage.local.set({ [SONG_CACHE_KEY]: map });
  } catch {
    /* best effort */
  }
}

// -- Entry point ----------------------------------------------------------

/**
 * Returns an LLM translation for every input line (or null for a line the model
 * left blank). Result length always equals `lines.length`; an all-null array
 * means "use the existing translations".
 */
export async function translateLinesWithLlm(
  lines: string[],
  targetLanguage: string,
  sourceLanguage: string | null | undefined,
  cfg: LlmConfig,
  signal?: AbortSignal
): Promise<(string | null)[]> {
  const nulls = (): (string | null)[] => lines.map(() => null);
  if (lines.length === 0) return [];

  const customPrompt = AppState.llmCustomPrompt;
  const cacheKey = hashKey(`${cfg.provider} ${cfg.model} ${targetLanguage} ${customPrompt}\n${lines.join("\n")}`);
  const cached = await readSongCache(cacheKey, lines.length);
  if (cached) {
    log(LOG_PREFIX, `LLM translation: cache hit (${cfg.provider}/${cfg.model})`);
    return cached.map(s => s || null);
  }

  const prompt = buildPrompt(lines, targetLanguage, sourceLanguage, customPrompt);
  let raw: string;
  try {
    raw = await callProvider(cfg, prompt, signal);
  } catch (error) {
    if ((error as Error).name !== "AbortError") log(TRANSLATION_ERROR_LOG, "LLM translation failed", error);
    return nulls();
  }

  const parsed = parseIndexedLines(raw, lines.length);
  if (!parsed) {
    log(TRANSLATION_ERROR_LOG, `LLM translation: could not parse ${lines.length}-line response`);
    return nulls();
  }

  // Lines the model skipped or merged away: ask once more for just those. Lines
  // with no letters or digits (♪, punctuation) are expected to come back empty.
  const translatable = (i: number): boolean => /[\p{L}\p{N}]/u.test(lines[i]);
  const missing = () => parsed.flatMap((text, i) => (text === null && translatable(i) ? [i] : []));
  const firstMissing = missing();
  if (firstMissing.length > 0) {
    log(LOG_PREFIX, `LLM translation: ${firstMissing.length}/${lines.length} lines missing, retrying those`);
    try {
      const retryLines = firstMissing.map(i => lines[i]);
      const retryRaw = await callProvider(
        cfg,
        buildPrompt(retryLines, targetLanguage, sourceLanguage, customPrompt),
        signal
      );
      const retried = parseIndexedLines(retryRaw, retryLines.length);
      retried?.forEach((text, k) => {
        if (text !== null) parsed[firstMissing[k]] = text;
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") return nulls();
      log(TRANSLATION_ERROR_LOG, "LLM translation retry failed", error);
    }
  }

  // Only a complete answer is worth caching; a partial one gets retried next time.
  const stillMissing = missing().length;
  if (stillMissing === 0)
    await writeSongCache(
      cacheKey,
      parsed.map(s => s ?? "")
    );
  else log(TRANSLATION_ERROR_LOG, `LLM translation: ${stillMissing}/${lines.length} lines still missing`);
  log(LOG_PREFIX, `LLM translation: ${lines.length - stillMissing} lines via ${cfg.provider}/${cfg.model}`);
  return parsed.map(s => s?.trim() || null);
}

// -- Furigana -----------------------------------------------------------------

type LlmFuriganaPair = { text: string; reading: string };

const KANJI_LINE_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff々〇]/;

function buildFuriganaPrompt(lines: string[]): { system: string; user: string } {
  const system =
    'You add furigana to Japanese song lyrics. The input is a JSON object {"lines": [...]} of lyric lines. ' +
    "For EACH line return an array of [text, reading] pairs, one pair per run of consecutive kanji " +
    "(including 々 and 〇), in order of appearance. `text` is copied exactly from the line and contains ONLY " +
    "kanji - no kana, no okurigana, no punctuation. `reading` is the pronunciation as it is SUNG in this song, " +
    "in hiragana: follow the artist's intended reading even when it is unusual or artistic (ateji / gikun, " +
    "a kanji word deliberately read as a different word); use katakana only when the sung reading is a " +
    "loanword. Give the reading for the kanji only, never the okurigana after it. " +
    'Return ONLY a JSON object {"lines": [[["text","reading"], ...], ...]} with EXACTLY the same number of ' +
    "entries as the input, in the same order; use [] for a line with no kanji. No commentary.";
  return { system, user: JSON.stringify({ lines }) };
}

function parseFuriganaLines(raw: string, expected: number): LlmFuriganaPair[][] | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      data = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  const arr = Array.isArray(data) ? data : (data as { lines?: unknown })?.lines;
  if (!Array.isArray(arr) || arr.length !== expected) return null;

  return arr.map(line => {
    if (!Array.isArray(line)) return [];
    const pairs: LlmFuriganaPair[] = [];
    for (const item of line) {
      const text = Array.isArray(item) ? item[0] : (item as { text?: unknown })?.text;
      const reading = Array.isArray(item) ? item[1] : (item as { reading?: unknown })?.reading;
      if (typeof text === "string" && typeof reading === "string" && text && reading) {
        pairs.push({ text: text.trim(), reading: reading.trim() });
      }
    }
    return pairs;
  });
}

/**
 * Asks the LLM for the sung reading of every kanji run in the song's lines.
 * Returns one pair list per input line (empty for lines without kanji), or null
 * if the request failed - callers keep whatever furigana they already have.
 * Repeated lines are sent once, and the result is cached per song.
 */
export async function furiganaWithLlm(
  lines: string[],
  cfg: LlmConfig,
  signal?: AbortSignal
): Promise<LlmFuriganaPair[][] | null> {
  const unique = [...new Set(lines.filter(line => KANJI_LINE_RE.test(line)))];
  if (unique.length === 0) return lines.map(() => []);

  const cacheKey = hashKey(`furigana ${cfg.provider} ${cfg.model}\n${unique.join("\n")}`);
  let byLine: Map<string, LlmFuriganaPair[]> | null = null;

  const cached = await readSongCache(cacheKey, unique.length);
  if (cached) {
    try {
      byLine = new Map(unique.map((line, i) => [line, JSON.parse(cached[i]) as LlmFuriganaPair[]]));
      log(LOG_PREFIX, `LLM furigana: cache hit (${cfg.provider}/${cfg.model})`);
    } catch {
      byLine = null;
    }
  }

  if (!byLine) {
    let raw: string;
    try {
      raw = await callProvider(cfg, buildFuriganaPrompt(unique), signal);
    } catch (error) {
      if ((error as Error).name !== "AbortError") log(TRANSLATION_ERROR_LOG, "LLM furigana failed", error);
      return null;
    }
    const parsed = parseFuriganaLines(raw, unique.length);
    if (!parsed) {
      log(TRANSLATION_ERROR_LOG, `LLM furigana: could not parse ${unique.length}-line response`);
      return null;
    }
    byLine = new Map(unique.map((line, i) => [line, parsed[i]]));
    await writeSongCache(
      cacheKey,
      parsed.map(pairs => JSON.stringify(pairs))
    );
    log(LOG_PREFIX, `LLM furigana: ${unique.length} lines via ${cfg.provider}/${cfg.model}`);
  }

  return lines.map(line => byLine.get(line) ?? []);
}

// -- Revision (second pass) ---------------------------------------------------

function buildRevisionPrompt(
  sources: string[],
  drafts: string[],
  targetLanguage: string,
  customPrompt?: string
): { system: string; user: string } {
  const system =
    `You are the final editor of translated song lyrics. Each input item has the original line ("source") and a ` +
    `draft translation ("draft") in the language with BCP-47 code "${targetLanguage}". Rewrite every draft so it ` +
    "reads as natural, colloquial spoken language - the way a person would say or sing it - while keeping its " +
    "meaning, imagery, emotional tone and roughly its length. Song lyrics are spoken-style: turn stiff written or " +
    "literary wording into spoken wording, unless the original line itself is genuinely literary or archaic. " +
    "For Korean: never end a phrase or line in a plain written declarative (~이다, ~한다, ~하다, ~했다, ~하였다, ~ㄴ다/~는다), " +
    "and never leave a verb in bare dictionary form to connect phrases - use spoken endings and connective forms " +
    "(~고, ~서, ~며, ~아/어) instead. Choose ONE speech level for the whole song (casual 반말 or polite ~요) and use " +
    "it consistently, but vary the specific endings. Where the source repeats a grammatical pattern, keep the " +
    "repeated pattern mirrored in the output. Identical source lines must get identical output lines. Do not merge " +
    'or split lines. The input is {"items": [{"id": 0, "source": "...", "draft": "..."}, ...]}. Return ONLY a ' +
    'JSON object of the form {"lines": [{"id": 0, "text": "<revised draft>"}, ...]} with one entry per input id, ' +
    "using the same ids in the same order. No commentary." +
    customInstructions(customPrompt);
  const user = JSON.stringify({ items: sources.map((source, id) => ({ id, source, draft: drafts[id] })) });
  return { system, user };
}

/**
 * Second LLM pass: hands the original lines together with the first-pass
 * translation back to the model to be rewritten as natural spoken language.
 * Returns one revised string per input line (null where there was no draft or
 * the pass failed), so callers just keep the first-pass text for those.
 */
export async function reviseTranslationWithLlm(
  sources: string[],
  drafts: (string | null)[],
  targetLanguage: string,
  cfg: LlmConfig,
  signal?: AbortSignal
): Promise<(string | null)[]> {
  const nulls = (): (string | null)[] => sources.map(() => null);
  const indices = drafts.flatMap((draft, i) => (draft ? [i] : []));
  if (indices.length === 0) return nulls();

  const src = indices.map(i => sources[i]);
  const dr = indices.map(i => drafts[i] as string);
  const customPrompt = AppState.llmCustomPrompt;
  const cacheKey = hashKey(
    `revise ${cfg.provider} ${cfg.model} ${targetLanguage} ${customPrompt}\n${src.join("\n")}\n${dr.join("\n")}`
  );

  let revised = await readSongCache(cacheKey, indices.length);
  if (revised) {
    log(LOG_PREFIX, `LLM revision: cache hit (${cfg.provider}/${cfg.model})`);
  } else {
    let raw: string;
    try {
      raw = await callProvider(cfg, buildRevisionPrompt(src, dr, targetLanguage, customPrompt), signal);
    } catch (error) {
      if ((error as Error).name !== "AbortError") log(TRANSLATION_ERROR_LOG, "LLM revision failed", error);
      return nulls();
    }
    const parsed = parseIndexedLines(raw, indices.length);
    if (!parsed) {
      log(TRANSLATION_ERROR_LOG, `LLM revision: could not parse ${indices.length}-line response`);
      return nulls();
    }
    // A line the model skipped keeps its first-pass text; only a complete answer is cached.
    const missing = parsed.filter(text => text === null).length;
    if (missing === 0) await writeSongCache(cacheKey, parsed as string[]);
    else log(TRANSLATION_ERROR_LOG, `LLM revision: ${missing}/${indices.length} lines missing`);
    log(LOG_PREFIX, `LLM revision: ${indices.length - missing} lines via ${cfg.provider}/${cfg.model}`);
    revised = parsed.map(text => text ?? "");
  }

  const out = nulls();
  indices.forEach((lineIndex, i) => {
    out[lineIndex] = revised[i]?.trim() || null;
  });
  return out;
}
