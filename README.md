# Thymer == Highlight

Thymer plugin that treats `==highlighted text==` like Obsidian-style markers: it turns those segments into soft yellow highlight links in the editor. Thymer does not ship a native highlight segment type, so the plugin stores highlights as styled link segments and injects matching CSS.

**Version:** `version` in `plugin.json` is the plugin release (e.g. `1.0.0`). The `ver` field is the manifest / API version expected by Thymer.

## Features

- **Live conversion** — While you type or paste, `==…==` pairs on normal text/bold/italic runs become highlights.
- **Multi-line highlights** — Highlights can span consecutive compatible lines; the plugin chains them when possible.
- **Escaping** — Use `\` so `\\==` and `\\=` emit literal `==` and `=`, and `\\==` can block a pair from being treated as a delimiter.
- **Scan on load** — Opening a note, focusing the editor, or reloading the plugin reapplies highlighting to existing `==…==` in the open page.
- **Command palette** — Unwrap highlights to plain text or restore `==` markers, for the whole note or for lines tied to your last text selection (see below).

## Writing highlights

Wrap the visible text in double equals:

```text
This is ==important== in this sentence.
```

Avoid wrapping inside unsupported segment types (for example code, links, mentions); those are skipped by design.

## Commands

Open the command palette and search for:

| Command | Effect |
|--------|--------|
| **Unwrap == highlights to plain text (this note)** | Removes highlight links for every line in the open note. |
| **Unwrap == highlights to plain text (lines from last text drag)** | Same, but only for lines detected from your recent text drag / selection heuristics. |
| **Restore == markers from highlights (this note)** | Turns highlight links back into `==…==` text for the whole note. |
| **Restore == markers from highlights (lines from last text drag)** | Same, scoped to the last text-drag lines. |

Selection-scoped commands infer rows using the last editor text drag, cached selection geometry, and related signals so they still work after the palette takes focus.

## Installation

Install this folder as a Thymer app plugin according to Thymer’s plugin documentation (the manifest is `plugin.json` alongside `plugin.js`).

## Files

- **`plugin.json`** — Plugin manifest (name, version, icon, description).
- **`plugin.js`** — Implementation (`AppPlugin` class).

## Development

For SDK hot reload with a bundler that expects ESM exports, you may need to add `export` before the `Plugin` class declaration in `plugin.js` (see comment at the top of that file).
