# Thymer == Highlight

Thymer plugin that treats `==highlighted text==` like Obsidian-style markers: it turns those segments into soft yellow highlights in the editor. Thymer does not ship a native highlight segment type, so the plugin stores highlights as styled link segments and injects matching CSS.

**Version:** `1.0.3` (in `plugin.json` as `version`). The `ver` field is the manifest / API version expected by Thymer. The same number appears as `PLUGIN_VERSION` at the top of `plugin.js` — keep them aligned when releasing.

## Features

- **Live conversion** — While you type or paste, `==…==` pairs on normal text/bold/italic runs become highlight links (when auto-detection is on).
- **Multi-line highlights** — Highlights can span consecutive compatible lines; the plugin chains marker ranges across rows when possible.
- **Escaping** — Use `\` so `\\==` and `\\=` emit literal `==` and `=`, and `\\==` can block a pair from being treated as a delimiter. Only **`==…==`** (two equals each side) starts a span; a lone `=` next to text in another segment does not form a pair. **Code block** lines (syntax-highlighted / `getHighlightLanguage` in Thymer) are never auto-converted; inline code segments are skipped too.
- **Scan on load** — Opening a note, focusing the editor, or reloading the plugin can rescan the open page for `==…==` (when auto-detection is on).
- **Auto-detection toggle** — **Highlighter: Enable ==…== → highlight auto-convert** / **Highlighter: Disable ==…== → highlight auto-convert** turn that behavior on or off (**default: on**). The setting is stored in **`localStorage`** (keyed per plugin instance in the workspace) and survives reload. A **toaster** confirms the result (including “already on/off” if the command doesn’t change state). Manual palette actions still run when conversion is off.
- **Current selection** — Several actions target the **current editor selection** using cached selection geometry, pointer bands, and related signals so they still work after the command palette takes focus.
- **Workspace bulk export** — **Highlighter: All notes: literal ==…== for Markdown export** walks every note from `data.getAllRecords()`, applies the same “highlight link → literal `==…==` in source” rules as the per-note command (including cross-line chains per record), then shows a **toaster** with how many notes were **reviewed** and how many had **at least one line** converted.
- **Browser-local “which notes have highlights?” index** — Thymer’s public plugin SDK has no invisible per-note metadata field, so the plugin maintains a **localStorage** map keyed by **workspace GUID** → **record GUID** for notes that **currently** contain highlight links that pass the same heuristics as export / dry-run (syntax blocks and quote rows excluded, etc.). It updates on a short debounce after highlight-related edits, when you unwrap or bulk-convert, and when you run **Highlighter: Rebuild local index of notes with highlight links**. **Dry-run** workspace export also refreshes this map (no note writes). The map lives under the app **origin** (like other `localStorage`): removing and reinstalling the plugin does not erase it, but **clear cookies / site data** for Thymer does — after that, run **Rebuild local index** (or rely on edits) to repopulate. The data **does not sync** across browsers or devices; treat it as a filter hint, not proof.
- **Command palette** — Several **Highlighter:** commands switch between **plain text** (strip highlight links) and **literal `==…==`** in the line source for Markdown-style portability (see below).

## Markdown compatibility if you stop using the plugin

Plugin highlights are stored as **special link segments**, not as literal `==…==` in the page. Standard Markdown and most exporters expect **plain `==highlight==` syntax** in the text.

Before you remove or disable this plugin long term, run **Highlighter: All notes: literal ==…== for Markdown export** once so **every note** in the workspace gets highlight links rewritten into literal **`==…==`** in the line content. After that, your notes are much closer to portable Markdown / Obsidian-style highlights without depending on this plugin’s link styling.

## Writing highlights

Wrap the visible text in double equals:

```text
This is ==important== in this sentence.
```

Avoid wrapping inside unsupported segment types (for example code, links, mentions); those are skipped by design.

## Commands

Open the command palette and search for `Highlighter:`.

Commands are registered in the order below. **Thymer may reorder palette hits** (search ranking, locale rules, etc.) — the list here is the **intended** sequence and naming.

| Command | Effect |
|--------|--------|
| **Highlighter: Selection: plain text (strip == highlight links)** | Removes highlight links for lines in the current editor selection (cached after focus moves). |
| **Highlighter: All notes: literal ==…== for Markdown export** | Workspace-wide: write literal `==…==` in source from highlight links; toaster summarizes reviewed vs. changed notes. |
| **Highlighter: Rebuild local index of notes with highlight links** | Rescans every note and refreshes the browser-local map (`thymerHighlighter:recordsWithHighlights:v1` in **localStorage**). Use after install, clearing site data, or if the list feels stale. |
| **Highlighter: This note: literal ==…== for Markdown export** | Whole note: highlight links → literal `==…==` in the line text. |
| **Highlighter: This note: plain text (strip == highlight links)** | Whole note: remove highlight links, leave plain visible text. |
| **Highlighter: Disable ==…== → highlight auto-convert** | Turns off auto-convert while typing (**persisted**). Toaster confirms (or “already off”). Existing highlights stay; new `==…==` won’t become highlight links until you enable again. |
| **Highlighter: Enable ==…== → highlight auto-convert** | Turns on auto-convert (**persisted**), rescans the open note when state changes; **toaster** (or “already on”). |
| **Highlighter: Selection: literal ==…== for Markdown export** | Selection: highlight links → literal `==…==` in the line text. |

Selection-scoped commands infer rows using the selection, cached geometry, pointer band, and related signals so they still work after the command palette takes focus.

## Changelog

- **1.0.3** — Version aligned across `plugin.json`, `PLUGIN_VERSION`, and README; README clarifies localStorage / site-data behavior for the highlight index.

## Installation

Install this folder as a Thymer app plugin according to Thymer’s plugin documentation (the manifest is `plugin.json` alongside `plugin.js`).

## Files

- **`plugin.json`** — Plugin manifest (name, version, icon, description).
- **`plugin.js`** — Implementation (`AppPlugin` class); release version is also in the `PLUGIN_VERSION` constant (keep in sync with `plugin.json`).

## Development

For SDK hot reload with a bundler that expects ESM exports, you may need to add `export` before the `Plugin` class declaration in `plugin.js` (see comment at the top of that file).

**Workspace export dry-run (no writes)** — To see which notes and line items contain this plugin’s highlight link segments without calling `setSegments` or running cross-line rewrites, run in the browser devtools console:

```js
localStorage.setItem("thymerHighlighter:workspaceMarkdownExportDryRun", "1");
```

Then run **Highlighter: All notes: literal ==…== for Markdown export**. You get a toaster when the scan **starts** and when it **finishes**, and a structured `[Highlighter] workspace Markdown export dry-run` log with per-note names, GUIDs, and line GUIDs. The scan counts linkobjs that use the plugin sentinel URL **and** pass title heuristics: not an auto-link title equal to the href, not **email-style junk** (highlight body starting with `>` from quoted lines, prior sibling segment that is only `>` markers before the link, or only `=` underline characters), and (legacy) `sourceSegmentType` / title rules as before. Lines inside **syntax blocks** (including block children when the parent `block` has a language) and **`quote`-type** blockquote rows are excluded from the count. **Dry-run also updates** the browser-local highlight index (`thymerHighlighter:recordsWithHighlights:v1`) for each note scanned. Clear the flag with `localStorage.removeItem("thymerHighlighter:workspaceMarkdownExportDryRun")` or set `"0"` when you are ready to run a real export.

**Devtools — list record GUIDs in the index** (current workspace, this browser):

```js
thymerHighlighterGetHighlightRecordGuids?.() ?? [];
```
