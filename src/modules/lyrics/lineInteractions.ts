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
/** Matches fork.css's `--blyrics-seek-gutter-width: 1.5rem`. Kept as a plain number here rather
 *  than read back off the custom property: getComputedStyle returns a custom property's authored
 *  string as-is ("1.5rem"), not its resolved length, so parsing it as a number silently produced
 *  ~1.5px instead of ~24px and made the gutter (and its hover hysteresis) imperceptible. */
const SEEK_GUTTER_WIDTH_REM = 1.5;

function gutterWidthPx(lineElement: HTMLElement): number {
  const doc = lineElement.ownerDocument;
  const rootFontSize = parseFloat(doc.defaultView?.getComputedStyle(doc.documentElement).fontSize ?? "");
  return SEEK_GUTTER_WIDTH_REM * (Number.isFinite(rootFontSize) && rootFontSize > 0 ? rootFontSize : 16);
}

/**
 * Returns true when the pointer sits inside a line's seek gutter: the strip roughly one
 * gutter-width wide hanging off the leading edge of the line's text. The text edge - not the line
 * box edge - is what matters, because duet lines and RTL right-align or centre their words.
 * Everything past the gutter is reserved for text selection. While the line is already the hovered
 * seek target, the zone widens by SEEK_HOVER_WIDEN_FACTOR (hysteresis) so it takes a more
 * deliberate move away to drop out of hover than it took to enter it.
 */
interface TextEdges {
  rect: DOMRect;
  scale: number;
  /** True once hovering slides the words aside by one gutter width to open the bar's gap - the
   *  rects below are measured live, so they already reflect that shift and need it undone before
   *  comparing against the (unmoved) bar or clientX. */
  slidPx: number;
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

/** Where a line's own sung text actually starts and ends, in viewport px - not the highlight
 *  overlay, and not any romanization / translation row (which also holds `.blyrics--word`). */
function measureTextEdges(lineElement: HTMLElement): TextEdges | null {
  const rect = lineElement.getBoundingClientRect();
  if (rect.width === 0) return null;
  const scale = lineElement.offsetWidth > 0 ? rect.width / lineElement.offsetWidth : 1;

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

  const rightAligned = isRightAligned(lineElement);
  const isHovering = lineElement.classList.contains(SEEK_HOVER_CLASS);
  // On hover the words are already translated one gutter-width away to open the gap the bar sits
  // in (see fork.css); undo that here so the edges line up with the bar's (unmoved) own position.
  const slidPx = isHovering ? gutterWidthPx(lineElement) * scale : 0;
  if (rightAligned) {
    textLeft -= slidPx;
    textRight -= slidPx;
  } else {
    textLeft += slidPx;
    textRight += slidPx;
  }

  return { rect, scale, slidPx, textLeft, textRight, rightAligned };
}

export function isInSeekGutter(lineElement: HTMLElement, clientX: number): boolean {
  if (lineElement.dataset.instrumental === "true") {
    // No text to reserve a gutter against - the whole line is a seek target.
    return true;
  }

  const edges = measureTextEdges(lineElement);
  if (!edges) return false;
  const { rect, scale, textLeft, textRight, rightAligned } = edges;

  const gutter = gutterWidthPx(lineElement) * scale;
  if (gutter <= 0) return false;

  const isHovering = lineElement.classList.contains(SEEK_HOVER_CLASS);
  const hitZone = isHovering ? gutter * SEEK_HOVER_WIDEN_FACTOR : gutter;

  if (rightAligned) {
    const outside = Math.min(hitZone, Math.max(0, rect.right - textRight));
    return clientX >= textRight - (hitZone - outside) && clientX <= textRight + outside;
  }

  const outside = Math.min(hitZone, Math.max(0, textLeft - rect.left));
  return clientX >= textLeft - outside && clientX <= textLeft + (hitZone - outside);
}

/** Positions the (otherwise invisible) gutter bar against the line's real text edge on hover. */
function placeGutterBar(lineElement: HTMLElement): void {
  const edges = measureTextEdges(lineElement);
  if (!edges || edges.scale <= 0) return;
  const { rect, scale, textLeft, textRight, rightAligned } = edges;

  const gutter = gutterWidthPx(lineElement);
  const x = rightAligned ? (textRight - rect.left) / scale : (textLeft - rect.left) / scale - gutter;
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

  container.addEventListener(
    "click",
    event => {
      const line = (event.target as HTMLElement | null)?.closest?.(`.${LINE_CLASS}`) as HTMLElement | null;
      if (!line || line.dataset.instrumental === "true" || bypassesGutter(container, event)) return;
      if (hasActiveTextSelection(doc) || !isInSeekGutter(line, event.clientX)) {
        event.stopPropagation();
      }
    },
    true
  );

  // A double (or triple) click seeks - the core's own click handling, let through above - but the
  // browser's native word/line selection that the same click made is left behind; drop it so it
  // doesn't linger as a highlighted block or get mistaken for a copy-drag on the next mouseup.
  container.addEventListener("dblclick", () => {
    doc.defaultView?.getSelection()?.removeAllRanges();
  });

  let hoveredLine: HTMLElement | null = null;
  const clearHover = (): void => {
    if (hoveredLine) {
      hoveredLine.classList.remove(SEEK_HOVER_CLASS);
      hoveredLine = null;
    }
  };

  container.addEventListener("mousemove", event => {
    if (container.dataset.sync === "none") return;
    const line = (event.target as HTMLElement | null)?.closest?.(`.${LINE_CLASS}`) as HTMLElement | null;

    if (!line || !isInSeekGutter(line, event.clientX)) {
      clearHover();
      return;
    }

    if (hoveredLine !== line) {
      clearHover();
      hoveredLine = line;
      line.classList.add(SEEK_HOVER_CLASS);
    }
    placeGutterBar(line);
  });

  container.addEventListener("mouseleave", clearHover);
}
