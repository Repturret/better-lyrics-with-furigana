/**
 * Manual furigana correction: double-click a reading to retype it. The fix is saved through the
 * exceptions store (modules/exceptions/store.ts), which furigana.ts consults for every song, not
 * just the one it was made on.
 *
 * Main-world only: the store uses `chrome.storage` directly, so - unlike furiganaDom.ts - this
 * never runs in the Picture-in-Picture window.
 */
import { setReadingOverride } from "@modules/exceptions/store";
import { FURIGANA_CLASS, updateFuriganaReading } from "@modules/lyrics/furiganaDom";

const EDITING_CLASS = "blyrics--furigana-editing";

function commitEdit(rt: HTMLElement, input: HTMLInputElement, surface: string): void {
  const doc = rt.ownerDocument;
  const value = input.value.trim();
  input.remove();
  rt.style.removeProperty("visibility");
  doc.defaultView?.getSelection()?.removeAllRanges();
  if (!value || value === rt.dataset.reading) return;

  setReadingOverride(surface, value);
  updateFuriganaReading(rt, value);
}

function openEditor(rt: HTMLElement): void {
  const surface = rt.dataset.surface;
  if (!surface) return;
  const doc = rt.ownerDocument;

  const input = doc.createElement("input");
  input.type = "text";
  input.className = EDITING_CLASS;
  input.value = rt.dataset.reading ?? "";
  input.spellcheck = false;
  input.autocomplete = "off";
  // The reading is positioned by an inline `left` (the centre of its kanji): the field has to take
  // the same one, or it falls back to the word's left edge and, centred on that, hangs off the side.
  input.style.left = rt.style.left;
  // Sized to what is typed, not a fixed width, so a long reading is not cut off inside the field.
  const fit = (): void => {
    input.style.width = `${Math.max(input.value.length, 2) + 1.5}em`;
  };
  fit();
  input.addEventListener("input", fit);
  // The line still owns click/dblclick handling underneath (seek, drag-copy): keep every pointer
  // and key event here from reaching it while the field is open.
  input.addEventListener("mousedown", event => event.stopPropagation());
  input.addEventListener("click", event => event.stopPropagation());
  input.addEventListener("dblclick", event => event.stopPropagation());
  input.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      input.value = rt.dataset.reading ?? "";
      input.blur();
    }
  });
  input.addEventListener("blur", () => commitEdit(rt, input, surface), { once: true });

  // The reading stays in the DOM, just hidden, with the field beside it: taking it out would
  // disconnect its sweep element, and the sweep drops anything it finds disconnected, so the
  // corrected reading would come back with its fill animation gone for good.
  rt.style.visibility = "hidden";
  rt.after(input);
  input.focus();
  input.select();
}

/**
 * Wires up double-click-to-edit for every furigana reading under `container`. Loaded corrections
 * are consulted from furigana.ts's own pipeline (`getReadingOverride`), not from here - this only
 * handles the editing gesture and saving what comes out of it.
 */
export function attachFuriganaEditing(container: HTMLElement): void {
  container.addEventListener("dblclick", event => {
    const rt = (event.target as HTMLElement | null)?.closest?.(`.${FURIGANA_CLASS}`) as HTMLElement | null;
    if (!rt) return;
    // Stop the core's own seek and lineInteractions' selection-clearing from also reacting to the
    // same double click - editing a reading is not a seek gesture.
    event.stopPropagation();
    openEditor(rt);
  });
}
