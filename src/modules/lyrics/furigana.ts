import { LOG_PREFIX, WORD_CLASS } from "@constants";
import { log } from "@utils";
import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";

/**
 * Per-kanji furigana for Japanese lyrics.
 *
 * Two independent readings are produced and merged:
 *  - Romaji: Google's line romaji (the "romanization" feature) converted back to
 *    hiragana and aligned to the kanji using the surface kana as anchors. Keeps
 *    compounds together and follows sentence context, but Google mis-reads
 *    senses (愛 as いと, 君 as くん).
 *  - kuromoji: a local dictionary tokeniser. Accurate per-word readings, but
 *    splits some compounds oddly and rendaku-mangles counters.
 *
 * `mergeRuns` takes the compound structure from romaji and the reading of each
 * single kanji from kuromoji; `applyOverrides` fixes the handful both miss.
 * kuromoji's ~17 MB dictionary loads on the first Japanese line; if it can't
 * (offline), the romaji reading is used on its own.
 */

const KANA_RE = /[぀-ゟ゠-ヿㇰ-ㇿ]/;
const KANJI_RE = /[一-龯㐀-䶿豈-﫿々〇〻]/;
const LATIN_RE = /[a-z]/i;
const FURIGANA_CLASS = "blyrics--furigana";

const DIGIT_KANJI = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

// Readings that get mangled - by kuromoji's IPADIC on the fallback path, or by
// Google reading a kanji in the wrong sense on the romaji path (愛してる as the
// 愛しい stem "itoshi", その先 as せん not さき). Each entry is
// [match, kanjiStart, kanjiEnd, reading]: `match` is searched in the line and
// `reading` is placed over match[kanjiStart..kanjiEnd].
export type ReadingOverride = readonly [string, number, number, string];

// Per-song overrides from an external source (see utatenFurigana.ts), set once
// per song and consulted ahead of the static table below - a scraped reading
// wins over our own heuristic guess for the same word.
let songOverrides: ReadingOverride[] = [];

export function setSongFuriganaOverrides(overrides: ReadingOverride[]): void {
  songOverrides = overrides;
}

const READING_OVERRIDES: ReadonlyArray<ReadingOverride> = [
  ["一昨日", 0, 3, "おととい"],
  ["一昨年", 0, 3, "おととし"],
  ["嗚呼", 0, 2, "ああ"],
  ["愛してる", 0, 1, "あい"],
  ["愛しな", 0, 1, "あい"],
  ["愛して", 0, 1, "あい"],
  ["愛した", 0, 1, "あい"],
  ["愛す", 0, 1, "あい"],
  ["愛され", 0, 1, "あい"],
  ["その先", 2, 3, "さき"],
  ["この先", 2, 3, "さき"],
  ["あの先", 2, 3, "さき"],
  ["先程", 0, 1, "さき"],
  ["先ほど", 0, 1, "さき"],
  ["糸解", 0, 1, "いと"],
  ["糸解", 1, 2, "ほど"],
  ["一時間", 0, 3, "いちじかん"],
  ["一分", 0, 2, "いっぷん"],
  ["一秒", 0, 2, "いちびょう"],
  // 間 after a verb / の is the "duration" 間 (あいだ), not ま.
  ["た間", 1, 2, "あいだ"],
  ["だ間", 1, 2, "あいだ"],
  ["の間", 1, 2, "あいだ"],
  ["獣", 0, 1, "けもの"],
  // Standalone 側 / 他 take the kun reading, not the on reading of a compound.
  ["その他", 2, 3, "た"],
  ["他に", 0, 1, "ほか"],
  ["他の", 0, 1, "ほか"],
  ["他で", 0, 1, "ほか"],
  ["他は", 0, 1, "ほか"],
  ["側に", 0, 1, "そば"],
  ["側で", 0, 1, "そば"],
  ["側から", 0, 1, "そば"],
  ["側へ", 0, 1, "そば"],
  ["側にい", 0, 1, "そば"],
  // Compounds both passes read with the wrong on/kun mix.
  ["高鳴", 0, 1, "たか"],
  ["二重星", 2, 3, "せい"],
  ["魁星", 0, 2, "かいせい"],
  ["如何しよう", 0, 2, "どう"], // どうしようもない
  ["踠", 0, 1, "もが"], // rare kanji Google leaves as pinyin
  // Standalone 夜 + particle is よる, not the よ of 夜空 / 今夜.
  ["その夜", 2, 3, "よる"],
  ["この夜", 2, 3, "よる"],
  ["夜は", 0, 1, "よる"],
  ["夜が", 0, 1, "よる"],
  ["夜に", 0, 1, "よる"],
  ["夜も", 0, 1, "よる"],
  ["夜を", 0, 1, "よる"],
  ["夜の", 0, 1, "よる"],
  ["夜だ", 0, 1, "よる"],
  // 君 + particle is 君 (きみ), not the name suffix 〜君 (くん) Google sometimes hears.
  ["君と", 0, 1, "きみ"],
  ["君は", 0, 1, "きみ"],
  ["君が", 0, 1, "きみ"],
  ["君を", 0, 1, "きみ"],
  ["君の", 0, 1, "きみ"],
  ["君に", 0, 1, "きみ"],
  ["君も", 0, 1, "きみ"],
  ["君へ", 0, 1, "きみ"],
  ["君だ", 0, 1, "きみ"],
  ["君じゃ", 0, 1, "きみ"],
  ["君なら", 0, 1, "きみ"],
  ["君たち", 0, 1, "きみ"],
  // 寂しい is さみしい far more often than さびしい in lyrics.
  ["寂しい", 0, 1, "さみ"],
  ["寂しく", 0, 1, "さみ"],
  ["寂しさ", 0, 1, "さみ"],
  // Standalone 後 + particle is のち, not the ご of a compound (後で / 後ろ excluded:
  // those are あとで / うしろ).
  ["後は", 0, 1, "のち"],
  ["後に", 0, 1, "のち"],
  ["後の", 0, 1, "のち"],
  ["後も", 0, 1, "のち"],
  ["後を", 0, 1, "のち"],
  ["後が", 0, 1, "のち"],
  ["後と", 0, 1, "のち"],
  ["後だ", 0, 1, "のち"],
  ["一人", 0, 2, "ひとり"],
  ["二人", 0, 2, "ふたり"],
  ["1人", 0, 2, "ひとり"],
  ["2人", 0, 2, "ふたり"],
  ["１人", 0, 2, "ひとり"],
  ["２人", 0, 2, "ふたり"],
  ["大人", 0, 2, "おとな"],
  // 泥濘む is ぬかるむ (kun), not the on-reading でいねい Google/kuromoji reach for.
  ["泥濘む", 0, 2, "ぬかる"],
  ["足元", 0, 2, "あしもと"],
  ["今日", 0, 2, "きょう"],
  ["明日", 0, 2, "あした"],
  ["昨日", 0, 2, "きのう"],
  // Google/romaji drift あい for the そう of 相対性 (そうたいせい).
  ["相対性", 0, 3, "そうたいせい"],
  // 空回る/空回り is からまわ (kun) in casual speech/lyrics, not そらまわ.
  ["空回", 0, 2, "からまわ"],
  ["何度", 0, 2, "なんど"],
  // Standalone 傍 + particle is そば, matching the 側 entries above.
  ["傍に", 0, 1, "そば"],
  ["傍で", 0, 1, "そば"],
  ["傍から", 0, 1, "そば"],
  ["傍へ", 0, 1, "そば"],
  // 熟れる (ripen) is うれる, not なれる/こなれる.
  ["熟れ", 0, 1, "う"],
  ["惰性", 0, 2, "だせい"],
  ["後味悪", 0, 3, "あとあじわる"],
];

