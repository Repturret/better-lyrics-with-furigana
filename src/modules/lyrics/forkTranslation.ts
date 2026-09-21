/**
 * "Best" translation quality: after the Google pass has put its lines on screen, re-translate the
 * whole song through the user's LLM for cross-line context and swap the improved lines in, then
 * optionally a second pass that rewrites them as spoken language. Every step is best-effort: when
 * the mode is off, there is no API key, or a request fails, what is already on screen stays.
 */
import { TRANSLATED_LYRICS_CLASS } from "@constants";
import { AppState } from "@core/appState";
import { getLlmConfig, reviseTranslationWithLlm, translateLinesWithLlm } from "@modules/lyrics/llmTranslation";
import { injectTranslation } from "@braccato/core";

export interface LlmTranslationLine {
  index: number;
  text: string;
  /** The provider shipped this translation; the LLM does not overwrite it. */
  official: boolean;
}

interface LlmTranslationPass {
  doc: Document;
  lines: LlmTranslationLine[];
  lyricElementAt: (index: number) => HTMLElement;
  targetLanguage: string;
  sourceLanguage: string | undefined;
  isStale: () => boolean;
  isSameText: (a: string, b: string) => boolean;
  /** Called with every line whose text changed, so other views can mirror it. */
  onTranslation: (index: number, text: string) => void;
  onApplied: () => void;
  signal?: AbortSignal;
}

/** Replace the translation row's text in place, or add it if not present yet. */
function upsertTranslation(doc: Document, lyricElement: HTMLElement, text: string): void {
  const existing = lyricElement.querySelector<HTMLElement>(`.${TRANSLATED_LYRICS_CLASS}`);
  if (existing) {
    if (existing.textContent !== text) existing.textContent = text;
    return;
  }
  injectTranslation(doc, lyricElement, text);
}

export async function runLlmTranslationPass(pass: LlmTranslationPass): Promise<void> {
  const { lines, targetLanguage, isStale, isSameText, signal } = pass;
  if (lines.length === 0 || isStale()) return;

  const cfg = await getLlmConfig();
  if (!cfg || isStale()) return;

  const apply = (line: LlmTranslationLine, text: string): void => {
    upsertTranslation(pass.doc, pass.lyricElementAt(line.index), text);
    pass.onTranslation(line.index, text);
  };

  const texts = lines.map(l => l.text);
  const improved = await translateLinesWithLlm(texts, targetLanguage, pass.sourceLanguage, cfg, signal);
  if (isStale()) return;

  let applied = 0;
  improved.forEach((translated, i) => {
    const line = lines[i];
    if (!translated || line.official || isSameText(translated, line.text)) return;
    apply(line, translated);
    applied++;
  });
  if (applied > 0) pass.onApplied();

  // Second pass: hand the drafts back to be rewritten as natural spoken language.
  if (!AppState.isLlmRevisionEnabled) return;
  const drafts = improved.map((translated, i) => {
    const line = lines[i];
    return translated && !line.official && !isSameText(translated, line.text) ? translated : null;
  });
  const revised = await reviseTranslationWithLlm(texts, drafts, targetLanguage, cfg, signal);
  if (isStale()) return;

  let revisedCount = 0;
  revised.forEach((text, i) => {
    if (!text || !drafts[i] || text === drafts[i] || isSameText(text, lines[i].text)) return;
    apply(lines[i], text);
    revisedCount++;
  });
  if (revisedCount > 0) pass.onApplied();
}
