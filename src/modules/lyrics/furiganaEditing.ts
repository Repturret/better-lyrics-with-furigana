/**
 * Manual furigana correction: double-click a reading to retype it. The fix is kept in its own
 * `chrome.storage.local` slot (not the translation/romanization caches, which get purged) and,
 * unlike the static READING_OVERRIDES table in furigana.ts, is user data - loaded once at startup
 * and consulted from there for every song, not just the one it was made on.
 *
 * Main-world only: uses `chrome.storage` directly, so - unlike furiganaDom.ts - this never runs in
 * the Picture-in-Picture window.
 */
import { LOG_PREFIX } from "@constants";
import { logCore as log } from "@core/logger";
import { FURIGANA_CLASS, updateFuriganaReading } from "@modules/lyrics/furiganaDom";

const STORAGE_KEY = "furiganaUserOverrides";
const EDITING_CLASS = "blyrics--furigana-editing";

let overrides = new Map<string, string>();
let loaded = false;

/** Loads the saved corrections once at startup; a lookup before this resolves just sees none yet. */
export function loadFuriganaOverrides(): void {
  chrome.storage.local.get({ [STORAGE_KEY]: {} }, items => {
    const stored = items[STORAGE_KEY];
    overrides = new Map(stored && typeof stored === "object" ? Object.entries(stored) : []);
    loaded = true;
  });
}

/** The user's own reading for this exact kanji run, if they have corrected it before. */
export function getFuriganaOverride(surface: string): string | undefined {
  return overrides.get(surface);
}

function persist(): void {
  chrome.storage.local.set({ [STORAGE_KEY]: Object.fromEntries(overrides) }).catch(error => {
    log(LOG_PREFIX, "Failed to save furigana correction", error);
  });
}

function commitEdit(rt: HTMLElement, input: HTMLInputElement, surface: string): void {
  const doc = rt.ownerDocument;
  const value = input.value.trim();
  input.replaceWith(rt);
  doc.defaultView?.getSelection()?.removeAllRanges();
  if (!value || value === rt.dataset.reading) return;

  overrides.set(surface, value);
  persist();
  updateFuriganaReading(rt, value);
}

function openEditor(rt: HTMLElement): void {
  const surface = rt.dataset.surface;
  if (!surface) return;
  const doc = rt.ownerDocument;

  const input = doc.createElement("input");
  input.type = "text";
  input.className = EDITING_CLASS;
  input.value = rt.dataset.reading ?? "";
  input.spellcheck = false;
  input.autocomplete = "off";
  // The line still owns click/dblclick handling underneath (seek, drag-copy): keep every pointer
  // and key event here from reaching it while the field is open.
  input.addEventListener("mousedown", event => event.stopPropagation());
  input.addEventListener("click", event => event.stopPropagation());
  input.addEventListener("dblclick", event => event.stopPropagation());
  input.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      input.value = rt.dataset.reading ?? "";
      input.blur();
    }
  });
  input.addEventListener("blur", () => commitEdit(rt, input, surface), { once: true });

  rt.replaceWith(input);
  input.focus();
  input.select();
}

/**
 * Wires up double-click-to-edit for every furigana reading under `container`. Loaded corrections
 * are consulted from furigana.ts's own pipeline (`getFuriganaOverride`), not from here - this only
 * handles the editing gesture and saving what comes out of it.
 */
export function attachFuriganaEditing(container: HTMLElement): void {
  if (!loaded) loadFuriganaOverrides();

  container.addEventListener("dblclick", event => {
    const rt = (event.target as HTMLElement | null)?.closest?.(`.${FURIGANA_CLASS}`) as HTMLElement | null;
    if (!rt) return;
    // Stop the core's own seek and lineInteractions' selection-clearing from also reacting to the
    // same double click - editing a reading is not a seek gesture.
    event.stopPropagation();
    openEditor(rt);
  });
}
