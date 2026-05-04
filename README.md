# Thymer == Highlight

Thymer plugin that treats `==highlighted text==` like Obsidian-style markers: it turns those segments into soft yellow highlights in the editor. Thymer does not ship a native highlight segment type, so the plugin stores highlights as styled link segments and injects matching CSS.

**Version:** `1.0.6` (in `plugin.json` as `version`). The `ver` field is the manifest / API version expected by Thymer. The same number appears as `PLUGIN_VERSION` at the top of `plugin.js` — keep them aligned when releasing.

## Features

- **Live conversion** — While you type or paste, `==…==` pairs on normal text/bold/italic runs become highlight links (when auto-detection is on). A **single** `==…==` span may cover a **mix** of plain, **bold**, and *italic* in one line (Thymer splits styles into separate segments): the plugin keeps one yellow highlight visually by storing **adjacent** highlight link segments, each with the right `sourceSegmentType` / `#st=` for styling. **Injected CSS** merges inner edges between consecutive highlight links (shared border/corner treatment, tighter padding) so mixed spans read as one band where links are adjacent siblings (`:has()` / `+` selectors; modern Chromium). Adjacent **bold** or **italic** cells may still split the two `=` characters across a segment boundary (`=` | `=…`) and pair. **sourceSegmentType** is stored on each link and reflected in the editor via href fragments `…/highlight#st=bold` or `#st=italic` plus CSS, so weight and slant match even when Thymer does not wrap the link in `<strong>` / `<em>`.
- **Multi-line highlights** — Highlights can span consecutive compatible lines; the plugin chains marker ranges across rows when possible.
- **Escaping** — Use `\` so `\\==` and `\\=` emit literal `==` and `=`, and `\\==` can block a pair from being treated as a delimiter. Only **`==…==`** (two equals each side) starts a span; a lone `=` next to text in another segment does not form a pair. **Code block** lines (syntax-highlighted / `getHighlightLanguage` in Thymer) are never auto-converted; inline code segments are skipped too.
- **Scan on load** — Opening a note, focusing the editor, or reloading the plugin can rescan the open page for `==…==` (when auto-detection is on).
- **Auto-detection toggle** — **Highlighter: Enable ==…== → highlight auto-convert** / **Highlighter: Disable ==…== → highlight auto-convert** turn that behavior on or off (**default: on**). The setting is stored in `**localStorage`** (keyed per plugin instance in the workspace) and survives reload. A **toaster** confirms the result (including “already on/off” if the command doesn’t change state). Manual palette actions still run when conversion is off.
- **Current selection** — Several actions target the **current editor selection** using cached selection geometry, pointer bands, and related signals so they still work after the command palette takes focus.
- **Workspace bulk unhighlight** — **Highlighter: All notes: literal ==…== for Markdown compatibility** walks every note from `data.getAllRecords()`, applies the same “highlight link → literal `==…==` in source” rules as the per-note command (including cross-line chains per record), then shows a **toaster** with how many notes were **reviewed** and how many had **at least one line** converted. 
- **Command palette** — **Eight** **Highlighter:** commands for converting to/from literal `==…==`, stripping highlight links, toggling auto-detect, and rebuilding the local index (see below).

## Markdown compatibility if you stop using the plugin

Plugin highlights are stored as **special link segments**, not as literal `==…==` in the page. Standard Markdown and most exporters expect **plain `==highlight==` syntax** in the text.

Before you remove or disable this plugin long term, run **Highlighter: All notes: literal ==…== for Markdown export** once so **every note** in the workspace gets highlight links rewritten into literal `**==…==`** in the line content. After that, your notes are much closer to portable Markdown / Obsidian-style highlights without depending on this plugin’s link styling.

## Writing highlights

Wrap the visible text in double equals:

```text
This is ==important== in this sentence.
```

Avoid wrapping inside unsupported segment types (for example code, links, mentions); those are skipped by design.

## Commands

Open the command palette and search for `Highlighter:`.

Commands are registered in the order below. **Thymer may reorder palette hits** (search ranking, locale rules, etc.) — the list here is the **intended** sequence and naming. There is **no** palette command for record-title lookup; that behavior exists only as `**_lookupRecordTitleByGuidFromPrompt`** in `plugin.js` (see **Development**).


| Command                                                            | Effect                                                                                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Highlighter: Selection: plain text (strip == highlight links)**  | Removes highlight links for lines in the current editor selection (cached after focus moves).                                                                                        |
| **Highlighter: All notes: literal ==…== for Markdown export**      | Workspace-wide: write literal `==…==` in source from highlight links; toaster summarizes reviewed vs. changed notes.                                                                 |
| **Highlighter: Rebuild local index of notes with highlight links** | Rescans every note and refreshes the browser-local map (`thymerHighlighter:recordsWithHighlights:v1`). Use after install, clearing site data, or if the list feels stale.            |
| **Highlighter: This note: literal ==…== for Markdown export**      | Whole note: highlight links → literal `==…==` in the line text.                                                                                                                      |
| **Highlighter: This note: plain text (strip == highlight links)**  | Whole note: remove highlight links, leave plain visible text.                                                                                                                        |
| **Highlighter: Disable ==…== → highlight auto-convert**            | Turns off auto-convert while typing (**persisted**). Toaster confirms (or “already off”). Existing highlights stay; new `==…==` won’t become highlight links until you enable again. |
| **Highlighter: Enable ==…== → highlight auto-convert**             | Turns on auto-convert (**persisted**), rescans the open note when state changes; **toaster** (or “already on”).                                                                      |
| **Highlighter: Selection: literal ==…== for Markdown export**      | Selection: highlight links → literal `==…==` in the line text.                                                                                                                       |


Selection-scoped commands infer rows using the selection, cached geometry, pointer band, and related signals so they still work after the command palette takes focus.

## Changelog

- **1.0.6** — Mixed plain / bold / italic inside one `==…==` on a line: cross-segment `==` delimiters (still blocked for two adjacent **text** cells); **multiple** highlight linkobjs with per-chunk `#st=`; `**emitHighlightSubrangesFromRun`**; contiguous highlight runs skip **destructive** `syncHighlightSourceTypesWithNeighbors`; `**transformSegmentsUnwrap`** coalesces adjacent highlight segments for markers / plain export. **Highlight CSS:** seam adjacent highlight anchors (inner borders/radius, overlap, tighter padding/margins). 
- **1.0.5** — use **Rebuild local index** for read-only index refresh. **Internal refactors:** `HIGHLIGHT_HEADING_LEVELS` / `buildHeadingHighlightRules`, `**highlighterToaster`**, `**_paletteCommands**` (**eight** commands). 
- **1.0.4** — Bold/italic highlight display (`#st=` href fragments + CSS); `==` detection across adjacent bold/italic cells; `sourceSegmentType` sync runs even when auto-convert is off; neighbor sync skips whitespace-only segments. 
- **1.0.3** — Version aligned across `plugin.json`, `PLUGIN_VERSION`, and README; README clarifies localStorage / site-data behavior for the highlight index.

