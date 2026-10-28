/**
 * "Best" translation quality: after the Google pass has put its lines on screen, re-translate the
 * whole song through the user's LLM for cross-line context and swap the improved lines in, then
 * optionally a second pass that rewrites them as spoken language. Every step is best-effort: when
 * the mode is off, there is no API key, or a request fails, what is already on screen stays.
 */
import { AppState } from "@core/appState";
import { getLlmConfig, reviseTranslationWithLlm, translateLinesWithLlm } from "@modules/lyrics/llmTranslation";
import { upsertTranslation } from "@modules/lyrics/translationDom";

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
  /** The song's own lines that are not being translated (already in the target language, e.g. a
   *  Korean song's Korean lines for a Korean reader). Still the song's voice: handed to the model
   *  so its translation of an odd English line sounds like the same singer. */
  contextLines?: string[];
  /** Called with every line whose text changed, so other views can mirror it. */
  onTranslation: (index: number, text: string, stage: "llm" | "revised") => void;
  onApplied: () => void;
  signal?: AbortSignal;
}

/**
 * A "translation" that is still the source line: the model echoed it (often respacing it a little,
 * so an exact-match check misses it) rather than translating, typically for a line wrapped in 「」
 * or quotation marks. Judged by script, since the target language's own script is not known here -
 * mostly kana/Han coming back out for a Japanese line headed to a non-CJK language is untranslated.
 */
export function looksUntranslated(source: string, translated: string, targetLanguage: string): boolean {
  const cjkChar = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
  const cjkChars = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu;
  if (!cjkChar.test(source) || /^(ja|zh)/i.test(targetLanguage)) return false;
  const letters = translated.match(/\p{L}/gu)?.length ?? 0;
  const cjk = translated.match(cjkChars)?.length ?? 0;
  return letters > 0 && cjk / letters > 0.5;
}

/**
 * A model answer that must not reach the screen: the source line echoed back, source-language kana or
 * Han left inside a translation headed for a non-CJK-script language, or a stray placeholder token
 * (DONT_USE, NO_TRANSLATION) where text should be. Names the model chose to leave as they are fall to
 * this too: a line that is retried or kept as Google's is better than one with half its words missing.
 */
export function hasTranslationDefect(source: string, translated: string, targetLanguage: string): boolean {
  if (looksUntranslated(source, translated, targetLanguage)) return true;
  if (/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(translated)) return true;
  if (/^(ja|zh)/i.test(targetLanguage)) return false;
  return (
    /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(translated) &&
    /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(source)
  );
}

/** A rewrite that is far shorter or longer than its draft has lost or invented meaning. */
export function driftedFromDraft(draft: string, revised: string): boolean {
  const size = (text: string): number => text.replace(/[^\p{L}\p{N}]/gu, "").length;
  const before = size(draft);
  const after = size(revised);
  if (before === 0) return false;
  const ratio = after / before;
  return ratio < 0.6 || ratio > 1.6;
}

export async function runLlmTranslationPass(pass: LlmTranslationPass): Promise<void> {
  const { lines, targetLanguage, isStale, isSameText, signal } = pass;
  if (lines.length === 0 || isStale()) return;

  const cfg = await getLlmConfig();
  if (!cfg || isStale()) return;

  const apply = (line: LlmTranslationLine, text: string, stage: "llm" | "revised"): void => {
    upsertTranslation(pass.doc, pass.lyricElementAt(line.index), text);
    pass.onTranslation(line.index, text, stage);
  };

  const texts = lines.map(l => l.text);
  const improved = await translateLinesWithLlm(
    texts,
    targetLanguage,
    pass.sourceLanguage,
    cfg,
    signal,
    pass.contextLines
  );
  if (isStale()) return;

  // A line that came back echoed, half in the source script, or carrying a placeholder is asked for
  // once more on its own, with the problem named; if it is still bad it keeps the Google line.
  const defective = improved.flatMap((translated, i) =>
    translated && !lines[i].official && hasTranslationDefect(lines[i].text, translated, targetLanguage) ? [i] : []
  );
  if (defective.length > 0) {
    const retried = await translateLinesWithLlm(
      defective.map(i => texts[i]),
      targetLanguage,
      pass.sourceLanguage,
      cfg,
      signal,
      pass.contextLines,
      "Your previous answer for these lines was rejected: it left source-language characters or a placeholder " +
        "token (such as DONT_USE) in the text. Translate every line completely into the target language, with " +
        "natural words of that language only, and never output placeholder tokens."
    );
    if (isStale()) return;
    defective.forEach((lineIndex, k) => {
      improved[lineIndex] = retried[k] ?? null;
    });
  }

  let applied = 0;
  improved.forEach((translated, i) => {
    const line = lines[i];
    if (!translated || line.official || isSameText(translated, line.text)) return;
    if (hasTranslationDefect(line.text, translated, targetLanguage)) return;
    apply(line, translated, "llm");
    applied++;
  });
  if (applied > 0) pass.onApplied();

  // Second pass: hand the drafts back to be rewritten as natural spoken language.
  if (!AppState.isLlmRevisionEnabled) return;
  const drafts = improved.map((translated, i) => {
    const line = lines[i];
    return translated &&
      !line.official &&
      !isSameText(translated, line.text) &&
      !hasTranslationDefect(line.text, translated, targetLanguage)
      ? translated
      : null;
  });
  const revised = await reviseTranslationWithLlm(texts, drafts, targetLanguage, cfg, signal, pass.contextLines);
  if (isStale()) return;

  let revisedCount = 0;
  revised.forEach((text, i) => {
    if (!text || !drafts[i] || text === drafts[i] || isSameText(text, lines[i].text)) return;
    if (hasTranslationDefect(lines[i].text, text, targetLanguage)) return;
    // A rewrite that lost or gained a lot of text changed what the line says: keep the first answer.
    if (driftedFromDraft(drafts[i], text)) return;
    apply(lines[i], text, "revised");
    revisedCount++;
  });
  if (revisedCount > 0) pass.onApplied();
}