type KuromojiToken = { surface_form: string; reading?: string };
type Analyzer = { parse(text: string): Promise<KuromojiToken[]> };

/** One kanji run in a line: kana reading + character offset into the line. */
type KanjiRun = { start: number; end: number; reading: string };

let analyzerPromise: Promise<Analyzer> | null = null;
const tokenCache = new Map<string, KuromojiToken[]>();

/** Hiragana or katakana - a script no language other than Japanese uses. */
export function hasKana(text: string): boolean {
  return KANA_RE.test(text);
}

export function shouldFurigana(text: string, sourceLanguage?: string | null): boolean {
  if (!text) return false;
  // Kana is unambiguously Japanese - trust it over a language guess that may have
  // been thrown off by a latin title / feat. credit (e.g. "レプリカ - Replica").
  if (KANA_RE.test(text)) return true;
  if (sourceLanguage) return sourceLanguage.toLowerCase().startsWith("ja");
  return false;
}

function katakanaToHiragana(input: string): string {
  return input.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

const isKanjiish = (ch: string) => KANJI_RE.test(ch);

// -- Romaji -> hiragana ---------------------------------------------------

// Longest-first so "kyo" wins before "ki", "sha" before "sa", etc.
const ROMAJI_TABLE: ReadonlyArray<readonly [string, string]> = [
  ["kya", "きゃ"],
  ["kyu", "きゅ"],
  ["kyo", "きょ"],
  ["gya", "ぎゃ"],
  ["gyu", "ぎゅ"],
  ["gyo", "ぎょ"],
  ["sha", "しゃ"],
  ["shu", "しゅ"],
  ["sho", "しょ"],
  ["shi", "し"],
  ["she", "しぇ"],
  ["cha", "ちゃ"],
  ["chu", "ちゅ"],
  ["cho", "ちょ"],
  ["chi", "ち"],
  ["che", "ちぇ"],
  ["ja", "じゃ"],
  ["ju", "じゅ"],
  ["jo", "じょ"],
  ["ji", "じ"],
  ["je", "じぇ"],
  ["nya", "にゃ"],
  ["nyu", "にゅ"],
  ["nyo", "にょ"],
  ["hya", "ひゃ"],
  ["hyu", "ひゅ"],
  ["hyo", "ひょ"],
  ["bya", "びゃ"],
  ["byu", "びゅ"],
  ["byo", "びょ"],
  ["pya", "ぴゃ"],
  ["pyu", "ぴゅ"],
  ["pyo", "ぴょ"],
  ["mya", "みゃ"],
  ["myu", "みゅ"],
  ["myo", "みょ"],
  ["rya", "りゃ"],
  ["ryu", "りゅ"],
  ["ryo", "りょ"],
  ["tsu", "つ"],
  ["dzu", "づ"],
  ["fa", "ふぁ"],
  ["fi", "ふぃ"],
  ["fe", "ふぇ"],
  ["fo", "ふぉ"],
  ["fu", "ふ"],
  ["va", "ゔぁ"],
  ["vi", "ゔぃ"],
  ["ve", "ゔぇ"],
  ["vo", "ゔぉ"],
  ["vu", "ゔ"],
  ["ka", "か"],
  ["ki", "き"],
  ["ku", "く"],
  ["ke", "け"],
  ["ko", "こ"],
  ["ga", "が"],
  ["gi", "ぎ"],
  ["gu", "ぐ"],
  ["ge", "げ"],
  ["go", "ご"],
  ["sa", "さ"],
  ["si", "し"],
  ["su", "す"],
  ["se", "せ"],
  ["so", "そ"],
  ["za", "ざ"],
  ["zi", "じ"],
  ["zu", "ず"],
  ["ze", "ぜ"],
  ["zo", "ぞ"],
  ["ta", "た"],
  ["ti", "ち"],
  ["tu", "つ"],
  ["te", "て"],
  ["to", "と"],
  ["da", "だ"],
  ["di", "ぢ"],
  ["du", "づ"],
  ["de", "で"],
  ["do", "ど"],
  ["na", "な"],
  ["ni", "に"],
  ["nu", "ぬ"],
  ["ne", "ね"],
  ["no", "の"],
  ["ha", "は"],
  ["hi", "ひ"],
  ["hu", "ふ"],
  ["he", "へ"],
  ["ho", "ほ"],
  ["ba", "ば"],
  ["bi", "び"],
  ["bu", "ぶ"],
  ["be", "べ"],
  ["bo", "ぼ"],
  ["pa", "ぱ"],
  ["pi", "ぴ"],
  ["pu", "ぷ"],
  ["pe", "ぺ"],
  ["po", "ぽ"],
  ["ma", "ま"],
  ["mi", "み"],
  ["mu", "む"],
  ["me", "め"],
  ["mo", "も"],
  ["ya", "や"],
  ["yu", "ゆ"],
  ["yo", "よ"],
  ["ra", "ら"],
  ["ri", "り"],
  ["ru", "る"],
  ["re", "れ"],
  ["ro", "ろ"],
  ["wa", "わ"],
  ["wo", "を"],
  ["wi", "ゐ"],
  ["we", "ゑ"],
  ["a", "あ"],
  ["i", "い"],
  ["u", "う"],
  ["e", "え"],
  ["o", "お"],
  ["n", "ん"],
];

/**
 * Cleans up quirks in Google's romaji transliteration before conversion:
 * corner-bracket quotes, its "~tsu" notation for a stand-alone sokuon, detached
 * combining macrons ("a ̄" -> "ā"), and suffix hyphens ("samu-sa" -> "samusa").
 */
function normalizeGoogleRomaji(input: string): string {
  return input
    .replace(/\s*̄/g, "̄")
    .normalize("NFC")
    .replace(/[`'‘’"“”«»「」『』〈〉《》【】]/g, " ")
    .replace(/[~〜～]\s*tsu/gi, "っ")
    .replace(/[~〜～]/g, " ")
    .replace(/(\p{L})-(\p{L})/gu, "$1$2");
}

/** Reverse-Hepburn: converts a romaji reading to hiragana, best effort. */
function romajiToHiragana(input: string): string {
  let s = normalizeGoogleRomaji(input).toLowerCase();
  // long vowels -> the doubling most common for kanji readings
  s = s
    .replace(/ā/g, "aa")
    .replace(/ī/g, "ii")
    .replace(/ū/g, "uu")
    .replace(/ē/g, "ei")
    .replace(/ō/g, "ou")
    .replace(/â/g, "aa")
    .replace(/î/g, "ii")
    .replace(/û/g, "uu")
    .replace(/ê/g, "ei")
    .replace(/ô/g, "ou")
    .replace(/[‘’ʼ`]/g, "'");

  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];

    if (ch === " " || ch === "\t" || ch === "\n") {
      out += " ";
      i++;
      continue;
    }

    // sokuon: doubled consonant (kk, tt, ss, pp, tch...)
    if (ch !== "n" && !"aeiou".includes(ch)) {
      if (s.startsWith("tch", i) || ch === s[i + 1]) {
        out += "っ";
        i++;
        continue;
      }
    }

    // moraic n: not before a vowel or y
    if (ch === "n") {
      const after = s[i + 1];
      if (after === "'") {
        out += "ん";
        i += 2;
        continue;
      }
      if (after === undefined || !"aeiouy".includes(after)) {
        out += "ん";
        i++;
        continue;
      }
    }

    let matched = false;
    for (const [rom, kana] of ROMAJI_TABLE) {
      if (s.startsWith(rom, i)) {
        out += kana;
        i += rom.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += ch;
      i++;
    }
  }
  return out;
}

