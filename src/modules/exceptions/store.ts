/**
 * User exceptions: corrections the user makes to what the extension would otherwise produce.
 * One `chrome.storage.local` slot (kept apart from the translation/romanization caches, which get
 * purged) holding every kind, so they can be listed, edited, exported and imported together.
 *
 * Only readings are consulted so far (furigana.ts); `glossary` and `song` are part of the schema
 * from the start so later steps add UI and consumers without another migration.
 *
 * Main-world only: it uses `chrome.storage` directly. The pure functions above the storage section
 * touch nothing global and are what the self-check exercises.
 */
import { LOG_PREFIX } from "@constants";
import { logCore as log } from "@core/logger";

const EXCEPTIONS_KEY = "blyricsExceptions";
/** The pre-store slot: kanji run -> reading, written by the double-click editor. Read once to
 *  migrate and then left alone, so a downgrade still finds its data. */
const LEGACY_READINGS_KEY = "furiganaUserOverrides";

/** A reading for `match.slice(start, end)`, applied wherever `match` occurs. */
export type ReadingException = {
  id: string;
  match: string;
  start: number;
  end: number;
  reading: string;
  /** Absent = every song. */
  songId?: string;
  enabled: boolean;
};

type GlossaryException = {
  id: string;
  term: string;
  target: string;
  lang: string;
  note?: string;
  songId?: string;
  enabled: boolean;
};

type SongException = {
  excludedProviders?: string[];
  sourceLanguage?: string;
  romanization?: boolean;
  translation?: boolean;
  furigana?: boolean;
};

type ExceptionStore = {
  version: 1;
  reading: ReadingException[];
  glossary: GlossaryException[];
  song: Record<string, SongException>;
};

// -- Pure ------------------------------------------------------------------

