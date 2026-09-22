/**
 * Two pointer behaviours layered over the core's own per-line click seek, without patching it:
 *  - a capture-phase listener on the container narrows a plain single click to the line's leading
 *    edge (a "gutter"), so the rest of the line is free for selecting text. Alt+click word-seek and
 *    double-click-anywhere are the core's own click handling and are let straight through.
 *  - releasing a drag selection inside the container copies the selected lyrics to the clipboard and
 *    shows a toast.
 *
 * World-agnostic: every function is handed the element it works from and reads `ownerDocument` /
 * `defaultView` off it rather than the globals, so the same code serves the side panel and the
 * Picture-in-Picture window.
 */
import {
  COPIED_TOAST_CLASS,
  HIGHLIGHT_RUN_CLASS,
  LINE_CLASS,
  LOG_PREFIX,
  LYRICS_CLASS,
  ROMANIZED_LYRICS_CLASS,
  RTL_CLASS,
  SEEK_HOVER_CLASS,
  TRANSLATED_LYRICS_CLASS,
  WORD_CLASS,
  WORD_HIGHLIGHT_CLASS,
} from "@constants";
import { t } from "@core/i18n";
import { logCore as log } from "@core/logger";
import { FURIGANA_CLASS } from "@modules/lyrics/furiganaDom";

const BLOCK_SELECTOR = `.${LINE_CLASS}`;
/** Reading aids: shown on screen, but never copied. The highlight overlay duplicates the main
 *  text under an aria-hidden run, so it is excluded the same way. */
const SKIPPED_CLASSES = [ROMANIZED_LYRICS_CLASS, TRANSLATED_LYRICS_CLASS, FURIGANA_CLASS, HIGHLIGHT_RUN_CLASS];
const TOAST_DURATION_MS = 1200;
/** How much wider the seek gutter's hit zone gets once it's already hovered. */
const SEEK_HOVER_WIDEN_FACTOR = 1.6;
/** CSS custom property the gutter bar reads its position from; set per hover, in the line's own
 *  unscaled pixels (see fork.css). */
const GUTTER_X_PROPERTY = "--blyrics-seek-gutter-x";
/** Matches fork.css's `--blyrics-seek-gutter-width: 1.6875rem`. Kept as a plain number here rather
 *  than read back off the custom property: getComputedStyle returns a custom property's authored
 *  string as-is ("1.5rem"), not its resolved length, so parsing it as a number silently produced
 *  ~1.5px instead of ~24px and made the gutter (and its hover hysteresis) imperceptible. */
const SEEK_GUTTER_WIDTH_REM = 1.6875;

function gutterWidthPx(lineElement: HTMLElement): number {
  const doc = lineElement.ownerDocument;
  const rootFontSize = parseFloat(doc.defaultView?.getComputedStyle(doc.documentElement).fontSize ?? "");
  return SEEK_GUTTER_WIDTH_REM * (Number.isFinite(rootFontSize) && rootFontSize > 0 ? rootFontSize : 16);
}

/**
 * The pointer sits inside a line's seek gutter when it is within roughly one gutter-width of the
 * leading edge of the line's text. The text edge - not the line box edge - is what matters, because
 * duet lines and RTL right-align or centre their words. Everything past the gutter is reserved for
 * text selection.
 *
 * Once a line is the hovered seek target, fork.css slides its words aside by one gutter-width to
 * open the bar's gap, over its own ~220ms transition. That ruled out re-measuring the DOM on every
 * mousemove to track the zone: a live measurement taken mid-transition, "corrected" by a guess of
 * how far the slide had gotten, drifted for the whole transition - which both chased the bar under
 * the pointer instead of holding it still, and (worse) could momentarily place the zone outside the
 * pointer's own position right after entry, snapping the hover straight back off. So a line's edges
 * are measured exactly once, at the instant the pointer first crosses into its (unslid, still
 * narrow) gutter, and cached for as long as it stays the hovered line; nothing here reads the DOM
 * again until a different line is entered.
 */
interface TextEdges {
  rect: DOMRect;
  /** Gutter width in this rect's screen px (already includes the line's own `scale`). */
  gutter: number;
  textLeft: number;
  textRight: number;
  rightAligned: boolean;
}

/** Right-aligned lines (RTL, or secondary/tertiary duet vocals) hang the gutter off the trailing
 *  edge; everything else off the leading (left) edge. */
