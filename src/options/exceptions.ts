/**
 * The "Exceptions" tab: the user's own corrections, listed and editable. Today that is furigana
 * readings; the glossary and per-song sections get their own blocks in the same tab later.
 */
import { t } from "@core/i18n";
import {
  buildReadingEntry,
  getExceptions,
  loadExceptions,
  mergeStores,
  parseExport,
  type ReadingException,
  updateExceptions,
  withEntry,
  withEntryEnabled,
  withoutEntry,
} from "@modules/exceptions/store";

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function matches(entry: ReadingException, query: string): boolean {
  if (!query) return true;
  const target = entry.match.slice(entry.start, entry.end);
  return [entry.match, target, entry.reading].some(text => text.toLowerCase().includes(query));
}

/** `被告人[前]` - the context with the part the reading applies to marked. */
function renderMatch(entry: ReadingException): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "exceptions-match";
  const before = entry.match.slice(0, entry.start);
  const target = entry.match.slice(entry.start, entry.end);
  const after = entry.match.slice(entry.end);
  if (before) wrap.append(document.createTextNode(before));
  const mark = document.createElement("ruby");
  mark.className = "exceptions-target";
  mark.append(document.createTextNode(target));
  const rt = document.createElement("rt");
  rt.textContent = entry.reading;
  mark.append(rt);
  wrap.append(mark);
  if (after) wrap.append(document.createTextNode(after));
  return wrap;
}

function renderRow(entry: ReadingException, rerender: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "exceptions-row";
  if (!entry.enabled) row.classList.add("is-disabled");

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = entry.enabled;
  toggle.title = t("options_exceptions_enabled");
  toggle.addEventListener("change", () => {
    void updateExceptions(store => withEntryEnabled(store, entry.id, toggle.checked)).then(rerender);
  });

  const reading = document.createElement("span");
  reading.className = "exceptions-reading";
  reading.textContent = entry.reading;

  const remove = document.createElement("button");
  remove.className = "exceptions-delete";
  remove.type = "button";
  remove.textContent = "×";
  remove.title = t("options_exceptions_delete");
  remove.addEventListener("click", () => {
    void updateExceptions(store => withoutEntry(store, entry.id)).then(rerender);
  });

  row.append(toggle, renderMatch(entry), reading, remove);
  return row;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export async function initExceptionsTab(): Promise<void> {
  const list = element<HTMLDivElement>("exceptions-reading-list");
  if (!list) return;
  const search = element<HTMLInputElement>("exceptions-search");
  const context = element<HTMLInputElement>("exceptions-context");
  const target = element<HTMLInputElement>("exceptions-target");
  const reading = element<HTMLInputElement>("exceptions-reading");
  const status = element<HTMLElement>("exceptions-status");

  const say = (message: string): void => {
    status.textContent = message;
  };

  const render = (): void => {
    const query = search.value.trim().toLowerCase();
    const entries = getExceptions().reading.filter(entry => matches(entry, query));
    list.replaceChildren(...entries.map(entry => renderRow(entry, render)));
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "exceptions-empty";
      empty.textContent = t("options_exceptions_empty");
      list.append(empty);
    }
  };

  await loadExceptions();
  render();
  search.addEventListener("input", render);
  // Edits from a lyrics tab (a double-click correction) show up here without a reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.blyricsExceptions) render();
  });

  const add = (): void => {
    const entry = buildReadingEntry(context.value, target.value, reading.value);
    if (!entry) {
      say(t("options_exceptions_invalid"));
      return;
    }
    say("");
    void updateExceptions(store => withEntry(store, entry)).then(() => {
      context.value = "";
      target.value = "";
      reading.value = "";
      render();
    });
  };
  element("exceptions-add").addEventListener("click", add);
  for (const input of [context, target, reading]) {
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") add();
    });
  }

  element("exceptions-export").addEventListener("click", () => {
    download("better-lyrics-exceptions.json", JSON.stringify(getExceptions(), null, 2));
  });

  const file = element<HTMLInputElement>("exceptions-import-file");
  element("exceptions-import").addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const chosen = file.files?.[0];
    file.value = "";
    if (!chosen) return;
    const incoming = parseExport(await chosen.text());
    if (!incoming) {
      say(t("options_exceptions_import_failed"));
      return;
    }
    await updateExceptions(store => mergeStores(store, incoming));
    say(t("options_exceptions_import_done", String(incoming.reading.length)));
    render();
  });
}
