/*
 * Minimal `path` replacement for the browser bundle.
 *
 * kuromoji's dictionary loader calls `path.join(dicPath, file)` where dicPath is
 * a `chrome-extension://<id>/dict/` URL. The usual `path-browserify` shim
 * collapses the `//` after the scheme and breaks the URL, so we join naively and
 * only squash slash runs that are not part of a `://` scheme separator.
 */
function join(...parts) {
  return parts
    .filter(p => typeof p === "string" && p.length > 0)
    .join("/")
    .replace(/([^:])\/{2,}/g, "$1/");
}

function dirname(p) {
  const i = String(p).replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "." : p.slice(0, i);
}

function basename(p) {
  return String(p).replace(/\/+$/, "").split("/").pop() || "";
}

module.exports = { join, dirname, basename, sep: "/", delimiter: ":", posix: null, win32: null };
module.exports.posix = module.exports;