function isRightAligned(lineElement: HTMLElement): boolean {
  const view = lineElement.ownerDocument.defaultView;
  return (
    lineElement.classList.contains(RTL_CLASS) ||
    view?.getComputedStyle(lineElement).textAlign === "right" ||
    lineElement.dataset.agent === "v2" ||
    lineElement.dataset.agent === "v3"
  );
}

/** Where a line's own sung text starts and ends right now, in viewport px - not the highlight
 *  overlay, and not any romanization / translation row (which also holds `.blyrics--word`). Only
 *  meaningful while the line sits at its rest (unslid) position. */
function measureTextEdges(lineElement: HTMLElement): TextEdges | null {
  const rect = lineElement.getBoundingClientRect();
  if (rect.width === 0) return null;
  const scale = lineElement.offsetWidth > 0 ? rect.width / lineElement.offsetWidth : 1;
  const gutter = gutterWidthPx(lineElement) * scale;
  if (gutter <= 0) return null;

  let textLeft = rect.left;
  let textRight = rect.right;
  const words = [...lineElement.querySelectorAll<HTMLElement>(`.${WORD_CLASS}:not(.${WORD_HIGHLIGHT_CLASS})`)].filter(
    word => !word.closest(`.${ROMANIZED_LYRICS_CLASS}, .${TRANSLATED_LYRICS_CLASS}`)
  );
  if (words.length) {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const word of words) {
      const wordRect = word.getBoundingClientRect();
      if (wordRect.width === 0) continue;
      lo = Math.min(lo, wordRect.left);
      hi = Math.max(hi, wordRect.right);
    }
    if (lo !== Number.POSITIVE_INFINITY) {
      textLeft = lo;
      textRight = hi;
    }
  }

  return { rect, gutter, textLeft, textRight, rightAligned: isRightAligned(lineElement) };
}

function withinZone(edges: TextEdges, clientX: number, widen: boolean): boolean {
  const hitZone = widen ? edges.gutter * SEEK_HOVER_WIDEN_FACTOR : edges.gutter;
  if (edges.rightAligned) {
    const outside = Math.min(hitZone, Math.max(0, edges.rect.right - edges.textRight));
    return clientX >= edges.textRight - (hitZone - outside) && clientX <= edges.textRight + outside;
  }
  const outside = Math.min(hitZone, Math.max(0, edges.textLeft - edges.rect.left));
  return clientX >= edges.textLeft - outside && clientX <= edges.textLeft + (hitZone - outside);
}

/**
 * A fresh (narrow, non-widened) gutter test against a line's current, live position. Only valid to
 * call on a line that is not already the hovered target - see the module doc comment above.
 */
export function isInSeekGutter(lineElement: HTMLElement, clientX: number): boolean {
  if (lineElement.dataset.instrumental === "true") {
    // No text to reserve a gutter against - the whole line is a seek target.
    return true;
  }
  const edges = measureTextEdges(lineElement);
  return !!edges && withinZone(edges, clientX, false);
}

/** Positions the (otherwise invisible) gutter bar at the given (already-measured) text edge. */
function placeGutterBar(lineElement: HTMLElement, edges: TextEdges): void {
  const scale = lineElement.offsetWidth > 0 ? edges.rect.width / lineElement.offsetWidth : 1;
  if (scale <= 0) return;
  // Clamped the same way the (narrow) hit zone is: a line with little or no room on its gutter
  // side - the common case for ordinary left-flush lyrics, which start almost flush against the
  // line's own box - would otherwise place the bar at a negative offset, off past the line's own
  // left edge and clipped away by whatever ancestor clips overflow there. Clamping to the edge
  // keeps the bar exactly over the strip that is actually clickable, however wide that turns out
  // to be, rather than past it.
  const leftOutside = Math.min(edges.gutter, Math.max(0, edges.textLeft - edges.rect.left));
  const x = edges.rightAligned
    ? (edges.textRight - edges.rect.left) / scale
    : (edges.textLeft - leftOutside - edges.rect.left) / scale;
  lineElement.style.setProperty(GUTTER_X_PROPERTY, `${x}px`);
}

/**
 * True when the user currently has a non-empty selection, which means a click event is the tail
 * end of a drag and must not seek.
 */
export function hasActiveTextSelection(doc: Document): boolean {
  const selection = doc.defaultView?.getSelection();
  return !!selection && !selection.isCollapsed && selection.toString().trim().length > 0;
}