// -- Alignment ----------------------------------------------------------

// Google spells particles phonetically (は as "wa", へ as "e", を as "o"), so an
// anchor taken from the surface may not match the reading verbatim.
const PARTICLE_ALT: ReadonlyArray<readonly [string, string]> = [
  ["は", "わ"],
  ["へ", "え"],
  ["を", "お"],
];

// Single-kana grammatical particles - when one of these follows a kanji it is
// NOT that kanji's okurigana.
const PARTICLE_KANA = new Set([
  "の",
  "は",
  "を",
  "に",
  "へ",
  "と",
  "も",
  "が",
  "や",
  "か",
  "ね",
  "よ",
  "わ",
  "さ",
  "ぞ",
  "な",
]);

function withParticleAlt(kana: string): string {
  let alt = kana;
  for (const [k, v] of PARTICLE_ALT) alt = alt.split(k).join(v);
  return alt;
}

function findAnchor(reading: string, kana: string, from: number): number {
  for (const candidate of new Set([kana, withParticleAlt(kana)])) {
    const at = reading.indexOf(candidate, from);
    if (at !== -1) return at;
  }
  // A chōonpu (ロー vs ロウ) or a dropped one: try the long mark as each vowel.
  if (kana.includes("ー")) {
    for (const rep of ["う", "お", "あ", "い", "え", ""]) {
      const swapped = kana.split("ー").join(rep);
      for (const candidate of new Set([swapped, withParticleAlt(swapped)])) {
        const at = reading.indexOf(candidate, from);
        if (at !== -1) return at;
      }
    }
  }
  return -1;
}

