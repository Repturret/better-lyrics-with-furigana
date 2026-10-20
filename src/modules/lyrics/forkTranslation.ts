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
function looksUntranslated(source: string, translated: string, targetLanguage: string): boolean {
  const cjkChar = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
  const cjkChars = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu;
  if (!cjkChar.test(source) || /^(ja|zh)/i.test(targetLanguage)) return false;
  const letters = translated.match(/\p{L}/gu)?.length ?? 0;
  const cjk = translated.match(cjkChars)?.length ?? 0;
  return letters > 0 && cjk / letters > 0.5;
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

  let applied = 0;
  improved.forEach((translated, i) => {
    const line = lines[i];
    if (!translated || line.official || isSameText(translated, line.text)) return;
    if (looksUntranslated(line.text, translated, targetLanguage)) return;
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
      !looksUntranslated(line.text, translated, targetLanguage)
      ? translated
      : null;
  });
  const revised = await reviseTranslationWithLlm(texts, drafts, targetLanguage, cfg, signal, pass.contextLines);
  if (isStale()) return;

  let revisedCount = 0;
  revised.forEach((text, i) => {
    if (!text || !drafts[i] || text === drafts[i] || isSameText(text, lines[i].text)) return;
    if (looksUntranslated(lines[i].text, text, targetLanguage)) return;
    apply(lines[i], text, "revised");
    revisedCount++;
  });
  if (revisedCount > 0) pass.onApplied();
}
