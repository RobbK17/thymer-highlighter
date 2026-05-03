# Thymer == Highlight

Thymer plugin that treats `==highlighted text==` like Obsidian-style markers: it turns those segments into soft yellow highlights in the editor. Thymer does not ship a native highlight segment type, so the plugin stores highlights as styled link segments and injects matching CSS.

**Version:** `1.0.1` (in `plugin.json` as `version`). The `ver` field is the manifest / API version expected by Thymer.

## Features

- **Live conversion** — While you type or paste, `==…==` pairs on normal text/bold/italic runs become highlight links (when auto-detection is on).
- **Multi-line highlights** — Highlights can span consecutive compatible lines; the plugin chains marker ranges across rows when possible.
- **Escaping** — Use `\` so `\\==` and `\\=` emit literal `==` and `=`, and `\\==` can block a pair from being treated as a delimiter.
- **Scan on load** — Opening a note, focusing the editor, or reloading the plugin can rescan the open page for `==…==` (when auto-detection is on).
- **Auto-detection toggle** — **Highlighter: Enable …** / **Highlighter: Disable == highlight auto-detection** turn automatic detection on or off (**default: on**). The setting is stored in **`localStorage`** (keyed per plugin instance in the workspace) and survives reload. Manual palette actions still run when detection is off.
- **Current selection** — Several commands target the **current editor selection** using cached selection geometry, pointer bands, and related signals so they still work after the command palette takes focus.
- **Workspace bulk convert to markers** — **Highlighter: Restore all == convert all notes to markers** walks every note from `data.getAllRecords()`, applies the same “highlight link → `==…==` text” rules as the per-note command (including cross-line chains per record), then shows a **toaster** with how many notes were **reviewed** and how many had **at least one line** converted.
- **Command palette** — **Convert to text** (unwrap highlight links) or **convert to markers** (`==…==` in the source), for this note, current selection, or the whole workspace (see below).

## Markdown compatibility if you stop using the plugin

Plugin highlights are stored as **special link segments**, not as literal `==…==` in the page. Standard Markdown and most exporters expect **plain `==highlight==` syntax** in the text.

Before you remove or disable this plugin long term, run **Highlighter: Restore all == convert all notes to markers** once so **every note** in the workspace gets highlight links rewritten back into **`==…==` markers** in the line content. After that, your notes are much closer to portable Markdown / Obsidian-style highlights without depending on this plugin’s link styling.

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
| **Highlighter: Unwrap == convert to text (this note)** | Removes highlight links for every line in the open note. |
| **Highlighter: Unwrap == convert to text (current selection)** | Same, but only for lines detected from the current editor selection (cached after focus moves). |
| **Highlighter: Restore == convert to markers (this note)** | Turns highlight links back into `==…==` text for the whole note. |
| **Highlighter: Restore == convert to markers (current selection)** | Same, scoped to the current selection. |
| **Highlighter: Restore all == convert all notes to markers** | Workspace-wide convert to markers; toaster summarizes reviewed vs. changed notes. |
| **Highlighter: Enable == highlight auto-detection** | Turns automatic `==…==` detection **on** (persisted) and rescans the open note if it was off. |
| **Highlighter: Disable == highlight auto-detection** | Turns automatic detection **off** (persisted). Existing highlight links stay; new `==` is not converted until you enable again. |

Selection-scoped commands infer rows using the selection, cached geometry, pointer band, and related signals so they still work after the palette takes focus.

## Installation

Install this folder as a Thymer app plugin according to Thymer’s plugin documentation (the manifest is `plugin.json` alongside `plugin.js`).

## Files

- **`plugin.json`** — Plugin manifest (name, version, icon, description).
- **`plugin.js`** — Implementation (`AppPlugin` class); release version is also in the `PLUGIN_VERSION` constant (keep in sync with `plugin.json`).

## Development

For SDK hot reload with a bundler that expects ESM exports, you may need to add `export` before the `Plugin` class declaration in `plugin.js` (see comment at the top of that file).
