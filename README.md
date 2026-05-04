# Thymer == Highlight

Thymer plugin that treats `==highlighted text==` like Obsidian-style markers: it turns those segments into soft yellow highlights in the editor. Thymer does not ship a native highlight segment type, so the plugin stores highlights as styled link segments and injects matching CSS.

**Version:** `1.0.8` (in `plugin.json` as `version`). The `ver` field is the manifest / API version expected by Thymer. The same number appears as `PLUGIN_VERSION` at the top of `plugin.js` — keep them aligned when releasing.

## Features

- **Live conversion** — While you type or paste, `==…==` pairs on normal text/bold/italic runs become highlight links (when auto-detection is on). A **single** `==…==` span may cover a **mix** of plain, **bold**, and *italic* in one line (Thymer splits styles into separate segments): the plugin keeps one yellow highlight visually by storing **adjacent** highlight link segments, each with the right `sourceSegmentType` / `#st=` for styling. **Injected CSS** merges inner edges between consecutive highlight links (shared border/corner treatment, tighter padding) so mixed spans read as one band where links are adjacent siblings (`:has()` / `+` selectors; modern Chromium). Adjacent **bold** or **italic** cells may still split the two `=` characters across a segment boundary (`=` | `=…`) and pair. **sourceSegmentType** is stored on each link and reflected in the editor via href fragments `…/highlight#st=bold` or `#st=italic` plus CSS, so weight and slant match even when Thymer does not wrap the link in `<strong>` / `<em>`.
- **Multi-line highlights** — Highlights can span consecutive compatible lines; the plugin chains marker ranges across rows when possible. **Literal export** (**This note** / **Selection** / **All notes**: highlight link → `==…==`) merges **one** marker span across those rows when it can (open `==` on the first line, close on the last, content split at real line boundaries), instead of wrapping every row in its own pair.
- **Escaping** — Use `\` so `\\==` and `\\=` emit literal `==` and `=`, and `\\==` can block a pair from being treated as a delimiter. Only **`==…==`** (two equals each side) starts a span; a lone `=` next to text in another segment does not form a pair. **Code block** lines (syntax-highlighted / `getHighlightLanguage` in Thymer) are never auto-converted; inline code segments are skipped too.
- **Scan on load** — Opening a note, focusing the editor, or reloading the plugin can rescan the open page for `==…==` (when auto-detection is on).
- **Auto-detection toggle** — **Highlighter: Enable ==…== → highlight auto-convert** / **Highlighter: Disable ==…== → highlight auto-convert** turn that behavior on or off (**default: on**). The setting is stored in **`localStorage`** (keyed per plugin instance in the workspace) and survives reload. A **toaster** confirms the result (including “already on/off” if the command doesn’t change state). Manual palette actions still run when conversion is off.
- **Current selection** — Selection-scoped commands use cached **DOM range**, **union rect**, pointer band, and **`getLineItems`** geometry. **1.0.7** improves reliability when the **command palette** clears the live selection (frozen range no longer requires `rangeCount` on the top document), clears **stale line GUID** cache per run, runs a short **animation frame** before capture, hit-tests **iframe** documents for **point sampling** and **vertical-stack** sweeps (fixes many **multi-line** misses), and shows a **toaster** if no rows match.
- **Workspace bulk export** — **Highlighter: All notes: literal ==…== for Markdown export** walks every note from `data.getAllRecords()`, applies the same “highlight link → literal `==…==` in source” rules as the per-note command (including **cross-line** single-span marker restore per record where rows chain cleanly), then shows a **toaster** with how many notes were **reviewed** and how many had **at least one line** converted.; use **Rebuild local index** for a read-only full scan + index refresh only.
- **Browser-local highlight index** — **`localStorage`** key `thymerHighlighter:recordsWithHighlights:v1`: **workspace id** → **record id** → timestamp for notes that currently contain highlight links (same heuristics as export). Use **Highlighter: Rebuild local index of notes with highlight links** after clearing site data or if the map feels stale. Does **not** sync across devices.
- **Record title lookup (code only)** — `Plugin._lookupRecordTitleByGuidFromPrompt()` and helpers exist in `plugin.js` for devtools use; **not** registered in the palette (**eight** commands only—see below).

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

Commands are registered in the order below. **Thymer may reorder palette hits** (search ranking, locale rules, etc.) — the list here is the **intended** sequence and naming. There is **no** palette command for record-title lookup; see **Development**.

| Command | Effect |
|--------|--------|
| **Highlighter: Selection: plain text (strip == highlight links)** | Removes highlight links for lines in the current editor selection (cached after focus moves). |
| **Highlighter: All notes: literal ==…== for Markdown export** | Workspace-wide: write literal `==…==` in source from highlight links (same cross-row single-span rules as per-note where possible); toaster summarizes reviewed vs. changed notes. |
| **Highlighter: Rebuild local index of notes with highlight links** | Rescans every note and refreshes the browser-local map (`thymerHighlighter:recordsWithHighlights:v1`). Use after install, clearing site data, or if the list feels stale. |
| **Highlighter: This note: literal ==…== for Markdown export** | Whole note: highlight links → literal `==…==` in the line text (one logical span across consecutive rows when possible). |
| **Highlighter: This note: plain text (strip == highlight links)** | Whole note: remove highlight links, leave plain visible text. |
| **Highlighter: Disable ==…== → highlight auto-convert** | Turns off auto-convert while typing (**persisted**). Toaster confirms (or “already off”). |
| **Highlighter: Enable ==…== → highlight auto-convert** | Turns on auto-convert (**persisted**), rescans the open note when state changes; toaster. |
| **Highlighter: Selection: literal ==…== for Markdown export** | Selection: highlight links → literal `==…==` in the line text (one logical span across consecutive selected rows when possible). |

## Changelog

- **1.0.8** — **Literal ==…== export:** highlight links → markers now emit **one** `==…==` span across **consecutive chainable line items** (opening delimiter on the first row, closing on the last, inner text split at row boundaries) for **This note**, **Selection**, and **All notes** palette actions. Uses the full note order to detect chains; **skips** merge when highlight titles embed real newlines, **mixed** `#st=` types differ across rows, or **non-whitespace** sits between rows at the join. 
- **1.0.7** — **Selection-scoped commands:** frozen-range capture no longer bails when `getSelection()` has no ranges (palette focus); **clear stale `_lastTextSelectionLineGuids`** each run; empty capture clears the set; **`requestAnimationFrame`** before capture; **toaster** when no lines match. **Multi-line:** `elementsFromPoint` / vertical-stack sampling uses **`collectHitTestDocuments`** (**`guidsFromClientPointMultiDoc`**) so iframe-hosted editors resolve middle rows; **Y-sweep** when DOM maps both endpoints to the **same line GUID**. 
- **1.0.6** — Mixed plain / bold / italic inside one `==…==` on a line (cross-segment delimiters; adjacent linkobjs + `#st=`; `emitHighlightSubrangesFromRun`); contiguous highlight runs skip destructive `syncHighlightSourceTypesWithNeighbors`; `transformSegmentsUnwrap` coalesces adjacent highlight segments for export. **Highlight CSS:** seam adjacent highlight anchors. Version aligned across `plugin.json`, `PLUGIN_VERSION`, and README.
- **1.0.5** — use **Rebuild local index** for read-only refresh. Refactors: `HIGHLIGHT_HEADING_LEVELS` / `buildHeadingHighlightRules`, `highlighterToaster`, `_paletteCommands` (eight commands). `_lookupRecordTitleByGuidFromPrompt` remains in source only.
- **1.0.4** — Bold/italic highlight display (`#st=` + CSS); `==` across adjacent bold/italic cells; `sourceSegmentType` sync; neighbor sync skips whitespace-only segments.
- **1.0.3** — Version aligned across manifest + README; localStorage / site-data notes for the highlight index.

