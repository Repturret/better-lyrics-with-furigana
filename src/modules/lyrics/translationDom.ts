/**
 * Translation row DOM, world-agnostic like furiganaDom.ts: it takes the `Document` it works in and
 * touches nothing but the renderer's own public injector, so the side panel and the
 * Picture-in-Picture window (page world on Gecko, no `chrome.*`) share it.
 */
import { injectTranslation } from "@braccato/core";
import { TRANSLATED_LYRICS_CLASS } from "@braccato/core/constants";

/**
 * Replace the translation row's text in place, or add it if not present yet. The core's own
 * `injectTranslation` does nothing for a line that already has one, which is why a later (better)
 * translation cannot just be injected over the first.
 */
export function upsertTranslation(doc: Document, lyricElement: HTMLElement, text: string): void {
  const existing = lyricElement.querySelector<HTMLElement>(`.${TRANSLATED_LYRICS_CLASS}`);
  if (existing) {
    if (existing.textContent !== text) existing.textContent = text;
    return;
  }
  injectTranslation(doc, lyricElement, text);
}
