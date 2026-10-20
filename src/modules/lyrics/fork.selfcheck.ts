import { strict as assert } from "node:assert";
// The modules under test sit beside DOM and extension imports that only need to load, not run.
const stub: any = new Proxy(function () {}, { get: () => stub, apply: () => stub, construct: () => stub });
Object.assign(globalThis, { document: stub, window: stub, chrome: stub });
for (const name of [
  "DOMParser",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "HTMLElement",
  "Element",
  "Node",
]) {
  Object.assign(globalThis, { [name]: stub });
}

const { looksUntranslated } = await import("./forkTranslation");
const { alignKanjiRuns, applyOverrides, hasKana, shouldFurigana } = await import("./furigana");
const { parseIndexedLines } = await import("./llmTranslation");

const readingAt = (runs: { offset: number; end: number; reading: string }[], offset: number) =>
  runs.find(run => run.offset === offset)?.reading;

// Script detection: kana wins over a wrong language guess.
assert.ok(hasKana("レプリカ"), "katakana counts as kana");
assert.ok(!hasKana("漢字"), "Han alone is not kana");
assert.ok(shouldFurigana("レプリカ - Replica", "en"), "kana beats a latin-title language guess");
assert.ok(!shouldFurigana("漢字", "zh"), "Han with a Chinese language is not Japanese");
assert.ok(shouldFurigana("漢字", "ja-JP"), "Han with a Japanese language is");

// Alignment anchors on kana, and the middle dot is punctuation rather than kana.
const aligned = alignKanjiRuns("朝・昼", "あさひる");
assert.equal(readingAt(aligned, 0), "あさ", "朝 keeps its reading across ・");
assert.equal(readingAt(aligned, 2), "ひる", "昼 keeps its reading across ・");
const choonpu = alignKanjiRuns("あー鬱陶し", "あーうっとうし");
assert.equal(readingAt(choonpu, 2), "うっとう", "ー does not eat the first reading kana");

// Static overrides, including the ones that need a following kanji as context.
const override = (text: string) => applyOverrides(text, []).map(run => `${run.start}:${run.reading}`);
assert.deepEqual(override("君"), ["0:きみ"], "bare 君 is きみ");
assert.deepEqual(override("星街"), ["0:ほしまち"], "星街 is ほしまち");
assert.deepEqual(override("被告人前"), ["0:ひこくじん", "3:まえ"], "被告人前 splits around the touching kanji");

// Untranslated echo guard.
assert.ok(looksUntranslated("圏外", "圏外", "ko"), "an echoed CJK line is untranslated");
assert.ok(!looksUntranslated("圏外", "권외", "ko"), "a Korean result is fine");
assert.ok(!looksUntranslated("圏外", "圏外", "ja"), "CJK targets are exempt");
assert.ok(!looksUntranslated("hello", "hello", "ko"), "non-CJK source is exempt");

// LLM answers are read per id, so a dropped line costs only that line.
assert.deepEqual(
  parseIndexedLines('```json\n{"lines":[{"id":0,"text":"a"},{"id":2,"text":"c"}]}\n```', 3),
  ["a", null, "c"],
  "fenced answer with a missing id"
);
assert.equal(parseIndexedLines("not json", 2), null, "nothing usable returns null");

console.log("fork selfcheck passed");
