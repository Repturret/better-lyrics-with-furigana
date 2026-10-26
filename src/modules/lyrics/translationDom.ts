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

// -- Provenance ---------------------------------------------------------------

/** Where the translation a line currently shows came from. */
export type TranslationStage = "official" | "google" | "llm" | "revised";

export interface TranslationHistoryEntry {
  stage: TranslationStage;
  text: string;
}

const STAGE_LABEL: Record<TranslationStage, string> = {
  official: "Provider",
  google: "Google",
  llm: "AI (1st pass)",
  revised: "AI (revised)",
};

/**
 * Marks a line's translation row with its source and the translations it replaced. The row gets
 * `data-stage` (fork.css draws a small badge off it) and a `title` listing every version in order,
 * the current one marked, so an earlier one can be read back by hovering the badge.
 */
export function setTranslationMeta(
  lyricElement: HTMLElement,
  stage: TranslationStage,
  history: readonly TranslationHistoryEntry[]
): void {
  const row = lyricElement.querySelector<HTMLElement>(`.${TRANSLATED_LYRICS_CLASS}`);
  if (!row) return;
  row.dataset.stage = stage;
  row.title = history
    .map((entry, i) => `${i === history.length - 1 ? "▶ " : "   "}${STAGE_LABEL[entry.stage]}: ${entry.text}`)
    .join("\n");
}

/** `history` with `text` added as the newest version, unless it already is the newest. */
export function withTranslationVersion(
  history: readonly TranslationHistoryEntry[] | undefined,
  stage: TranslationStage,
  text: string
): TranslationHistoryEntry[] {
  const last = history?.[history.length - 1];
  if (last && last.stage === stage && last.text === text) return [...(history ?? [])];
  return [...(history ?? []), { stage, text }];
}

const SOURCE_BADGE_ATTRIBUTE = "data-blyrics-translation-source";

/**
 * Shows or hides the source badge on every translation row of `doc`. It is one attribute on the
 * document's root that fork.css keys the badge off, so a row needs no change when it is toggled and
 * the Picture-in-Picture window follows with the same call on its own document.
 */
export function setTranslationSourceVisible(doc: Document, visible: boolean): void {
  doc.documentElement.toggleAttribute(SOURCE_BADGE_ATTRIBUTE, visible);
}
