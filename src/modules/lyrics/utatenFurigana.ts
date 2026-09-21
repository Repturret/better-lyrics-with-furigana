/**
 * Prototype: scrape furigana readings for the current song from UtaTen
 * (utaten.com) instead of guessing them from Google's romaji + kuromoji. Opt-in
 * ("Language" tab, Furigana source = UtaTen) since it depends on an outside
 * site's markup and search matching, and only makes sense for a local build -
 * see the caveats below before shipping this to the store.
 *
 * UtaTen marks up every furigana-annotated word as:
 *   <span class="ruby"><span class="rb">検証</span><span class="rt">けんしょう</span></span>
 * inside `.lyricBody .hiragana`. Rather than aligning UtaTen's line breaks to
 * YT Music's (their punctuation/line-splits often differ), this flattens every
 * (word, reading) pair on the page into a per-song override table - the same
 * shape as furigana.ts's own READING_OVERRIDES - and lets applyOverrides do the
 * matching. That trades UtaTen's line-level context for robustness: good
 * enough for a prototype, but a word read two different ways in the same song
 * only keeps whichever occurrence was parsed first.
 *
 * Caveats before using this beyond a personal build: scraping utaten.com's
 * markup is unversioned and can break silently; heavier traffic risks the
 * site rate-limiting or blocking the extension's users; and redistributing
 * its editorial furigana data via a public extension raises real copyright/ToS
 * questions independent of the technical approach.
 */
import { LOG_PREFIX, TRANSLATION_ERROR_LOG } from "@constants";
import { log } from "@utils";
import type { ReadingOverride } from "./furigana";

const CACHE_KEY = "blyrics_utaten_furigana_cache";
const CACHE_MAX = 40;
const SEARCH_URL = "https://utaten.com/lyric/search";

type CacheEntry = { t: number; overrides: ReadingOverride[] };
type CacheShape = Record<string, CacheEntry>;

function cacheKeyFor(title: string, artist: string): string {
  return `${artist.trim()}::${title.trim()}`.toLowerCase();
}

// Fullwidth ASCII -> halfwidth, whitespace stripped - UtaTen's search-result
// titles are otherwise identical to YT Music's for an exact match.
function normalizeForMatch(s: string): string {
  return s
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]+/g, "")
    .toLowerCase();
}

async function findLyricPageUrl(title: string, artist: string, signal?: AbortSignal): Promise<string | null> {
  const url = `${SEARCH_URL}?artist_name=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}&sort=popular_sort_asc`;
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  const links = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href*="/lyric/"]')).filter(a =>
    /\/lyric\/[a-z0-9]+\/?(?:$|[?#])/i.test(a.getAttribute("href") ?? "")
  );
  if (!links.length) return null;

  const wantTitle = normalizeForMatch(title);
  const chosen = links.find(a => normalizeForMatch(a.textContent ?? "") === wantTitle) ?? links[0];
  const href = chosen.getAttribute("href");
  return href ? new URL(href, "https://utaten.com").href : null;
}

function parseOverridesFromLyricPage(html: string): ReadingOverride[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.querySelector(".lyricBody .hiragana") ?? doc.querySelector(".hiragana");
  if (!body) return [];

  const overrides: ReadingOverride[] = [];
  const seen = new Set<string>();
  for (const rubyEl of Array.from(body.querySelectorAll(".ruby"))) {
    const rb = rubyEl.querySelector(".rb")?.textContent?.trim();
    const rt = rubyEl.querySelector(".rt")?.textContent?.trim();
    if (!rb || !rt || seen.has(rb)) continue;
    seen.add(rb);
    overrides.push([rb, 0, rb.length, rt] as const);
  }
  return overrides;
}

async function readCache(key: string): Promise<ReadingOverride[] | null> {
  try {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    const map = (stored?.[CACHE_KEY] ?? {}) as CacheShape;
    return map[key]?.overrides ?? null;
  } catch {
    return null;
  }
}

async function writeCache(key: string, overrides: ReadingOverride[]): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    const map = (stored?.[CACHE_KEY] ?? {}) as CacheShape;
    map[key] = { t: Date.now(), overrides };
    const keys = Object.keys(map);
    if (keys.length > CACHE_MAX) {
      keys
        .sort((a, b) => map[a].t - map[b].t)
        .slice(0, keys.length - CACHE_MAX)
        .forEach(k => delete map[k]);
    }
    await chrome.storage.local.set({ [CACHE_KEY]: map });
  } catch {
    /* best effort */
  }
}

/**
 * Returns the flattened (word, reading) overrides for this song's UtaTen page,
 * or [] if it can't be found/parsed/fetched - callers should just fall back to
 * the local romaji+kuromoji pipeline in that case. Cached per (artist, title)
 * so repeat plays never re-fetch.
 */
export async function getUtatenOverrides(
  title: string,
  artist: string,
  signal?: AbortSignal
): Promise<ReadingOverride[]> {
  if (!title.trim()) return [];
  const key = cacheKeyFor(title, artist);
  const cached = await readCache(key);
  if (cached) {
    log(LOG_PREFIX, `UtaTen furigana: cache hit (${cached.length} words) for "${artist} - ${title}"`);
    return cached;
  }

  try {
    const pageUrl = await findLyricPageUrl(title, artist, signal);
    if (!pageUrl) {
      log(LOG_PREFIX, `UtaTen furigana: no match for "${artist} - ${title}"`);
      await writeCache(key, []);
      return [];
    }
    const res = await fetch(pageUrl, { signal });
    if (!res.ok) throw new Error(`utaten lyric page ${res.status}`);
    const overrides = parseOverridesFromLyricPage(await res.text());
    await writeCache(key, overrides);
    log(LOG_PREFIX, `UtaTen furigana: ${overrides.length} words from ${pageUrl}`);
    return overrides;
  } catch (error) {
    if ((error as Error).name !== "AbortError") log(TRANSLATION_ERROR_LOG, "UtaTen furigana fetch failed", error);
    return [];
  }
}