function serializeNode(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node.nodeValue ?? "");
    return;
  }

  if (!(node instanceof Element)) {
    node.childNodes.forEach(child => serializeNode(child, out));
    return;
  }

  if (SKIPPED_CLASSES.some(className => node.classList.contains(className))) return;

  const isBlock = node.matches(BLOCK_SELECTOR);
  if (isBlock && out.length > 0 && !out[out.length - 1].endsWith("\n")) {
    out.push("\n");
  }

  node.childNodes.forEach(child => serializeNode(child, out));

  if (isBlock) out.push("\n");
}

/** Extracts the selected lyrics as plain text, one line per lyric line. */
function getSelectedLyricsText(container: HTMLElement): string {
  const selection = container.ownerDocument.defaultView?.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";

  const range = selection.getRangeAt(0);
  if (!range.intersectsNode(container)) return "";

  // Clamp to the lyrics container so dragging past it does not pull in the footer or other UI.
  const clamped = range.cloneRange();
  if (!container.contains(range.startContainer)) clamped.setStart(container, 0);
  if (!container.contains(range.endContainer)) clamped.setEnd(container, container.childNodes.length);

  const out: string[] = [];
  serializeNode(clamped.cloneContents(), out);

  return out
    .join("")
    .split("\n")
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(line => line.length > 0)
    .join("\n");
}

function copyWithExecCommand(doc: Document, text: string): boolean {
  const textarea = doc.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";
  doc.body.appendChild(textarea);

  let copied = false;
  try {
    textarea.select();
    copied = doc.execCommand("copy");
  } catch (error) {
    log(LOG_PREFIX, "Clipboard fallback failed", error);
  }

  textarea.remove();
  clearSelection(doc);
  return copied;
}

function clearSelection(doc: Document): void {
  doc.defaultView?.getSelection()?.removeAllRanges();
}

function showCopiedToast(doc: Document, clientX: number, clientY: number): void {
  doc.querySelectorAll(`.${COPIED_TOAST_CLASS}`).forEach(toast => toast.remove());

  const toast = doc.createElement("div");
  toast.className = COPIED_TOAST_CLASS;
  toast.textContent = t("lyrics_copied");
  toast.style.left = `${clientX}px`;
  toast.style.top = `${Math.max(clientY - 12, 24)}px`;
  doc.body.appendChild(toast);

  const view = doc.defaultView;
  view?.requestAnimationFrame(() => toast.classList.add(`${COPIED_TOAST_CLASS}-visible`));

  (view ?? globalThis).setTimeout(() => {
    toast.classList.remove(`${COPIED_TOAST_CLASS}-visible`);
    (view ?? globalThis).setTimeout(() => toast.remove(), 200);
  }, TOAST_DURATION_MS);
}

function handleSelectionEnd(container: HTMLElement, clientX: number, clientY: number): void {
  const doc = container.ownerDocument;
  const text = getSelectedLyricsText(container);
  if (!text) return;

  const onSuccess = (): void => {
    log(LOG_PREFIX, `Copied ${text.split("\n").length} line(s) of lyrics`);
    showCopiedToast(doc, clientX, clientY);
  };

  if (doc.defaultView?.navigator.clipboard?.writeText) {
    // The text is already extracted, so drop the highlight right away rather than waiting on the
    // clipboard promise.
    clearSelection(doc);
    doc.defaultView.navigator.clipboard.writeText(text).then(onSuccess, error => {
      log(LOG_PREFIX, "Clipboard write failed, falling back", error);
      if (copyWithExecCommand(doc, text)) onSuccess();
    });
    return;
  }

  if (copyWithExecCommand(doc, text)) onSuccess();
}

const documentsWithSelectionListeners = new WeakSet<Document>();
const dragOriginContainers = new WeakMap<Document, HTMLElement | null>();

/**
 * Copy-on-select is bound to the document (once per document) so a drag which ends outside the
 * lyrics container is still copied. The container is remembered from the mousedown that started it.
 */
