import {
  BREAK_CLASS,
  COPIED_TOAST_CLASS,
  INSTRUMENTAL_CLASS,
  LINE_CLASS,
  LOG_PREFIX,
  LYRICS_CLASS,
  ROMANIZED_LYRICS_CLASS,
  RTL_CLASS,
  SEEK_HOVER_CLASS,
  TRANSLATED_LYRICS_CLASS,
  WORD_CLASS,
} from "@constants";
import { t } from "@core/i18n";
import { log } from "@utils";

const BLOCK_SELECTOR = `.${LINE_CLASS}`;
/** Reading aids: shown on screen, but never copied. */
const SKIPPED_CLASSES = [
  BREAK_CLASS,
  ROMANIZED_LYRICS_CLASS,
  TRANSLATED_LYRICS_CLASS,
  "blyrics--furigana",
  "blyrics-hidden",
];
const TOAST_DURATION_MS = 1200;
/** How much wider the seek gutter's hit zone gets once it's already hovered. */
const SEEK_HOVER_WIDEN_FACTOR = 1.6;

/**
 * Returns true when the pointer sits inside a line's seek gutter: the strip
 * roughly one gutter-width wide hanging off the leading edge of the line's text.
 * The text edge - not the line-box edge - is what matters, because duet lines
 * ([data-agent]) right-align or centre their words. Everything past the gutter is
 * reserved for text selection. While the line is already the hovered seek
 * target, the zone widens by SEEK_HOVER_WIDEN_FACTOR (hysteresis) so it takes a
 * more deliberate move away to drop out of hover than it took to enter it.
 */
export function isInSeekGutter(lineElement: HTMLElement, clientX: number): boolean {
  if (lineElement.classList.contains(INSTRUMENTAL_CLASS)) {
    return true;
  }

  const rect = lineElement.getBoundingClientRect();
  if (rect.width === 0) {
    return false;
  }

  // The ::before box's width defines the hover zone size.
  const gutter = parseFloat(getComputedStyle(lineElement, "::before").width);
  if (!gutter || gutter <= 0) {
    return false;
  }

  // Lines are scaled, so the untransformed width has to be scaled as well.
  const scale = lineElement.offsetWidth > 0 ? rect.width / lineElement.offsetWidth : 1;
  const scaledGutter = gutter * scale;

  // Find where the rendered text actually starts / ends - the main lyric only,
  // not the romanization / translation rows (which also hold .blyrics--word).
  let textLeft = rect.left;
  let textRight = rect.right;
  const words = [...lineElement.querySelectorAll<HTMLElement>(`.${WORD_CLASS}`)].filter(
    word => !word.closest(`.${ROMANIZED_LYRICS_CLASS}, .${TRANSLATED_LYRICS_CLASS}`)
  );
  if (words.length) {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const word of words) {
      const wordRect = word.getBoundingClientRect();
      if (wordRect.width === 0) {
        continue;
      }
      lo = Math.min(lo, wordRect.left);
      hi = Math.max(hi, wordRect.right);
    }
    if (lo !== Number.POSITIVE_INFINITY) {
      textLeft = lo;
      textRight = hi;
    }
  }

  // Right-aligned lines (RTL, or secondary/tertiary duet vocals) put the bar on
  // the trailing edge; everything else on the leading (left) edge.
  const rightAligned =
    lineElement.classList.contains(RTL_CLASS) || getComputedStyle(lineElement).justifyContent === "flex-end";

  // On hover the words are translated one gutter-width away from the bar to open
  // the gap it sits in. Undo that here so the zone matches the (unmoved) bar.
  const isHovering = lineElement.classList.contains(SEEK_HOVER_CLASS);
  const slid = isHovering ? scaledGutter : 0;
  const restLeft = textLeft + (rightAligned ? slid : -slid);
  const restRight = textRight + (rightAligned ? slid : -slid);

  // Hysteresis: once hovering, the hit zone widens so small jitter near its edge
  // doesn't drop back out; leaving it far enough shrinks it back to the normal
  // (narrower) zone used to enter hover in the first place.
  const hitZone = isHovering ? scaledGutter * SEEK_HOVER_WIDEN_FACTOR : scaledGutter;

  if (rightAligned) {
    const outside = Math.min(hitZone, Math.max(0, rect.right - restRight));
    return clientX >= restRight - (hitZone - outside) && clientX <= restRight + outside;
  }

  const outside = Math.min(hitZone, Math.max(0, restLeft - rect.left));
  return clientX >= restLeft - outside && clientX <= restLeft + (hitZone - outside);
}

/**
 * True when the user currently has a non-empty selection, which means a click
 * event is the tail end of a drag and must not seek.
 */
export function hasActiveTextSelection(): boolean {
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed && selection.toString().trim().length > 0;
}

function serializeNode(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node.nodeValue ?? "");
    return;
  }

  if (!(node instanceof Element)) {
    // Document fragments (the cloned range) and other wrappers just pass through.
    node.childNodes.forEach(child => serializeNode(child, out));
    return;
  }

  if (SKIPPED_CLASSES.some(className => node.classList.contains(className))) {
    return;
  }

  const isBlock = node.matches(BLOCK_SELECTOR);
  if (isBlock && out.length > 0 && !out[out.length - 1].endsWith("\n")) {
    out.push("\n");
  }

  node.childNodes.forEach(child => serializeNode(child, out));

  if (isBlock) {
    out.push("\n");
  }
}