export function emptyStore(): ExceptionStore {
  return { version: 1, reading: [], glossary: [], song: {} };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readingId = (match: string, start: number, end: number, songId?: string): string =>
  `reading:${songId ?? "*"}:${match}:${start}-${end}`;

function normalizeReading(raw: unknown): ReadingException | null {
  if (!isRecord(raw)) return null;
  const { match, start, end, reading, songId, enabled } = raw;
  if (typeof match !== "string" || typeof reading !== "string" || !match || !reading) return null;
  if (typeof start !== "number" || typeof end !== "number" || start < 0 || end <= start || end > match.length) {
    return null;
  }
  const song = typeof songId === "string" && songId ? songId : undefined;
  return {
    id: readingId(match, start, end, song),
    match,
    start,
    end,
    reading,
    songId: song,
    enabled: enabled !== false,
  };
}

/** Reads whatever is in storage into a well-formed store, dropping entries it cannot use rather
 *  than failing: a hand-edited or imported file must not take the lyrics down with it. */
export function normalizeStore(raw: unknown): ExceptionStore {
  if (!isRecord(raw)) return emptyStore();
  const reading = Array.isArray(raw.reading)
    ? raw.reading.map(normalizeReading).filter((entry): entry is ReadingException => entry !== null)
    : [];
  const glossary = Array.isArray(raw.glossary)
    ? raw.glossary.filter(
        (entry): entry is GlossaryException =>
          isRecord(entry) && typeof entry.term === "string" && typeof entry.target === "string" && !!entry.term
      )
    : [];
  return { version: 1, reading, glossary, song: isRecord(raw.song) ? (raw.song as ExceptionStore["song"]) : {} };
}

/** The old kanji-run -> reading map, as store entries covering the whole run. */
export function migrateLegacyReadings(legacy: unknown): ReadingException[] {
  if (!isRecord(legacy)) return [];
  return Object.entries(legacy).flatMap(([surface, reading]) => {
    const entry = normalizeReading({ match: surface, start: 0, end: surface.length, reading, enabled: true });
    return entry ? [entry] : [];
  });
}

/**
 * The user's reading for a kanji run, if one covers exactly that run. The song-specific entry
 * wins over the all-songs one; a disabled entry is skipped, not matched.
 */
export function findReading(store: ExceptionStore, surface: string, songId?: string): string | undefined {
  let global: string | undefined;
  for (const entry of store.reading) {
    if (!entry.enabled || entry.match !== surface || entry.start !== 0 || entry.end !== surface.length) continue;
    if (entry.songId === undefined) global = entry.reading;
    else if (entry.songId === songId) return entry.reading;
  }
  return global;
}

/** Adds the reading for a whole kanji run, or replaces the one already there for the same scope. */
export function withReading(store: ExceptionStore, surface: string, reading: string, songId?: string): ExceptionStore {
  const entry = normalizeReading({ match: surface, start: 0, end: surface.length, reading, songId, enabled: true });
  if (!entry) return store;
  return { ...store, reading: [...store.reading.filter(existing => existing.id !== entry.id), entry] };
}

/**
 * A reading for `target` as it occurs inside `context` (the context is what makes the rule narrow:
 * 前 is まえ only after 被告人). An empty context means the target stands alone. Null when the target
 * is not part of the context or a field is blank.
 */
export function buildReadingEntry(
  context: string,
  target: string,
  reading: string,
  songId?: string
): ReadingException | null {
  const match = context.trim() || target.trim();
  const part = target.trim();
  const start = match.indexOf(part);
  if (!part || start < 0) return null;
  return normalizeReading({ match, start, end: start + part.length, reading: reading.trim(), songId, enabled: true });
}

/** Adds an entry, replacing the one with the same id (same match, range and scope). */
export function withEntry(store: ExceptionStore, entry: ReadingException): ExceptionStore {
  return { ...store, reading: [...store.reading.filter(existing => existing.id !== entry.id), entry] };
}

export function withoutEntry(store: ExceptionStore, id: string): ExceptionStore {
  return { ...store, reading: store.reading.filter(entry => entry.id !== id) };
}

export function withEntryEnabled(store: ExceptionStore, id: string, enabled: boolean): ExceptionStore {
  return { ...store, reading: store.reading.map(entry => (entry.id === id ? { ...entry, enabled } : entry)) };
}

/** Entries that name a context beyond the run itself, for the song at hand. The double-click
 *  corrections cover a whole run and are looked up exactly instead (`findReading`). */
export function contextReadings(store: ExceptionStore, songId?: string): ReadingException[] {
  return store.reading.filter(
    entry =>
      entry.enabled &&
      !(entry.start === 0 && entry.end === entry.match.length) &&
      (entry.songId === undefined || entry.songId === songId)
  );
}

/** Parses an exported file; null when it is not an exceptions file at all. */
export function parseExport(text: string): ExceptionStore | null {
  try {
    const raw: unknown = JSON.parse(text);
    return isRecord(raw) && raw.version === 1 ? normalizeStore(raw) : null;
  } catch {
    return null;
  }
}

/** Imported entries win over existing ones with the same id; everything else is kept. */
export function mergeStores(base: ExceptionStore, incoming: ExceptionStore): ExceptionStore {
  const incomingIds = new Set(incoming.reading.map(entry => entry.id));
  return {
    ...base,
    reading: [...base.reading.filter(entry => !incomingIds.has(entry.id)), ...incoming.reading],
  };
}

// -- Storage ---------------------------------------------------------------

let current = emptyStore();
let subscribed = false;

/** Loads the store (migrating the old furigana slot the first time) and keeps it in step with
 *  changes made elsewhere, such as an options page in another tab. Before this resolves a lookup
 *  just sees no exceptions yet. */
export async function loadExceptions(): Promise<void> {
  try {
    const items = await chrome.storage.local.get({ [EXCEPTIONS_KEY]: null, [LEGACY_READINGS_KEY]: null });
    if (items[EXCEPTIONS_KEY] === null) {
      current = { ...emptyStore(), reading: migrateLegacyReadings(items[LEGACY_READINGS_KEY]) };
      if (current.reading.length > 0) await saveExceptions(current);
    } else {
      current = normalizeStore(items[EXCEPTIONS_KEY]);
    }
  } catch (error) {
    log(LOG_PREFIX, "Failed to load exceptions", error);
  }
  if (!subscribed) {
    subscribed = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[EXCEPTIONS_KEY]) current = normalizeStore(changes[EXCEPTIONS_KEY].newValue);
    });
  }
}

async function saveExceptions(next: ExceptionStore): Promise<void> {
  current = next;
  try {
    await chrome.storage.local.set({ [EXCEPTIONS_KEY]: next });
  } catch (error) {
    log(LOG_PREFIX, "Failed to save exceptions", error);
  }
}

/** The store as last loaded or saved. */
export function getExceptions(): ExceptionStore {
  return current;
}

/** Applies a change to the store and saves it. */
export async function updateExceptions(change: (store: ExceptionStore) => ExceptionStore): Promise<void> {
  await saveExceptions(change(current));
}

/** The reading to use for a kanji run, if the user has set one. */
export function getReadingOverride(surface: string, songId?: string): string | undefined {
  return findReading(current, surface, songId);
}

export function setReadingOverride(surface: string, reading: string, songId?: string): void {
  void saveExceptions(withReading(current, surface, reading, songId));
}
