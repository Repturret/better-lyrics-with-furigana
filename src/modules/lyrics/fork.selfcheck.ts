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
const {
  alignKanjiRuns,
  applyContextReadings,
  applyOverrides,
  applyUserOverrides,
  hasKana,
  runsFromLlmPairs,
  shouldFurigana,
} = await import("./furigana");
const { updateExceptions, withReading } = await import("@modules/exceptions/store");
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
assert.deepEqual(override("朝焼け色に"), ["3:いろ"], "standalone 色 is いろ");
assert.deepEqual(override("景色"), [], "色 inside a compound keeps its dictionary reading");
assert.deepEqual(override("背負って"), ["0:せお"], "背負う is せお");
assert.deepEqual(override("僕等 一心に"), ["0:ぼくら"], "僕等 is ぼくら");
assert.deepEqual(override("間に合う"), ["0:ま"], "間に合う is ま");
assert.deepEqual(override("来た間に合う"), ["2:ま"], "間に合う beats the た間 あいだ rule");
assert.deepEqual(override("寝ている間"), [], "plain 間 is left to the analyzer");
assert.deepEqual(override("その間に"), ["2:あいだ"], "間に is あいだ");
assert.deepEqual(override("間に挟まれ"), ["0:あいだ"], "間に is あいだ at the start of a line too");
assert.deepEqual(override("昼間に"), [], "間 inside a compound is left alone");
assert.deepEqual(override("その間に"), ["2:あいだ"], "の間 is still あいだ");
assert.deepEqual(override("被告人前"), ["0:ひこくじん", "3:まえ"], "被告人前 splits around the touching kanji");

// A user rule with a context re-reads only its target and leaves neighbouring runs alone.
const contextRuns = applyContextReadings(
  "被告人前",
  [
    { start: 0, end: 3, reading: "ひこくじん" },
    { start: 3, end: 4, reading: "ぜん" },
  ],
  [{ match: "被告人前", start: 3, end: 4, reading: "まえ" }]
);
assert.deepEqual(
  contextRuns.map(run => `${run.start}:${run.reading}`),
  ["0:ひこくじん", "3:まえ"],
  "context rule changes only its target"
);

// LLM pairs that carry kana inside them still give every kanji its reading.
const llmRuns = runsFromLlmPairs("私が私を追い抜き去っていく絵", [
  { text: "私", reading: "わたし" },
  { text: "私", reading: "わたし" },
  { text: "追い抜き去って", reading: "おいぬきさって" },
  { text: "絵", reading: "え" },
]);
assert.deepEqual(
  llmRuns.map(run => `${run.start}:${run.reading}`),
  ["0:わたし", "2:わたし", "4:お", "6:ぬ", "8:さ", "13:え"],
  "kana inside an LLM pair does not drop its kanji"
);

// A saved reading for a multi-kanji word still applies when the analyzers split it across runs.
void updateExceptions(store => withReading(store, "上々", "じょうじょう"));
assert.deepEqual(
  applyUserOverrides("I feel 上々", [{ start: 7, end: 8, reading: "うえ" }]).map(
    run => `${run.start}-${run.end}:${run.reading}`
  ),
  ["7-9:じょうじょう"],
  "上々 saved as one reading replaces the split 上 run"
);
assert.deepEqual(
  applyUserOverrides("至上々", [{ start: 1, end: 2, reading: "じょう" }]).map(run => `${run.start}:${run.reading}`),
  ["1:じょう"],
  "a saved word is not applied inside a bigger compound"
);

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