/**
 * Extracts the selected lyrics as plain text, keeping one line per lyric line
 * (including any selected romanization / translation rows).
 */
function getSelectedLyricsText(container: HTMLElement): string {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return "";
  }

  const range = selection.getRangeAt(0);
  if (!range.intersectsNode(container)) {
    return "";
  }

  // Clamp the range to the lyrics container so dragging past the lyrics does
  // not pull in the footer or other surrounding UI.
  const clamped = range.cloneRange();
  if (!container.contains(range.startContainer)) {
    clamped.setStart(container, 0);
  }
  if (!container.contains(range.endContainer)) {
    clamped.setEnd(container, container.childNodes.length);
  }

  const out: string[] = [];
  serializeNode(clamped.cloneContents(), out);

  return out
    .join("")
    .split("\n")
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(line => line.length > 0)
    .join("\n");
}

function copyWithExecCommand(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  let copied = false;
  try {
    textarea.select();
    copied = document.execCommand("copy");
  } catch (error) {
    log(LOG_PREFIX, "Clipboard fallback failed", error);
  }

  textarea.remove();
  // The lyrics selection is dropped either way, so there is nothing to restore.
  clearSelection();

  return copied;
}

function clearSelection(): void {
  window.getSelection()?.removeAllRanges();
}

function showCopiedToast(clientX: number, clientY: number): void {
  document.querySelectorAll(`.${COPIED_TOAST_CLASS}`).forEach(toast => toast.remove());

  const toast = document.createElement("div");
  toast.className = COPIED_TOAST_CLASS;
  toast.textContent = t("lyrics_copied");
  toast.style.left = `${clientX}px`;
  toast.style.top = `${Math.max(clientY - 12, 24)}px`;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add(`${COPIED_TOAST_CLASS}-visible`));

  setTimeout(() => {
    toast.classList.remove(`${COPIED_TOAST_CLASS}-visible`);
    setTimeout(() => toast.remove(), 200);
  }, TOAST_DURATION_MS);
}

function handleSelectionEnd(container: HTMLElement, clientX: number, clientY: number): void {
  const text = getSelectedLyricsText(container);
  if (!text) {
    return;
  }

  const onSuccess = () => {
    log(LOG_PREFIX, `Copied ${text.split("\n").length} line(s) of lyrics`);
    showCopiedToast(clientX, clientY);
  };

  if (navigator.clipboard?.writeText) {
    // The text is already extracted, so drop the highlight right away rather
    // than waiting on the clipboard promise.
    clearSelection();
    navigator.clipboard.writeText(text).then(onSuccess, error => {
      log(LOG_PREFIX, "Clipboard write failed, falling back", error);
      if (copyWithExecCommand(text)) {
        onSuccess();
      }
    });
    return;
  }

  if (copyWithExecCommand(text)) {
    onSuccess();
  }
}

let dragOriginContainer: HTMLElement | null = null;
let documentListenersAttached = false;

/**
 * Copy-on-select is bound to the document (once) so that a drag which ends
 * outside the lyrics container is still copied. The container is remembered
 * from the mousedown that started the drag.
 */
function ensureDocumentSelectionListeners(): void {
  if (documentListenersAttached) {
    return;
  }
  documentListenersAttached = true;

  // Capture phase: YouTube Music stops propagation on some pointer events, and
  // a bubble-phase listener would never see those.
  document.addEventListener(
    "mousedown",
    event => {
      dragOriginContainer = (event.target as HTMLElement | null)?.closest?.(`.${LYRICS_CLASS}`) as HTMLElement | null;
    },
    true
  );

  document.addEventListener(
    "mouseup",
    event => {
      const container = dragOriginContainer;
      dragOriginContainer = null;
      // A double/triple click seeks (see createLyricsLine) and clears its own
      // selection - don't treat that selection as a copy.
      if (event.detail >= 2) {
        return;
      }
      if (container?.isConnected) {
        handleSelectionEnd(container, event.clientX, event.clientY);
      }
    },
    true
  );
}

/**
 * Wires up the two pointer behaviours of a lyrics container:
 * - hovering the leading-edge gutter marks the line as a seek target
 * - releasing a drag selection copies the selected lyrics to the clipboard
 */
export function attachLineInteractions(container: HTMLElement): void {
  ensureDocumentSelectionListeners();

  let hoveredLine: HTMLElement | null = null;

  const clearHover = () => {
    if (hoveredLine) {
      hoveredLine.classList.remove(SEEK_HOVER_CLASS);
      hoveredLine = null;
    }
  };

  container.addEventListener("mousemove", event => {
    const line = (event.target as HTMLElement | null)?.closest?.(`.${LINE_CLASS}`) as HTMLElement | null;

    if (
      !line ||
      line.classList.contains(INSTRUMENTAL_CLASS) ||
      line.dataset.noSeek === "true" ||
      !isInSeekGutter(line, event.clientX)
    ) {
      clearHover();
      return;
    }

    if (hoveredLine !== line) {
      clearHover();
      hoveredLine = line;
      line.classList.add(SEEK_HOVER_CLASS);
    }
  });

  container.addEventListener("mouseleave", clearHover);
}