/**
 * Splits `surface` into maximal kanji / kana runs and, using the kana runs as
 * anchors into `reading`, returns the kana reading of each kanji run with its
 * character offset. Works for a whole line or a single token.
 */
function alignKanjiRuns(surface: string, rawReading: string): { offset: number; end: number; reading: string }[] {
  // Punctuation / spaces / latin that Google passes through the romaji would
  // otherwise land inside a run or break an anchor - keep only kana here.
  const reading = rawReading.replace(/[^぀-ゟ゠-ヿー]/g, "");
  const runs: { offset: number; end: number; reading: string }[] = [];
  let readIdx = 0;
  let i = 0;

  while (i < surface.length) {
    // Anything that is not a kanji - kana, punctuation, digits, latin - is an
    // anchor only: it never gets furigana, it just keeps us in sync with the
    // reading. Kana are expected in the reading; punctuation usually is not, so a
    // miss there is fine (leave the cursor put).
    if (!isKanjiish(surface[i])) {
      let j = i;
      while (j < surface.length && !isKanjiish(surface[j])) j++;
      const seg = surface.slice(i, j);
      const kanaSeg = seg.replace(/[^぀-ゟ゠-ヿー]/g, "");
      if (kanaSeg) {
        const at = findAnchor(reading, kanaSeg, readIdx);
        if (at !== -1) {
          readIdx = at + kanaSeg.length;
        } else if (kanaSeg.length >= 2) {
          // Google may have transliterated Latin ("lie" -> いえ) sitting between
          // the seg's kana, so match its first and last kana as separate anchors.
          const first = findAnchor(reading, kanaSeg[0], readIdx);
          const last = first !== -1 ? reading.indexOf(kanaSeg[kanaSeg.length - 1], first + 1) : -1;
          readIdx = last !== -1 ? last + 1 : first !== -1 ? first + 1 : readIdx + kanaSeg.length;
        } else {
          readIdx += kanaSeg.length;
        }
      }
      i = j;
      continue;
    }

    // Collect a chain of kanji runs joined only by spaces / punctuation (no kana
    // to anchor on between them), e.g. "三歩 僕". The reading stretch up to the
    // next real kana anchor covers the whole chain, so split it between the runs
    // by kanji count instead of letting the first run swallow it.
    const chain: { start: number; end: number }[] = [];
    let k = i;
    while (k < surface.length) {
      if (isKanjiish(surface[k])) {
        let e = k;
        while (e < surface.length && isKanjiish(surface[e])) e++;
        chain.push({ start: k, end: e });
        k = e;
      } else {
        let e = k;
        while (e < surface.length && !isKanjiish(surface[e])) e++;
        const gap = surface.slice(k, e);
        // Stop the chain at a real kana anchor, or at a digit - number+counter
        // readings (1分, 一秒) rendaku unpredictably and Google mangles them, so
        // splitting a chain across one only produces garbage.
        if (gap.replace(/[^぀-ゟ゠-ヿー]/g, "") || /[0-9０-９]/.test(gap)) break;
        k = e; // only punctuation / spaces - keep chaining
      }
    }

    const totalKanji = chain.reduce((sum, c) => sum + (c.end - c.start), 0);

    let anchorAt = reading.length;
    let anchorIsOkurigana = false;
    if (k < surface.length) {
      let e = k;
      while (e < surface.length && !isKanjiish(surface[e])) e++;
      const kanaSeg = surface.slice(k, e).replace(/[^぀-ゟ゠-ヿー]/g, "");
      // Require at least one kana per kanji before accepting the anchor so a
      // short kana that also occurs inside the reading (月 = つき, then 行き's き)
      // doesn't cut it short.
      const found = kanaSeg ? findAnchor(reading, kanaSeg, readIdx + totalKanji) : -1;
      anchorAt = found !== -1 ? found : Math.min(readIdx + totalKanji * 2, reading.length);
      // A non-particle kana right after the chain is okurigana attached to the
      // last kanji, so that run's reading is short (変え -> 変 = か). A particle
      // (三歩 の...) tells us nothing about the run length.
      anchorIsOkurigana = found !== -1 && !PARTICLE_KANA.has(kanaSeg[0]);
    }

    const span = reading.slice(readIdx, anchorAt);
    const lastKc = chain.length ? chain[chain.length - 1].end - chain[chain.length - 1].start : 0;
    let consumed = 0;
    chain.forEach((c, ci) => {
      const kc = c.end - c.start;
      let take: number;
      if (ci === chain.length - 1) {
        take = span.length - consumed;
      } else if (anchorIsOkurigana && ci === chain.length - 2) {
        // Leave the okurigana-bound final run just ~1 kana per kanji; the rest
        // belongs to the compound before it.
        take = Math.max(1, span.length - consumed - lastKc);
      } else {
        take = Math.round((span.length * kc) / (totalKanji || 1));
      }
      const rr = span.slice(consumed, consumed + take).trim();
      consumed += take;
      // A digit right before the kanji means it is a counter (1分, 3秒) whose
      // reading we can't derive reliably - skip rather than guess wrong.
      const afterDigit = /[0-9０-９]/.test(surface[c.start - 1] ?? "");
      // A reading far longer than its kanji run means the anchors drifted - drop it.
      if (!afterDigit && rr && rr !== surface.slice(c.start, c.end) && !LATIN_RE.test(rr) && rr.length <= kc * 4 + 2) {
        runs.push({ offset: c.start, end: c.end, reading: rr });
      }
    });

    readIdx = anchorAt;
    i = k;
  }

  return runs;
}

