/**
 * Furigana DOM: hangs a reading above each kanji run and sweeps it in step with the word.
 *
 * World-agnostic on purpose: everything takes the `Document` it works in and reads only the
 * renderer's public `LineData`/`PartData`, so the same functions serve the side panel and the
 * Picture-in-Picture window (which runs in another document, and on Firefox in the page world with
 * no `chrome.*`). Nothing here may import the kuromoji/kuroshiro pipeline.
 */
import type { LineData, PartData } from "@braccato/core";

export type FuriganaRun = { start: number; end: number; reading: string };

export const FURIGANA_CLASS = "blyrics--furigana";
const FURIGANA_HIGHLIGHT_CLASS = "blyrics--furigana-hl";
const FURIGANA_SWAPPED_CLASS = "blyrics--furigana-swapped";
const AMOUNT_START = "--lyric-transition-amount-start";
const AMOUNT_END = "--lyric-transition-amount-end";

/** Text of a word element without the readings hung on it. */
function wordText(el: HTMLElement): string {
  return el.dataset.content ?? "";
}

/** Rect of the character at `offset` in a word's text, whether it is one text node or letter spans. */
function charRect(doc: Document, el: HTMLElement, offset: number): DOMRect | null {
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: node =>
      node.parentElement?.closest(`.${FURIGANA_CLASS}`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  let seen = 0;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const len = node.data.length;
    last = node;
    if (offset < seen + len) return rangeRect(doc, node, offset - seen);
    seen += len;
  }
  return last ? rangeRect(doc, last, Math.max(last.data.length - 1, 0)) : null;
}

function rangeRect(doc: Document, node: Text, at: number): DOMRect | null {
  try {
    const range = doc.createRange();
    const a = Math.min(Math.max(at, 0), Math.max(node.data.length - 1, 0));
    range.setStart(node, a);
    range.setEnd(node, Math.min(a + 1, node.data.length));
    return range.getBoundingClientRect();
  } catch {
    return null;
  }
}

/**
 * Positions each run's reading above its kanji inside the line. Returns the number of readings
 * attached. `fullText` is the line's text; the word elements come from `line.parts`.
 */