## Installation

Install this folder as a Thymer app plugin according to Thymer’s plugin documentation (the manifest is `plugin.json` alongside `plugin.js`).

## Files

- **`plugin.json`** — Plugin manifest (name, version, icon, description).
- **`plugin.js`** — Implementation (`AppPlugin` class): segment/CSS logic, selection helpers, and commands in one file; **`PLUGIN_VERSION`** at the top (keep in sync with `plugin.json`).

## Development

For SDK hot reload with a bundler that expects ESM exports, you may need to add `export` before the `Plugin` class declaration in `plugin.js` (see comment at the top of that file).

**Internals (for contributors)** — Shipping artifact remains a single `plugin.js`. Notable structure:

- **Palette commands** — Single array in `Plugin.onLoad` → `addCommandPaletteCommand`; `onUnload` clears `_paletteCommands` (**eight** commands; record title lookup omitted).
- **Toasters** — `highlighterToaster(ui, message, options)` wraps `addToaster`.
- **Heading highlight CSS** — `HIGHLIGHT_HEADING_LEVELS` + `buildHeadingHighlightRules`.
- **Highlight chrome (`injectHighlightStyles`)** — Consecutive highlight anchors: `:has(+ a)` / `a + a` seam rules (**1.0.6+**).
- **Selection → line GUIDs** — `captureTextSelectionLinesForCommands`, `getSelectedLineItemGuidSet`, `guidsFromClientPointMultiDoc` (iframe-aware hit tests), `lineGuidsFromVerticalStackSweepRange` (**1.0.7+**).
- **Cross-line marker unwrap** — `buildCrossLineMarkerUnwrapSegmentMap`, `partitionCrossLineMarkerChains` (**1.0.8+**): one logical `==…==` across rows when unwrapping highlight links to literals.
- **Record title lookup (not in palette)** — `_lookupRecordTitleByGuidFromPrompt`, `coerceRecordsArray`, `tryDataFetchRecordById`, `resolveRecordDisplayTitle`, etc.
- **Rebuild local index (palette)** — **Highlighter: Rebuild local index of notes with highlight links** invokes `_rebuildWorkspaceHighlightRecordIndex()`: walks `data.getAllRecords()`, runs highlight detection per note, and refreshes **`thymerHighlighter:recordsWithHighlights:v1`** in `localStorage` for the current workspace. Use after clearing site data or if the map is stale.

**Inspecting the highlight index** — DevTools → **Application** → **Local Storage** → Thymer origin → **`thymerHighlighter:recordsWithHighlights:v1`** (outer = workspace id, inner = record id).

```js
JSON.parse(localStorage.getItem("thymerHighlighter:recordsWithHighlights:v1") || "{}")
```