function applyOverrides(fullText: string, runs: KanjiRun[]): KanjiRun[] {
  let result = runs;
  const claimed: [number, number][] = [];
  // Longest match wins: 愛してる before 愛して, 一昨日 before 昨日. Song overrides
  // come first so they win ties against the static table (stable sort).
  const ordered = [...songOverrides, ...READING_OVERRIDES].sort((a, b) => b[0].length - a[0].length);
  for (const [key, kStart, kEnd, yomi] of ordered) {
    let idx = fullText.indexOf(key);
    while (idx !== -1) {
      const matchEnd = idx + key.length;
      const runStart = idx + kStart;
      const runEnd = idx + kEnd;
      // Skip when a kanji touches the match on the side its kanji sits (一昨日 is
      // not 一 + 昨日) or the span is already covered by a longer override.
      // A kanji touching the match means it is part of a bigger compound
      // (茶の間 is not 茶 の 間=あいだ; その先生 is not その 先=さき 生). The
      // after-check only matters when the match ends on a kanji - a trailing
      // kana particle (他に, 側に) is already a hard word boundary.
      const before = fullText[idx - 1];
      const after = isKanjiish(key[key.length - 1]) ? fullText[matchEnd] : undefined;
      // claimed tracks the kanji ranges taken, so two entries on one match key
      // (糸解 -> 糸:いと + 解:ほど) don't block each other.
      const overlaps = claimed.some(([s, e]) => runStart < e && runEnd > s);
      if (!overlaps && !(before && isKanjiish(before)) && !(after && isKanjiish(after))) {
        result = result.filter(r => r.end <= runStart || r.start >= runEnd);
        result.push({ start: runStart, end: runEnd, reading: yomi });
        claimed.push([runStart, runEnd]);
      }
      idx = fullText.indexOf(key, idx + key.length);
    }
  }
  return result.sort((a, b) => a.start - b.start);
}

// -- DOM attach -------------------------------------------------------

/**
 * Positions each run's reading above its kanji inside `lineEl`. Returns the
 * number of readings actually attached.
 */
function attachFuriganaRuns(lineEl: HTMLElement, fullText: string, runs: KanjiRun[]): number {
  if (!runs.length) return 0;

  const spans: { el: HTMLElement; start: number; end: number }[] = [];
  let cursor = 0;
  for (const el of lineEl.querySelectorAll<HTMLElement>(`.${WORD_CLASS}`)) {
    const surface = el.textContent ?? "";
    if (!surface) continue;
    const at = fullText.indexOf(surface, cursor);
    if (at === -1) continue;
    spans.push({ el, start: at, end: at + surface.length });
    cursor = at + surface.length;
  }
  if (!spans.length) return 0;

  // Rect of a single character `k` inside a word span's text node.
  const charRect = (sp: { el: HTMLElement; start: number }, k: number): DOMRect | null => {
    const node = sp.el.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const nlen = node.textContent?.length ?? 0;
    const a = Math.min(Math.max(k, 0), Math.max(nlen - 1, 0));
    try {
      const r = document.createRange();
      r.setStart(node, a);
      r.setEnd(node, Math.min(a + 1, nlen));
      return r.getBoundingClientRect();
    } catch {
      return null;
    }
  };

  let attached = 0;
  const placed: PlacedFurigana[] = [];
  for (const run of runs) {
    // The run can straddle several word spans (rich-sync often gives one span per
    // character). Anchor the reading on the span holding its first kanji, but
    // measure its true extent from the first and last kanji wherever they live.
    const startSpan =
      spans.find(sp => run.start >= sp.start && run.start < sp.end) ?? spans.find(sp => sp.end > run.start);
    if (!startSpan) continue;
    const endSpan = spans.find(sp => run.end - 1 >= sp.start && run.end - 1 < sp.end) ?? startSpan;

    const textNode = startSpan.el.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;

    let centerPx = 0;
    // Rendered width of the kanji this reading sits over, in viewport px, used by
    // the collision pass to decide which readings to condense.
    let kanjiWidthPx = 0;
    try {
      const first = charRect(startSpan, run.start - startSpan.start);
      const last = charRect(endSpan, run.end - 1 - endSpan.start);
      const wordRect = startSpan.el.getBoundingClientRect();
      // getBoundingClientRect is post-scale (the line is scaled); convert the
      // delta back into the anchor word's own unscaled pixels. Centre the reading
      // on the midpoint of the run's first-to-last kanji.
      const scale = startSpan.el.offsetWidth > 0 ? wordRect.width / startSpan.el.offsetWidth : 1;
      if (first && last && scale > 0) {
        centerPx = ((first.left + last.right) / 2 - wordRect.left) / scale;
        kanjiWidthPx = Math.max(0, last.right - first.left);
      }
    } catch {
      centerPx = 0;
    }
    const span = startSpan;

    // How long the karaoke sweep should take: the time to sing just this run's
    // kanji, pro-rated out of every word span the run overlaps (the reading of
    // 旅立 must not sweep at the speed of 旅立つ, nor a 3-kanji word at 1-kanji
    // speed when rich-sync splits it per character).
    let runDurSec = 0;
    for (const sp of spans) {
      const lo = Math.max(sp.start, run.start);
      const hi = Math.min(sp.end, run.end);
      if (hi <= lo) continue;
      const spanChars = sp.end - sp.start;
      const spanDur = parseFloat(sp.el.dataset.duration ?? "0");
      if (spanChars > 0 && spanDur > 0) runDurSec += (spanDur * (hi - lo)) / spanChars;
    }

    // When the sweep starts, relative to the word span the reading hangs on: the
    // time to sing whatever precedes the run's first kanji inside that span
    // (pro-rated). A word timed as one span - 思い出, お願い - would otherwise start
    // every reading at the word's first syllable, lighting 出 / 願 up with 思 / お.
    let runOffsetSec = 0;
    const anchorChars = startSpan.end - startSpan.start;
    const anchorDur = parseFloat(startSpan.el.dataset.duration ?? "0");
    if (anchorChars > 0 && anchorDur > 0) {
      runOffsetSec = (anchorDur * Math.max(0, run.start - startSpan.start)) / anchorChars;
    }

    const rt = document.createElement("span");
    rt.className = FURIGANA_CLASS;
    rt.textContent = run.reading;
    // Mirrors .blyrics--word[data-content]: the ::after clone the karaoke sweep
    // fills so the reading lights up in step with its kanji.
    rt.dataset.content = run.reading;
    rt.setAttribute("aria-hidden", "true");
    rt.style.left = `${Math.max(centerPx, 0)}px`;
    if (runDurSec > 0) rt.style.setProperty("--blyrics-furigana-duration", `${runDurSec}s`);
    if (runOffsetSec > 0) rt.style.setProperty("--blyrics-furigana-offset", `${runOffsetSec}s`);
    span.el.appendChild(rt);
    attached++;
    placed.push({ rt, span, kanjiWidthPx });
  }

  resolveFuriganaLayout(lineEl, placed);
  return attached;
}