export function attachFuriganaRuns(doc: Document, line: LineData, fullText: string, runs: FuriganaRun[]): number {
  if (!runs.length) return 0;

  const spans: { part: PartData; el: HTMLElement; start: number; end: number }[] = [];
  let cursor = 0;
  for (const part of line.parts) {
    const surface = wordText(part.lyricElement);
    if (!surface) continue;
    const at = fullText.indexOf(surface, cursor);
    if (at === -1) continue;
    spans.push({ part, el: part.lyricElement, start: at, end: at + surface.length });
    cursor = at + surface.length;
  }
  if (!spans.length) return 0;

  let attached = 0;
  const placed: PlacedFurigana[] = [];
  for (const run of runs) {
    // The run can straddle several word spans (rich-sync often gives one span per character).
    // Anchor the reading on the span holding its first kanji, but measure its true extent from the
    // first and last kanji wherever they live.
    const startSpan =
      spans.find(sp => run.start >= sp.start && run.start < sp.end) ?? spans.find(sp => sp.end > run.start);
    if (!startSpan) continue;
    const endSpan = spans.find(sp => run.end - 1 >= sp.start && run.end - 1 < sp.end) ?? startSpan;

    let centerPx = 0;
    // Rendered width of the kanji this reading sits over, in viewport px, used by the collision
    // pass to decide which readings to condense.
    let kanjiWidthPx = 0;
    const first = charRect(doc, startSpan.el, run.start - startSpan.start);
    const last = charRect(doc, endSpan.el, run.end - 1 - endSpan.start);
    const wordRect = startSpan.el.getBoundingClientRect();
    // getBoundingClientRect is post-scale (the line is scaled); convert the delta back into the
    // anchor word's own unscaled pixels.
    const scale = startSpan.el.offsetWidth > 0 ? wordRect.width / startSpan.el.offsetWidth : 1;
    if (first && last && scale > 0) {
      centerPx = ((first.left + last.right) / 2 - wordRect.left) / scale;
      kanjiWidthPx = Math.max(0, last.right - first.left);
    }

    // How long the sweep should take: the time to sing just this run's kanji, pro-rated out of
    // every word the run overlaps (the reading of 旅立 must not sweep at the speed of 旅立つ).
    let runDurSec = 0;
    for (const sp of spans) {
      const lo = Math.max(sp.start, run.start);
      const hi = Math.min(sp.end, run.end);
      if (hi <= lo) continue;
      const spanChars = sp.end - sp.start;
      if (spanChars > 0 && sp.part.duration > 0) runDurSec += (sp.part.duration * (hi - lo)) / spanChars;
    }

    // When the sweep starts, relative to the word the reading hangs on: the time to sing whatever
    // precedes the run's first kanji inside that word (pro-rated). A word timed as one span, like
    // 思い出 or お願い, would otherwise light 出 / 願 up together with 思 / お.
    const anchorChars = startSpan.end - startSpan.start;
    const anchorDur = startSpan.part.duration;
    const runOffsetSec =
      anchorChars > 0 && anchorDur > 0 ? (anchorDur * Math.max(0, run.start - startSpan.start)) / anchorChars : 0;

    const rt = doc.createElement("span");
    rt.className = FURIGANA_CLASS;
    rt.setAttribute("aria-hidden", "true");
    rt.dataset.reading = run.reading;
    rt.append(run.reading);
    const highlight = doc.createElement("span");
    highlight.className = FURIGANA_HIGHLIGHT_CLASS;
    highlight.textContent = run.reading;
    rt.append(highlight);
    rt.style.left = `${Math.max(centerPx, 0)}px`;
    startSpan.el.appendChild(rt);
    attached++;
    placed.push({ rt, span: startSpan, kanjiWidthPx });

    trackSweep(doc, {
      line,
      part: startSpan.part,
      highlight,
      offsetFraction: anchorDur > 0 ? runOffsetSec / anchorDur : 0,
      durationFraction: anchorDur > 0 && runDurSec > 0 ? Math.min(runDurSec / anchorDur, 1) : 1,
      source: null,
      mirror: null,
    });
  }

  resolveFuriganaLayout(line.lyricElement, placed);
  return attached;
}

/** Readings currently on a line, in order. */
export function existingReadings(line: LineData): string[] {
  return Array.from(
    line.lyricElement.querySelectorAll<HTMLElement>(`.${FURIGANA_CLASS}`),
    el => el.dataset.reading ?? ""
  );
}

export function removeFurigana(line: LineData): void {
  for (const el of line.lyricElement.querySelectorAll(`.${FURIGANA_CLASS}`)) el.remove();
}

/** Marks a line's readings as replacements so they fade in over the ones they replaced. */
export function markFuriganaSwapped(line: LineData): void {
  for (const el of line.lyricElement.querySelectorAll(`.${FURIGANA_CLASS}`)) el.classList.add(FURIGANA_SWAPPED_CLASS);
}

// -- Sweep ------------------------------------------------------------------

/**
 * The core sweeps a word's highlight with Web Animations it keeps in `PartData.animations`. A
 * reading cannot ride that: it sweeps only over its own kanji, at its own offset in the word. So
 * each reading gets an animation of its own on its highlight clone, copied from the word's (same
 * keyframes, timing scaled to the reading's share) and kept on the word's clock: current time,
 * play state and rate are mirrored every frame while the line is animating.
 */
interface SweepEntry {
  line: LineData;
  part: PartData;
  highlight: HTMLElement;
  offsetFraction: number;
  durationFraction: number;
  source: Animation | null;
  mirror: Animation | null;
}

interface SweepRegistry {
  entries: Set<SweepEntry>;
  running: boolean;
}

type PickedSource = { animation: Animation; kind: "swipe" | "letters" | "fade" };

const registries = new WeakMap<Document, SweepRegistry>();
/** A mirror this far from its source, in ms, is snapped back onto it. */
const DRIFT_TOLERANCE_MS = 40;

function keyframesOf(animation: Animation): Keyframe[] {
  const effect = animation.effect as KeyframeEffect | null;
  return typeof effect?.getKeyframes === "function" ? (effect.getKeyframes() as Keyframe[]) : [];
}

