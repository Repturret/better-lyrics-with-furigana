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
    // The exact kanji this reading sits over, so a manual edit (furiganaEditing.ts) knows what to
    // key its override on without having to re-derive it from layout.
    rt.dataset.surface = fullText.slice(run.start, run.end);
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
      offsetMs: runOffsetSec * 1000,
      durationMs: runDurSec > 0 ? runDurSec * 1000 : anchorDur * 1000,
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

/**
 * Replaces a single reading's text in place (its visible label and its sweep clone), for a manual
 * correction (furiganaEditing.ts) - the sweep already running on `.blyrics--furigana-hl` keeps
 * animating the same element, so nothing about the run's timing needs to be rebuilt for this.
 */
export function updateFuriganaReading(rt: HTMLElement, reading: string): void {
  rt.dataset.reading = reading;
  const label = rt.firstChild;
  if (label?.nodeType === Node.TEXT_NODE) label.nodeValue = reading;
  const highlight = rt.querySelector<HTMLElement>(`.${FURIGANA_HIGHLIGHT_CLASS}`);
  if (highlight) highlight.textContent = reading;
}

// -- Sweep ------------------------------------------------------------------

/**
 * The core sweeps a word's highlight with a Web Animation it keeps in `PartData.animations`. A
 * reading cannot ride that animation directly: it sweeps only over its own kanji, at its own offset
 * within the word, and a run commonly spans several words besides (rich-sync often gives one word
 * span per character, so a 2+-kanji reading routinely does). So this reads that animation's
 * `currentTime` - which, however many words the run spans, means "ms elapsed since `part` itself
 * started singing", continuously, for as long as the line stays active, well past that one word's
 * own window - and recomputes the reading's fill fraction from scratch every frame, writing it
 * straight onto the highlight clone's `--lyric-transition-amount-*` custom properties.
 *
 * Earlier this cloned a second Animation and kept it in step with the source's `currentTime`,
 * snapping it back on drift past a tolerance. Two clocks that are each only approximately kept in
 * sync is exactly the shape of bug this showed: multi-span runs stalling partway, or finishing the
 * instant the source's own word did. Recomputing directly from the one real clock every frame has
 * nothing left to drift from it, and reading a paused or seeked animation's `currentTime` already
 * gives the right answer with no pause/seek handling of our own needed.
 */
interface SweepEntry {
  line: LineData;
  part: PartData;
  highlight: HTMLElement;
  /** Absolute ms, on `part`'s own animation's clock (ms elapsed since `part` itself started
   *  singing), marking where in that clock this reading's own sweep is active. */
  offsetMs: number;
  durationMs: number;
}

interface SweepRegistry {
  entries: Set<SweepEntry>;
  running: boolean;
}

type SweepKind = "swipe" | "letters" | "fade";
type PickedSource = { animation: Animation; kind: SweepKind };

const registries = new WeakMap<Document, SweepRegistry>();
const AMOUNT_START_FROM = -0.2;
const AMOUNT_START_TO = 1.4;
const AMOUNT_END_FROM = -0.1;
const AMOUNT_END_TO = 1.5;

function keyframesOf(animation: Animation): Keyframe[] {
  const effect = animation.effect as KeyframeEffect | null;
  return typeof effect?.getKeyframes === "function" ? (effect.getKeyframes() as Keyframe[]) : [];
}

function pickSource(part: PartData): PickedSource | null {
  if (part.animations.length === 0) return null;
  // Every per-letter sub-animation is set to the same word-elapsed `currentTime` as a swipe
  // animation would be (see startRichSyncedHighlightAnimations), so the first one reads the same
  // way; letters just render as a plain gradient instead of the mask sweep they can't borrow.
  if (part.highlightLetterElements?.length) return { animation: part.animations[0], kind: "letters" };
  const swipe = part.animations.find(a => keyframesOf(a).some(frame => AMOUNT_START in frame && !("opacity" in frame)));
  if (swipe) return { animation: swipe, kind: "swipe" };
  const fade = part.animations.find(a => keyframesOf(a).some(frame => "opacity" in frame));
  return fade ? { animation: fade, kind: "fade" } : null;
}

/** 0 (not yet reached) to 1 (fully sung) fraction of this reading's own run, read straight off the
 *  anchor word's real animation - never a value we keep state of ourselves. */
function sweepProgress(entry: SweepEntry, picked: PickedSource): number {
  const elapsedMs = Number(picked.animation.currentTime ?? 0);
  if (picked.kind === "fade") {
    // Line-synced word: the opacity animation is a 1ms before/after switch, not a sweep - the
    // reading just matches whichever side of it the word is currently on.
    return elapsedMs >= 0 ? 1 : 0;
  }
  if (entry.durationMs <= 0) return elapsedMs >= entry.offsetMs ? 1 : 0;
  return Math.min(Math.max((elapsedMs - entry.offsetMs) / entry.durationMs, 0), 1);
}

function applySweepProgress(highlight: HTMLElement, progress: number): void {
  highlight.style.setProperty(
    AMOUNT_START,
    String(AMOUNT_START_FROM + progress * (AMOUNT_START_TO - AMOUNT_START_FROM))
  );
  highlight.style.setProperty(AMOUNT_END, String(AMOUNT_END_FROM + progress * (AMOUNT_END_TO - AMOUNT_END_FROM)));
}

function syncSweep(entry: SweepEntry): void {
  const picked = pickSource(entry.part);
  if (!picked) return;
  applySweepProgress(entry.highlight, sweepProgress(entry, picked));
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
        current.entries.delete(item);
        continue;
      }
      if (item.line.isAnimating) syncSweep(item);
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