/** Base transform from .blyrics--furigana; scaleX for condensing is appended. */
const FURIGANA_BASE_TRANSFORM = "translate(-50%, 0.15em)";
/** A reading may be up to this multiple of its kanji's width before it is condensed. */
const FURIGANA_MAX_WIDTH_RATIO = 1.7;
/** Floor for the horizontal squeeze applied to an over-wide reading. */
const FURIGANA_MIN_SCALE_X = 0.72;
/** Gap kept between neighbouring readings, viewport px. */
const FURIGANA_MIN_GAP_PX = 3;
/** Breathing room kept inside each line edge, viewport px. */
const FURIGANA_EDGE_PAD_PX = 2;
/** Readings within this much vertical difference count as the same wrapped row. */
const FURIGANA_ROW_TOLERANCE_PX = 6;

type PlacedFurigana = {
  rt: HTMLElement;
  span: { el: HTMLElement };
  kanjiWidthPx: number;
};

/**
 * Two-part fix for crowded readings (many single kanji, each with a long reading):
 *   B - a reading far wider than its kanji is squeezed horizontally (scaleX), and
 *   A - readings that still overlap are nudged apart, then pulled back inside the
 *       line's edges. Keeps every reading legible instead of letting the next one
 *       paint over its tail.
 */
function resolveFuriganaLayout(lineEl: HTMLElement, placed: PlacedFurigana[]): void {
  if (placed.length < 1) return;

  try {
    const lineRect = lineEl.getBoundingClientRect();
    if (lineRect.width === 0) return;

    const spanScale = (el: HTMLElement): number =>
      el.offsetWidth > 0 ? el.getBoundingClientRect().width / el.offsetWidth : 1;

    // B: condense readings that overhang their kanji by too much.
    for (const p of placed) {
      if (p.kanjiWidthPx <= 0) continue;
      const w = p.rt.getBoundingClientRect().width;
      const limit = p.kanjiWidthPx * FURIGANA_MAX_WIDTH_RATIO;
      if (w > limit) {
        const s = Math.max(FURIGANA_MIN_SCALE_X, limit / w);
        p.rt.style.transform = `${FURIGANA_BASE_TRANSFORM} scaleX(${s.toFixed(3)})`;
      }
    }

    // A: resolve overlaps left-to-right, then keep each row within the line box.
    // A background/parenthetical aside wraps onto its own flex row below the main
    // words (lyrics.css .blyrics-background-lyric), so readings must be grouped by
    // row before this runs - otherwise a reading directly under one on the row
    // above (same left-aligned start X, different Y) reads as an X-axis overlap
    // and gets shoved sideways for no reason.
    const measured = placed.map(p => {
      const r = p.rt.getBoundingClientRect();
      return { p, scale: spanScale(p.span.el), left: r.left, right: r.right, top: r.top };
    });

    const rows: (typeof measured)[] = [];
    for (const it of [...measured].sort((a, b) => a.top - b.top)) {
      const row = rows.find(r => Math.abs(r[0].top - it.top) < FURIGANA_ROW_TOLERANCE_PX);
      if (row) row.push(it);
      else rows.push([it]);
    }

    const shift = (it: (typeof measured)[number], dxViewport: number): void => {
      const cur = parseFloat(it.p.rt.style.left) || 0;
      it.p.rt.style.left = `${cur + dxViewport / (it.scale || 1)}px`;
      it.left += dxViewport;
      it.right += dxViewport;
    };

    for (const row of rows) {
      const items = row.sort((a, b) => a.left - b.left);

      let cursor = lineRect.left + FURIGANA_EDGE_PAD_PX;
      for (const it of items) {
        if (it.left < cursor) shift(it, cursor - it.left);
        cursor = it.right + FURIGANA_MIN_GAP_PX;
      }

      // Overshot the right edge: walk back, pushing readings left where they fit.
      const rightLimit = lineRect.right - FURIGANA_EDGE_PAD_PX;
      if (items.length && items[items.length - 1].right > rightLimit) {
        let back = rightLimit;
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.right > back) shift(it, back - it.right);
          back = it.left - FURIGANA_MIN_GAP_PX;
        }
        // The back-pass can shove the leftmost readings off the left edge; a dense
        // row just can't fit every reading, but nothing should start off-screen.
        const leftLimit = lineRect.left + FURIGANA_EDGE_PAD_PX;
        let front = leftLimit;
        for (const it of items) {
          if (it.left < front) shift(it, front - it.left);
          front = it.right + FURIGANA_MIN_GAP_PX;
        }
      }
    }
  } catch {
    /* layout not ready - leave readings centred */
  }
}

