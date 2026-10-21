import { strict as assert } from "node:assert";

// The store imports the logger and extension constants; stub the globals they only touch when run.
const stub: any = new Proxy(function () {}, { get: () => stub, apply: () => stub, construct: () => stub });
Object.assign(globalThis, { chrome: stub });
const { emptyStore, findReading, migrateLegacyReadings, normalizeStore, withReading } = await import("./store");

// The old kanji-run map becomes whole-run entries.
const migrated = migrateLegacyReadings({ 星街: "ほしまち", "": "x", 君: "" });
assert.equal(migrated.length, 1, "blank keys and readings are dropped");
assert.deepEqual([migrated[0].match, migrated[0].start, migrated[0].end], ["星街", 0, 2], "covers the whole run");
assert.equal(migrateLegacyReadings(null).length, 0, "nothing stored migrates to nothing");

// Lookup is exact on the run, and song-specific beats global.
let store = withReading(emptyStore(), "君", "きみ");
assert.equal(findReading(store, "君"), "きみ", "global entry found");
assert.equal(findReading(store, "君達"), undefined, "a different run does not match");
store = withReading(store, "君", "くん", "song-1");
assert.equal(findReading(store, "君", "song-1"), "くん", "song entry wins in its song");
assert.equal(findReading(store, "君", "song-2"), "きみ", "other songs fall back to the global entry");
assert.equal(findReading(store, "君"), "きみ", "no song id means the global entry");

// Re-adding the same scope replaces rather than duplicates.
store = withReading(store, "君", "ぎみ");
assert.equal(store.reading.length, 2, "same match and scope is replaced");
assert.equal(findReading(store, "君"), "ぎみ", "latest reading wins");

// Disabled entries are skipped.
const disabled = { ...store, reading: store.reading.map(entry => ({ ...entry, enabled: false })) };
assert.equal(findReading(disabled, "君"), undefined, "disabled entries do not match");

// Bad stored data degrades to what is usable.
const messy = normalizeStore({
  reading: [{ match: "愛", start: 0, end: 1, reading: "あい" }, { match: "愛", start: 2, end: 1, reading: "x" }, 7],
  glossary: [
    { term: "界隈", target: "무리" },
    { term: "", target: "x" },
  ],
  song: "oops",
});
assert.equal(messy.reading.length, 1, "malformed readings are dropped");
assert.equal(messy.reading[0].enabled, true, "enabled defaults to true");
assert.equal(messy.glossary.length, 1, "malformed glossary entries are dropped");
assert.deepEqual(messy.song, {}, "a non-object song map is reset");
assert.deepEqual(normalizeStore("garbage"), emptyStore(), "non-object input gives an empty store");

console.log("exceptions store selfcheck passed");