function ensureDocumentSelectionListeners(doc: Document): void {
  if (documentsWithSelectionListeners.has(doc)) return;
  documentsWithSelectionListeners.add(doc);

  // Capture phase: the host page may stop propagation on some pointer events, and a bubble-phase
  // listener would never see those.
  doc.addEventListener(
    "mousedown",
    event => {
      const target = event.target as HTMLElement | null;
      dragOriginContainers.set(doc, target?.closest?.(`.${LYRICS_CLASS}`) as HTMLElement | null);
    },
    true
  );

  doc.addEventListener(
    "mouseup",
    event => {
      const container = dragOriginContainers.get(doc) ?? null;
      dragOriginContainers.set(doc, null);
      // A double/triple click seeks and clears its own selection - don't treat that as a copy.
      if (event.detail >= 2) return;
      if (container?.isConnected) handleSelectionEnd(container, event.clientX, event.clientY);
    },
    true
  );
}

/**
 * True when this click should reach the core's own per-line seek handler unfiltered: a
 * double/triple click (seeks anywhere), or an Alt+click on richsync lyrics (the core's own
 * word-seek, also anywhere on the line).
 */
function bypassesGutter(container: HTMLElement, event: MouseEvent): boolean {
  if (event.detail >= 2) return true;
  const isRichsync = container.dataset.sync === "richsync";
  return isRichsync && event.altKey;
}

/**
 * Wires up a lyrics container's pointer behaviour:
 * - a capture-phase click filter narrows the core's per-line seek to the leading-edge gutter
 * - hovering the gutter marks the line as a seek target and positions its bar
 * - releasing a drag selection copies the selected lyrics to the clipboard
 */
export function attachLineInteractions(container: HTMLElement): void {
  const doc = container.ownerDocument;
  ensureDocumentSelectionListeners(doc);

  let hoveredLine: HTMLElement | null = null;
  // The one DOM measurement taken for `hoveredLine`, back when it was still at rest - see the big
  // comment above `TextEdges`. Every hit-test against the currently hovered line re-checks the
  // pointer against this cached rect; none of them touch the (sliding) DOM again.
  let hoveredEdges: TextEdges | null = null;

  const clearHover = (): void => {
    if (hoveredLine) {
      hoveredLine.classList.remove(SEEK_HOVER_CLASS);
      hoveredLine = null;
      hoveredEdges = null;
    }
  };

  container.addEventListener(
    "click",
    event => {
      const line = (event.target as HTMLElement | null)?.closest?.(`.${LINE_CLASS}`) as HTMLElement | null;
      if (!line || line.dataset.instrumental === "true" || bypassesGutter(container, event)) return;
      if (hasActiveTextSelection(doc)) {
        event.stopPropagation();
        return;
      }
      // The common case: the click lands on the line the hover state already confirmed is the
      // target, so trust that rather than re-measuring a line whose words may be mid-slide.
      // Anything else (no preceding mousemove - e.g. a fast click, or a touch/synthetic event)
      // falls back to a fresh, narrow check.
      const inGutter =
        line === hoveredLine && hoveredEdges
          ? withinZone(hoveredEdges, event.clientX, true)
          : isInSeekGutter(line, event.clientX);
      if (!inGutter) event.stopPropagation();
    },
    true
  );

  // A double (or triple) click seeks - the core's own click handling, let through above - but the
  // browser's native word/line selection that the same click made is left behind; drop it so it
  // doesn't linger as a highlighted block or get mistaken for a copy-drag on the next mouseup.
  container.addEventListener("dblclick", () => {
    doc.defaultView?.getSelection()?.removeAllRanges();
  });

  container.addEventListener("mousemove", event => {
    if (container.dataset.sync === "none") return;
    const line = (event.target as HTMLElement | null)?.closest?.(`.${LINE_CLASS}`) as HTMLElement | null;

    if (line && line === hoveredLine) {
      // Same line as last time: judge purely off the cached rest-state edges, widened for
      // hysteresis. Never re-measure the DOM here - the words are mid-slide for up to ~220ms after
      // entry, and "correcting" a live read for how far that slide has gotten was exactly what
      // made the bar chase the pointer, and briefly kicked the pointer back out of the zone right
      // after entry.
      if (!hoveredEdges || !withinZone(hoveredEdges, event.clientX, true)) clearHover();
      return;
    }

    clearHover();
    if (!line || line.dataset.instrumental === "true") return;

    const edges = measureTextEdges(line);
    if (!edges || !withinZone(edges, event.clientX, false)) return;

    hoveredLine = line;
    hoveredEdges = edges;
    placeGutterBar(line, edges);
    line.classList.add(SEEK_HOVER_CLASS);
  });

  container.addEventListener("mouseleave", clearHover);
}