function pickSource(part: PartData): PickedSource | null {
  if (part.animations.length === 0) return null;
  if (part.highlightLetterElements?.length) return { animation: part.animations[0], kind: "letters" };
  const swipe = part.animations.find(a => keyframesOf(a).some(frame => AMOUNT_START in frame && !("opacity" in frame)));
  if (swipe) return { animation: swipe, kind: "swipe" };
  const fade = part.animations.find(a => keyframesOf(a).some(frame => "opacity" in frame));
  return fade ? { animation: fade, kind: "fade" } : null;
}

function createMirror(entry: SweepEntry, picked: PickedSource): Animation | null {
  const { animation, kind } = picked;
  const timing = (animation.effect as AnimationEffect).getTiming();
  const wordMs = kind === "letters" ? entry.part.duration * 1000 : Number(timing.duration) || 0;
  if (wordMs <= 0 && kind !== "fade") return null;

  let keyframes: Keyframe[];
  let options: KeyframeAnimationOptions;
  if (kind === "letters") {
    // Letters reveal through masks, which a reading has none of: sweep the plain gradient instead.
    keyframes = [
      { [AMOUNT_START]: -0.2, [AMOUNT_END]: -0.1 },
      { [AMOUNT_START]: 1.4, [AMOUNT_END]: 1.5 },
    ];
    options = {
      duration: Math.max(wordMs * entry.durationFraction, 1),
      delay: wordMs * entry.offsetFraction,
      easing: "linear",
      fill: "both",
    };
  } else if (kind === "swipe") {
    keyframes = keyframesOf(animation);
    options = {
      duration: Math.max(wordMs * entry.durationFraction, 1),
      delay: Number(timing.delay ?? 0) + wordMs * entry.offsetFraction,
      easing: timing.easing,
      fill: "both",
    };
  } else {
    // Line-synced word: the highlight only fades in, whole; the reading fades with it.
    keyframes = keyframesOf(animation).map(frame => ({ ...frame, [AMOUNT_START]: 1.4, [AMOUNT_END]: 1.5 }));
    options = {
      duration: Number(timing.duration) || 1,
      delay: Number(timing.delay ?? 0),
      easing: timing.easing,
      fill: "both",
    };
  }

  const mirror = entry.highlight.animate(keyframes, options);
  mirror.currentTime = Number(animation.currentTime ?? 0);
  if (animation.playState === "paused") mirror.pause();
  return mirror;
}

function syncSweep(entry: SweepEntry): void {
  const picked = pickSource(entry.part);
  if (!picked) {
    entry.mirror?.cancel();
    entry.mirror = null;
    entry.source = null;
    return;
  }
  const { animation } = picked;
  if (animation !== entry.source) {
    entry.mirror?.cancel();
    entry.source = animation;
    entry.mirror = createMirror(entry, picked);
    return;
  }
  const mirror = entry.mirror;
  if (!mirror) return;

  if (mirror.playbackRate !== animation.playbackRate) mirror.playbackRate = animation.playbackRate;
  const paused = animation.playState === "paused";
  if (paused && mirror.playState === "running") mirror.pause();
  else if (!paused && mirror.playState === "paused") mirror.play();

  const target = Number(animation.currentTime ?? 0);
  if (Math.abs(target - Number(mirror.currentTime ?? 0)) > DRIFT_TOLERANCE_MS) mirror.currentTime = target;
}

function trackSweep(doc: Document, entry: SweepEntry): void {
  let registry = registries.get(doc);
  if (!registry) {
    registry = { entries: new Set(), running: false };
    registries.set(doc, registry);
  }
  registry.entries.add(entry);
  if (registry.running) return;
  const view = doc.defaultView;
  if (!view) return;

  registry.running = true;
  const frame = (): void => {
    const current = registries.get(doc);
    if (!current) return;
    for (const item of current.entries) {
      if (!item.highlight.isConnected) {
        item.mirror?.cancel();
        current.entries.delete(item);
        continue;
      }
      // An idle line has nothing to follow; only a mirror still running needs a last look.
      if (item.line.isAnimating || item.mirror) syncSweep(item);
    }
    if (current.entries.size === 0) {
      current.running = false;
      return;
    }
    view.requestAnimationFrame(frame);
  };
  view.requestAnimationFrame(frame);
}

// -- Layout -----------------------------------------------------------------

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