/**
 * Primary path. Builds furigana from a Google romaji reading for the line.
 * Synchronous; returns true if it attached at least one reading.
 */
/**
 * Merges a romaji-derived run list with kuromoji's, kanji group by kanji group.
 * Romaji keeps compounds together and follows the line's context; kuromoji has a
 * dictionary. The dictionary wins on disagreement for a single kanji (愛 = あい,
 * not Google's いと) and for any run sitting in a punctuation-only kanji chain
 * (romaji's kanji-count split there is unreliable, see isChainAdjacent) -
 * otherwise a multi-kanji run keeps romaji's (kuromoji may have split it oddly).
 * A group only one side found is taken as-is.
 */
// True when, walking from `pos` in direction `dir`, a kanji is reached before
// any real kana - i.e. this run sits right next to another kanji group with
// nothing but punctuation/latin/digits between them (a "chain" in
// alignKanjiRuns's sense: "検証 is 不明瞭", "客観？主観？", "３次元(立体)").
// alignKanjiRuns splits such a chain's reading across its members by kanji
// COUNT, which is wrong whenever the members don't have equal mora-per-kanji
// (次元=3 kana/2 kanji vs 立体=4 kana/2 kanji), silently stealing characters
// from one neighbor to the other regardless of which one ends up too long or
// too short. kuromoji tokenises each word independently and isn't subject to
// this at all, so it's trustworthy here whichever direction the drift went.
function isChainAdjacent(surface: string, pos: number, dir: 1 | -1): boolean {
  for (let i = pos; i >= 0 && i < surface.length; i += dir) {
    const ch = surface[i];
    if (isKanjiish(ch)) return true;
    if (KANA_RE.test(ch)) return false;
  }
  return false;
}

// Google romanizes both おう and おお as "ō", so the romaji pass always writes the
// long vowel with う (程遠い -> ほどとう). Folding う after an o-row kana to お
// lets two readings that differ only in that spelling be recognised as the same.
function foldLongO(reading: string): string {
  return reading.replace(/([おこそとのほもよろごぞどぼぽを])う/g, "$1お");
}

function mergeRuns(surface: string, romajiRuns: KanjiRun[], kuromojiRuns: KanjiRun[]): KanjiRun[] {
  const out: KanjiRun[] = [];
  const usedK = new Set<KanjiRun>();

  for (const r of romajiRuns) {
    const exact = kuromojiRuns.find(k => k.start === r.start && k.end === r.end);
    if (exact) {
      usedK.add(exact);
      const singleKanji = r.end - r.start === 1;
      const chainAdjacent =
        !singleKanji && (isChainAdjacent(surface, r.start - 1, -1) || isChainAdjacent(surface, r.end, 1));
      // The dictionary knows whether a long o is おう or おお; romaji can't.
      const onlyLongODiffers = exact.reading !== r.reading && foldLongO(exact.reading) === foldLongO(r.reading);
      if (
        exact.reading !== r.reading &&
        (singleKanji || chainAdjacent || onlyLongODiffers) &&
        !LATIN_RE.test(exact.reading)
      ) {
        out.push({ ...r, reading: exact.reading });
      } else {
        out.push(r);
      }
      continue;
    }
    out.push(r);
  }

  // Kanji groups the romaji pass missed entirely - fill them from kuromoji.
  for (const k of kuromojiRuns) {
    if (usedK.has(k)) continue;
    if (!out.some(o => o.start < k.end && o.end > k.start)) out.push(k);
  }

  return out.sort((a, b) => a.start - b.start);
}

export async function annotateFuriganaFromRomaji(
  lineEl: HTMLElement,
  surface: string,
  romaji: string
): Promise<boolean> {
  if (!surface || !romaji || !KANJI_RE.test(surface)) return false;
  if (lineEl.querySelector(`.${FURIGANA_CLASS}`)) return true;

  const kana = romajiToHiragana(romaji).replace(/\s+/g, "");
  const latinHeavy = (kana.match(/[a-z]/gi)?.length ?? 0) > 2;

  const folded = katakanaToHiragana(surface);
  let romajiRuns: KanjiRun[] = [];
  if (KANA_RE.test(kana) && !latinHeavy) {
    romajiRuns = alignKanjiRuns(folded, kana).map(r => ({ start: r.offset, end: r.end, reading: r.reading }));
  }

  // Cross-check with the local dictionary. This loads the kuromoji dict on the
  // first Japanese line; failure (offline) just means romaji-only.
  let kuromojiRuns: KanjiRun[] = [];
  try {
    kuromojiRuns = await kuromojiKanjiRuns(surface);
  } catch {
    /* dictionary unavailable */
  }

  let runs = kuromojiRuns.length ? mergeRuns(surface, romajiRuns, kuromojiRuns) : romajiRuns;
  if (!runs.length) return false;
  runs = applyOverrides(surface, runs);

  log(
    LOG_PREFIX,
    `Furigana "${surface}" ← "${romaji.trim()}" (${romajiRuns.length}r/${kuromojiRuns.length}k) → ${
      runs.map(r => `${surface.slice(r.start, r.end)}:${r.reading}`).join(" ") || "(none)"
    }`
  );

  if (lineEl.querySelector(`.${FURIGANA_CLASS}`)) return true;
  return attachFuriganaRuns(lineEl, surface, runs) > 0;
}

// -- Fallback: local kuromoji --------------------------------------

function normalizeDigitsForTokenizer(text: string): string {
  return text.replace(/(?<![0-9０-９])[0-9０-９](?![0-9０-９])/g, d => {
    const code = d.charCodeAt(0);
    return DIGIT_KANJI[code >= 0xff10 ? code - 0xff10 : code - 0x30];
  });
}