## Installation

Install this folder as a Thymer app plugin according to Thymer’s plugin documentation (the manifest is `plugin.json` alongside `plugin.js`).

## Files

- `**plugin.json`** — Plugin manifest (name, version, icon, description).
- `**plugin.js**` — Implementation (`AppPlugin` class): segment/CSS logic, selection helpers, and commands in one file; `**PLUGIN_VERSION**` at the top (keep in sync with `plugin.json`).

## Development

For SDK hot reload with a bundler that expects ESM exports, you may need to add `export` before the `Plugin` class declaration in `plugin.js` (see comment at the top of that file).

**Internals (for contributors)** — Shipping artifact remains a single `plugin.js`. Notable structure:

- **Palette commands** — Definitions are a single array in `Plugin.onLoad`, mapped to `addCommandPaletteCommand`; `onUnload` removes every handle in `_paletteCommands` (currently **eight** commands; record title lookup is intentionally omitted from this array).
- **Toasters** — `highlighterToaster(ui, message, options)` wraps `addToaster` with defaults (`title`, `dismissible`, `autoDestroyTime`).
- **Heading highlight CSS** — Rules for `.line-div.heading-h1` … `h6` are built from `**HIGHLIGHT_HEADING_LEVELS`** (`buildHeadingHighlightRules`) so typography stays in one table.
- **Highlight chrome (`injectHighlightStyles`)** — Base styling for highlight links; **1.0.6+** adds rules so **consecutive** highlight anchors lose inner borders and corner radius (`:has(+ a)` / `a + a`) when they are adjacent siblings in the DOM, for a more continuous highlight band.

**Inspecting the highlight index** — DevTools → **Application** → **Local Storage** → Thymer origin → key `**thymerHighlighter:recordsWithHighlights:v1`**. JSON shape: **outer** keys = workspace id, **inner** keys = **record** (note) ids; values are numeric timestamps. 

**Quick console peek**

```js
JSON.parse(localStorage.getItem("thymerHighlighter:recordsWithHighlights:v1") || "{}")
```