function getAnalyzer(): Promise<Analyzer> {
  if (!analyzerPromise) {
    analyzerPromise = (async () => {
      const dictPath = chrome.runtime.getURL("dict/");
      log(LOG_PREFIX, `Furigana: loading local analyzer, dict=${dictPath}`);
      const startedAt = performance.now();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const KuroshiroCtor: any = (Kuroshiro as any).default ?? Kuroshiro;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const AnalyzerCtor: any = (KuromojiAnalyzer as any).default ?? KuromojiAnalyzer;

      const analyzer = new AnalyzerCtor({ dictPath });
      await new KuroshiroCtor().init(analyzer);
      log(LOG_PREFIX, `Furigana local analyzer ready in ${Math.round(performance.now() - startedAt)}ms`);
      return analyzer as Analyzer;
    })().catch(err => {
      analyzerPromise = null;
      throw err;
    });
  }
  return analyzerPromise;
}

/**
 * Fallback path. Tokenises the line locally with kuromoji when no romaji is
 * available. Returns true if it attached at least one reading.
 */
/** Tokenises a line with kuromoji and returns per-kanji-group readings. */
async function kuromojiKanjiRuns(fullText: string): Promise<KanjiRun[]> {
  let tokens = tokenCache.get(fullText);
  if (!tokens) {
    const analyzer = await getAnalyzer();
    tokens = await analyzer.parse(normalizeDigitsForTokenizer(fullText));
    tokenCache.set(fullText, tokens);
  }

  const runs: KanjiRun[] = [];
  let offset = 0;
  for (const tok of tokens) {
    const surface = tok.surface_form ?? "";
    const reading = tok.reading && tok.reading !== "*" ? katakanaToHiragana(tok.reading) : "";
    if (reading && isKanjiish(surface)) {
      for (const run of alignKanjiRuns(katakanaToHiragana(surface), reading)) {
        runs.push({ start: offset + run.offset, end: offset + run.end, reading: run.reading });
      }
    }
    offset += surface.length;
  }
  return runs;
}

/**
 * Fallback path: local kuromoji only, used when no romaji is available at all.
 */
export async function annotateFurigana(lineEl: HTMLElement, fullText: string): Promise<boolean> {
  if (!fullText || !KANJI_RE.test(fullText)) return false;
  if (lineEl.querySelector(`.${FURIGANA_CLASS}`)) return true;

  let runs: KanjiRun[];
  try {
    runs = await kuromojiKanjiRuns(fullText);
  } catch (err) {
    log(LOG_PREFIX, "Furigana tokenisation failed", err);
    return false;
  }
  runs = applyOverrides(fullText, runs);

  log(
    LOG_PREFIX,
    `Furigana[kuromoji] "${fullText}" → ${
      runs.map(r => `${fullText.slice(r.start, r.end)}:${r.reading}`).join(" ") || "(none)"
    }`
  );

  if (lineEl.querySelector(`.${FURIGANA_CLASS}`)) return true;
  return attachFuriganaRuns(lineEl, fullText, runs) > 0;
}

// -- LLM readings -------------------------------------------------------

const KANA_ONLY_RE = /^[\u3040-\u309f\u30a0-\u30ffー]+$/;
const SWAPPED_CLASS = "blyrics--furigana-swapped";

/**
 * Turns an LLM's (kanji text, reading) pairs for one line into runs positioned
 * in `fullText`. Pairs are matched in order; anything that doesn't line up with
 * the text, or isn't a pure kana reading, is dropped rather than guessed.
 */
function runsFromLlmPairs(fullText: string, pairs: { text: string; reading: string }[]): KanjiRun[] {
  const runs: KanjiRun[] = [];
  let cursor = 0;
  for (const pair of pairs) {
    let surface = pair.text;
    let reading = pair.reading.replace(/\s+/g, "");
    // Models sometimes leave okurigana on the surface: peel it off, and the same
    // kana off the end of the reading, so only the kanji carry a reading.
    while (surface && !isKanjiish(surface[surface.length - 1])) {
      const tail = katakanaToHiragana(surface[surface.length - 1]);
      surface = surface.slice(0, -1);
      if (reading.length > 1 && katakanaToHiragana(reading).endsWith(tail)) reading = reading.slice(0, -1);
    }
    while (surface && !isKanjiish(surface[0])) surface = surface.slice(1);
    if (!surface || !KANA_ONLY_RE.test(reading) || [...surface].some(ch => !isKanjiish(ch))) continue;

    const at = fullText.indexOf(surface, cursor);
    if (at === -1) continue;
    runs.push({ start: at, end: at + surface.length, reading });
    cursor = at + surface.length;
  }
  return runs;
}

/**
 * Quietly swaps a line's furigana for the LLM's readings once they arrive. A line
 * whose readings already match (or that the LLM gave nothing usable for) is left
 * alone, so an agreeing answer causes no flicker; changed readings fade in.
 * Returns true if the line was changed.
 */
export function applyLlmFurigana(
  lineEl: HTMLElement,
  fullText: string,
  pairs: { text: string; reading: string }[]
): boolean {
  const runs = runsFromLlmPairs(fullText, pairs);
  if (!runs.length) return false;

  const existing = Array.from(lineEl.querySelectorAll<HTMLElement>(`.${FURIGANA_CLASS}`));
  if (existing.length === runs.length && existing.every((el, i) => el.dataset.content === runs[i].reading)) {
    return false;
  }

  for (const el of existing) el.remove();
  attachFuriganaRuns(lineEl, fullText, runs);
  for (const el of lineEl.querySelectorAll<HTMLElement>(`.${FURIGANA_CLASS}`)) el.classList.add(SWAPPED_CLASS);
  return true;
}
