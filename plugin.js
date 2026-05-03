/**
 * Global (App) plugin: converts ==highlight== in line item segments into linkobj
 * segments styled via injectCSS (Thymer has no native highlight segment type).
 * Also scans the open note on panel navigate/focus/plugin reload so existing ==…==
 * is applied without editing.
 * \\ escapes backslash; \\== and \\= emit literal == and =; \\== prevents a pair from being a delimiter.
 * Multi-line ==…== is supported across consecutive single-segment lines of the same type (text/bold/italic).
 * Within one line, consecutive text/bold/italic segments are parsed together so == survives Thymer splitting **…**.
 * A pair must be real == inside one segment (not one = at the end of a segment and the next at the start of the next).
 * Syntax blocks skip conversion: rows with `getHighlightLanguage`, children of a `block` row with `meta_properties.language`, and Thymer `quote` (email blockquote) rows; inline `code` segments were already skipped.
 *
 * “Selected lines” matches Thymer’s text workflow: we keep the line GUIDs for the current editor
 * selection (cached when focus moves, e.g. to the command palette) in _lastTextSelectionLineGuids using
 * pointer bands, geometry, frozen ranges, and related heuristics.
 *
 * For the Thymer SDK hot-reload workflow, add `export` before `class Plugin` if your bundler requires it.
 */

/** Release version; keep in sync with the `version` field in plugin.json. */
const PLUGIN_VERSION = "1.0.3";

const LS_KEY_HIGHLIGHT_DETECTION = "thymerHighlighter:highlightDetection";

function localStorageKeyHighlightDetection(plugin) {
	try {
		const g = plugin?.getGuid?.();
		return g ? `${LS_KEY_HIGHLIGHT_DETECTION}:${g}` : LS_KEY_HIGHLIGHT_DETECTION;
	} catch (_) {
		return LS_KEY_HIGHLIGHT_DETECTION;
	}
}

/** @returns {boolean} default true */
function readHighlightDetectionEnabled(plugin) {
	try {
		if (typeof localStorage === "undefined") return true;
		const v = localStorage.getItem(localStorageKeyHighlightDetection(plugin));
		if (v == null) return true;
		return v !== "0" && v !== "false";
	} catch (_) {
		return true;
	}
}

function persistHighlightDetectionEnabled(plugin, enabled) {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(localStorageKeyHighlightDetection(plugin), enabled ? "1" : "0");
	} catch (_) {}
}

/**
 * When true, “All notes: literal ==…” only scans and toasts/logs results — no setSegments, no cross-line rewrites.
 * Toggle in devtools: localStorage.setItem("thymerHighlighter:workspaceMarkdownExportDryRun", "1")
 * Clear: removeItem or set "0".
 */
const LS_KEY_WORKSPACE_MARKDOWN_EXPORT_DRY_RUN = "thymerHighlighter:workspaceMarkdownExportDryRun";

function readWorkspaceMarkdownExportDryRun() {
	try {
		if (typeof localStorage === "undefined") return false;
		const v = localStorage.getItem(LS_KEY_WORKSPACE_MARKDOWN_EXPORT_DRY_RUN);
		return v === "1" || v === "true";
	} catch (_) {
		return false;
	}
}

/**
 * Browser-local index of record GUIDs that currently contain plugin highlight link segments.
 * Not stored on Thymer records (no invisible server field in AppPlugin SDK); does not sync across devices.
 * See README + palette command “Rebuild local index…”.
 */
const LS_KEY_RECORDS_WITH_HIGHLIGHTS = "thymerHighlighter:recordsWithHighlights:v1";
const RECORD_HIGHLIGHT_INDEX_DEBOUNCE_MS = 480;

function loadRecordsWithHighlightsMap() {
	if (typeof localStorage === "undefined") return {};
	try {
		const raw = localStorage.getItem(LS_KEY_RECORDS_WITH_HIGHLIGHTS);
		if (!raw) return {};
		const o = JSON.parse(raw);
		return o && typeof o === "object" ? o : {};
	} catch (_) {
		return {};
	}
}

function persistRecordsWithHighlightsMap(all) {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(LS_KEY_RECORDS_WITH_HIGHLIGHTS, JSON.stringify(all));
	} catch (_) {}
}

function setWorkspaceRecordHasHighlightLinks(plugin, recordGuid, has) {
	const ws = String(plugin?.getWorkspaceGuid?.() ?? "").trim();
	const rg = String(recordGuid ?? "").trim();
	if (!ws || !rg || typeof localStorage === "undefined") return;
	const all = loadRecordsWithHighlightsMap();
	if (!all[ws] || typeof all[ws] !== "object") all[ws] = {};
	if (has) all[ws][rg] = Date.now();
	else delete all[ws][rg];
	if (!has && all[ws] && !Object.keys(all[ws]).length) delete all[ws];
	persistRecordsWithHighlightsMap(all);
}

/** @returns {string[]} record GUIDs marked in {@link LS_KEY_RECORDS_WITH_HIGHLIGHTS} for the current workspace */
function getWorkspaceHighlightRecordGuids(plugin) {
	const ws = String(plugin?.getWorkspaceGuid?.() ?? "").trim();
	if (!ws) return [];
	const all = loadRecordsWithHighlightsMap();
	const m = all[ws];
	if (!m || typeof m !== "object") return [];
	return Object.keys(m);
}

const HIGHLIGHT_LINK = "https://thymer.invalid/highlight";

const SKIP_SEGMENT_TYPES = new Set([
	"code",
	"icon",
	"ref",
	"mention",
	"datetime",
	"link",
	"hashtag",
]);

/** Joins adjacent “simple” line cells when detecting highlights that span line items. */
const LINE_JOIN_CHAR = "\uF000";

/** Frozen DOM range for command palette (collapsed live selection); keep generous so capture can still run. */
const FROZEN_TEXT_SELECTION_MS = 120000;
/** Last pointer-up Y band after a drag that started in the editor (release may be outside the note body). */
const VERTICAL_SELECT_BAND_MS = 45000;

/** One GUID from record/panel helpers is often wrong for multi-line text selection; trust geometry when the saved union is tall. */
function singleGuidApiLikelyWrongForMultiline(plugin, set) {
	if (!set || set.size !== 1) return false;
	const u = plugin?._lastNonCollapsedSelectionUnion;
	if (!u || Date.now() - u.t > 120000) return false;
	const h = u.maxY - u.minY;
	return h >= 16;
}

function isEqEqEscaped(str, eqIndex) {
	let n = 0;
	for (let j = eqIndex - 1; j >= 0 && str[j] === "\\"; j--) n++;
	return n % 2 === 1;
}

function findNextUnescapedEqEq(str, from) {
	for (let p = from; p <= str.length - 2; p++) {
		if (str[p] === "=" && str[p + 1] === "=" && !isEqEqEscaped(str, p)) return p;
	}
	return -1;
}

/**
 * Like findNextUnescapedEqEq, but only when both "=" come from the same Thymer segment (`map` index).
 * Prevents `foo=` + `=bar` from forming a false `==` pair across a segment boundary (real pairs are `==…==` in one cell or wholly inside one segment).
 * @param {{ si: number }[]} map from buildRunCombined
 */
function findNextUnescapedEqEqInRun(str, from, map) {
	for (let p = from; p <= str.length - 2; p++) {
		if (str[p] !== "=" || str[p + 1] !== "=" || isEqEqEscaped(str, p)) continue;
		const a = map[p];
		const b = map[p + 1];
		if (!a || !b || a.si !== b.si || a.si < 0) continue;
		return p;
	}
	return -1;
}

function containsUnescapedEqEq(str) {
	return findNextUnescapedEqEq(str, 0) !== -1;
}

function containsUnescapedEqEqInRun(str, map) {
	return findNextUnescapedEqEqInRun(str, 0, map) !== -1;
}

/** Turn user escapes into literal characters (after == delimiters are stripped). */
function unescapeText(str) {
	if (!str) return str;
	let out = "";
	let i = 0;
	while (i < str.length) {
		if (str[i] === "\\" && i + 2 < str.length && str[i + 1] === "=" && str[i + 2] === "=") {
			out += "==";
			i += 3;
		} else if (str[i] === "\\" && i + 1 < str.length && str[i + 1] === "\\") {
			out += "\\";
			i += 2;
		} else if (str[i] === "\\" && i + 1 < str.length && str[i + 1] === "=") {
			out += "=";
			i += 2;
		} else {
			out += str[i];
			i++;
		}
	}
	return out;
}

function splitByHighlightMarkerRanges(str, map) {
	const ranges = [];
	let i = 0;
	while (i < str.length) {
		const open = map
			? findNextUnescapedEqEqInRun(str, i, map)
			: findNextUnescapedEqEq(str, i);
		if (open === -1) {
			if (i < str.length) ranges.push({ kind: "text", start: i, end: str.length });
			break;
		}
		if (open > i) ranges.push({ kind: "text", start: i, end: open });
		const close = map
			? findNextUnescapedEqEqInRun(str, open + 2, map)
			: findNextUnescapedEqEq(str, open + 2);
		if (close === -1) {
			ranges.push({ kind: "text", start: open, end: str.length });
			break;
		}
		ranges.push({ kind: "highlight", start: open + 2, end: close });
		i = close + 2;
	}
	return ranges;
}

function splitByHighlightMarkers(str) {
	return splitByHighlightMarkerRanges(str).map((r) => ({
		kind: r.kind,
		value: unescapeText(str.slice(r.start, r.end)),
	}));
}

function partsToSegments(baseType, parts) {
	const out = [];
	for (const p of parts) {
		if (p.kind === "text") {
			if (p.value.length) out.push({ type: baseType, text: p.value });
		} else {
			out.push({
				type: "linkobj",
				text: {
					link: HIGHLIGHT_LINK,
					title: p.value,
					sourceSegmentType: baseType,
				},
			});
		}
	}
	return out;
}

function expandSegment(seg) {
	if (seg.type === "linkobj") {
		return [seg];
	}
	if (SKIP_SEGMENT_TYPES.has(seg.type)) {
		return [seg];
	}
	if (seg.type !== "text" && seg.type !== "bold" && seg.type !== "italic") {
		return [seg];
	}
	const raw = String(seg.text ?? "");
	if (!containsUnescapedEqEq(raw)) {
		return [seg];
	}
	const parts = splitByHighlightMarkers(raw);
	if (parts.length === 1 && parts[0].kind === "text") {
		if (parts[0].value === raw) return [seg];
		return [{ type: seg.type, text: parts[0].value }];
	}
	return partsToSegments(seg.type, parts);
}

function isSplittableSegment(seg) {
	if (!seg || SKIP_SEGMENT_TYPES.has(seg.type) || seg.type === "linkobj") return false;
	return seg.type === "text" || seg.type === "bold" || seg.type === "italic";
}

function buildRunCombined(run) {
	let combined = "";
	const map = [];
	for (let si = 0; si < run.length; si++) {
		const t = String(run[si].text ?? "");
		for (let k = 0; k < t.length; k++) {
			map.push({ si, k });
		}
		combined += t;
	}
	return { combined, map };
}

function emitTextSubrangesFromRun(run, combined, map, rs, re, out) {
	let pos = rs;
	while (pos < re) {
		const m = map[pos];
		if (!m) break;
		const si = m.si;
		let endPos = pos;
		while (endPos < re && map[endPos] && map[endPos].si === si) endPos++;
		const slice = combined.slice(pos, endPos);
		if (slice.length) out.push({ type: run[si].type, text: unescapeText(slice) });
		pos = endPos;
	}
}

/**
 * Parse == across a maximal run of text/bold/italic segments (Thymer often splits **…** into several segments).
 */
function expandSplittableRun(run) {
	if (run.length === 1) return expandSegment(run[0]);
	const { combined, map } = buildRunCombined(run);
	if (!containsUnescapedEqEqInRun(combined, map)) {
		return run.map((s) => ({ type: s.type, text: s.text }));
	}
	const ranges = splitByHighlightMarkerRanges(combined, map);
	const out = [];
	for (const r of ranges) {
		if (r.start >= r.end) continue;
		if (r.kind === "highlight") {
			const m0 = map[r.start];
			const st =
				m0 &&
				m0.si >= 0 &&
				(run[m0.si].type === "text" || run[m0.si].type === "bold" || run[m0.si].type === "italic")
					? run[m0.si].type
					: "text";
			out.push({
				type: "linkobj",
				text: {
					link: HIGHLIGHT_LINK,
					title: unescapeText(combined.slice(r.start, r.end)),
					sourceSegmentType: st,
				},
			});
		} else {
			emitTextSubrangesFromRun(run, combined, map, r.start, r.end, out);
		}
	}
	return out.length ? out : run.map((s) => ({ type: s.type, text: s.text }));
}

function mightContainHighlightSyntax(segments) {
	if (!segments?.length) return false;
	let i = 0;
	while (i < segments.length) {
		if (!isSplittableSegment(segments[i])) {
			i++;
			continue;
		}
		let j = i;
		const run = [];
		while (j < segments.length && isSplittableSegment(segments[j])) {
			run.push(segments[j]);
			j++;
		}
		const { combined, map } = buildRunCombined(run);
		if (containsUnescapedEqEqInRun(combined, map)) return true;
		i = j;
	}
	return false;
}

function transformSegments(segments) {
	if (!segments?.length) return segments;
	const next = [];
	let i = 0;
	while (i < segments.length) {
		const seg = segments[i];
		if (!isSplittableSegment(seg)) {
			next.push(...expandSegment(seg));
			i++;
			continue;
		}
		let j = i;
		const run = [];
		while (j < segments.length && isSplittableSegment(segments[j])) {
			run.push(segments[j]);
			j++;
		}
		next.push(...expandSplittableRun(run));
		i = j;
	}
	return mergeAdjacentSameType(next);
}

function mergeAdjacentSameType(segments) {
	const out = [];
	for (const seg of segments) {
		const prev = out[out.length - 1];
		if (
			prev &&
			seg.type === prev.type &&
			seg.type !== "linkobj" &&
			typeof seg.text === "string" &&
			typeof prev.text === "string"
		) {
			prev.text += seg.text;
			continue;
		}
		out.push({ type: seg.type, text: seg.text });
	}
	return out;
}

function segmentsDiffer(a, b) {
	if (!a || !b || a.length !== b.length) return true;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x.type !== y.type) return true;
		if (typeof x.text !== typeof y.text) return true;
		if (typeof x.text === "object") {
			if (JSON.stringify(x.text) !== JSON.stringify(y.text)) return true;
		} else if (x.text !== y.text) return true;
	}
	return false;
}

/**
 * True only for this plugin’s sentinel URL (exact or normalized), not longer paths that merely start with it.
 */
function linkobjHrefIsOurHighlightUrl(seg) {
	if (!seg?.text || typeof seg.text !== "object") return false;
	const raw = String(seg.text.link ?? "").trim();
	if (raw === HIGHLIGHT_LINK) return true;
	try {
		const u = new URL(raw);
		const path = u.pathname.replace(/\/+$/, "") || "/";
		return u.hostname === "thymer.invalid" && path === "/highlight";
	} catch (_) {
		return false;
	}
}

/**
 * Plugin-created highlights always set sourceSegmentType. Plain Thymer linkobjs (auto-detected URLs, pasted
 * `[text](url)`, etc.) reuse link+title only — same href in backups/plugin source can appear on hundreds of lines.
 *
 * Forwarded-email false positives: the old stitch could treat `"> "` + `"= "` as `==` — drop those via title
 * shape only (`>`-leading lines, underline-only `===`). Intentional highlights in pasted source (||, long
 * titles, etc.) must still count.
 */
function highlightTitleIsLikelyRealHighlight(title) {
	if (title == null) return false;
	const tsTrim = String(title).replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
	if (!tsTrim.length) return true;
	if (/^\s*>/.test(tsTrim)) return false;
	if (/^=+[ \t]*$/.test(tsTrim)) return false;
	return true;
}

/** Plain text/bold/italic payload for segment-order scans (same idea as simpleNeighborType). */
function segmentInlinePlainText(seg) {
	if (!seg) return "";
	if (seg.type !== "text" && seg.type !== "bold" && seg.type !== "italic") return "";
	return typeof seg.text === "string" ? seg.text : "";
}

/**
 * Email import often split `"> …=="` so the `>` sits in a prior text segment and the highlight title has no `>`.
 * Treat as junk only when **all** text before the linkobj trims to quote-marker runes (e.g. `">"` or `">>> "`),
 * not when real prose follows the marker (`"> Please see …"`).
 */
function highlightLinkobjHasEmailQuoteShimPrefix(segments, linkIndex) {
	if (!segments?.length || linkIndex < 1) return false;
	let prefix = "";
	for (let i = 0; i < linkIndex; i++) prefix += segmentInlinePlainText(segments[i]);
	return /^>+\s*$/.test(prefix.trim());
}

function lineItemRowType(item) {
	try {
		const t = item?.type ?? item?.getType?.();
		return typeof t === "string" ? t.toLowerCase() : "";
	} catch (_) {
		return "";
	}
}

function lineItemsByGuidMap(items) {
	const m = new Map();
	if (!items?.length) return m;
	for (const it of items) {
		try {
			const g = it?.guid;
			if (g) m.set(g, it);
		} catch (_) {}
	}
	return m;
}

function lineItemParentGuid(item) {
	try {
		return item?.parent_guid ?? item?.parentGuid ?? item?.getParentGuid?.() ?? null;
	} catch (_) {
		return null;
	}
}

/** Language on a syntax-colored block row (`meta_properties.language` in exports, or SDK helper). */
function lineItemSyntaxLanguageFromRow(item) {
	if (!item) return "";
	try {
		const meta = item.meta_properties ?? item.metaProperties;
		if (meta && typeof meta === "object") {
			const L = meta.language ?? meta.lang;
			if (L != null && String(L).trim()) return String(L).trim();
		}
	} catch (_) {}
	try {
		const l = item.getHighlightLanguage?.();
		if (l != null && String(l).trim()) return String(l).trim();
	} catch (_) {}
	return "";
}

/**
 * Child rows of a `block` with a language often lack `getHighlightLanguage()`; walk `parent_guid` to find it.
 */
function lineItemIsUnderSyntaxBlock(item, itemsByGuid) {
	if (!item || !itemsByGuid?.size) return false;
	const seen = new Set();
	let pg = lineItemParentGuid(item);
	for (let n = 0; n < 48 && pg; n++) {
		if (seen.has(pg)) break;
		seen.add(pg);
		const parent = itemsByGuid.get(pg);
		if (!parent) break;
		if (lineItemRowType(parent) === "block" && lineItemSyntaxLanguageFromRow(parent)) return true;
		pg = lineItemParentGuid(parent);
	}
	return false;
}

function lineItemIsCodeBlockLine(item, itemsByGuid) {
	if (!item) return false;
	if (lineItemSyntaxLanguageFromRow(item)) return true;
	if (itemsByGuid?.size && lineItemIsUnderSyntaxBlock(item, itemsByGuid)) return true;
	return false;
}

/** Quote / email blockquote rows and syntax blocks should not contribute highlight-link counts or == parsing. */
function lineItemIsNonProseHighlightHost(item, itemsByGuid) {
	if (lineItemRowType(item) === "quote") return true;
	return lineItemIsCodeBlockLine(item, itemsByGuid);
}

function isOurHighlightSegment(seg) {
	if (seg.type !== "linkobj" || !seg.text || typeof seg.text !== "object") return false;
	if (!linkobjHrefIsOurHighlightUrl(seg)) return false;

	const title = seg.text.title;
	if (title == null) return false;
	if (!highlightTitleIsLikelyRealHighlight(title)) return false;

	const linkTrim = String(seg.text.link ?? "").trim();
	const tsTrim = String(title).trim();

	const st = seg.text.sourceSegmentType;
	if (st === "text" || st === "bold" || st === "italic") {
		if (tsTrim === linkTrim) return false;
		return true;
	}

	if (!tsTrim.length) return false;
	if (tsTrim === linkTrim) return false;
	return true;
}

function lineItemHasOurHighlightLink(item, itemsByGuid) {
	if (lineItemIsNonProseHighlightHost(item, itemsByGuid)) return false;
	const segs = item?.segments;
	if (!segs?.length) return false;
	for (let i = 0; i < segs.length; i++) {
		const seg = segs[i];
		if (!isOurHighlightSegment(seg)) continue;
		if (highlightLinkobjHasEmailQuoteShimPrefix(segs, i)) continue;
		return true;
	}
	return false;
}

/**
 * Rescan one note (same rules as export dry-run) and update the browser-local highlight index.
 */
/** @returns {Promise<boolean>} whether the note currently has at least one qualifying highlight link */
async function recomputeAndStoreRecordHighlightFlag(plugin, record) {
	if (!plugin || !record) return false;
	let rg = "";
	try {
		rg = String(record.getGuid?.() ?? record.guid ?? "").trim();
	} catch (_) {}
	if (!rg) return false;
	let has = false;
	try {
		const items = await record.getLineItems(false);
		const byG = lineItemsByGuidMap(items);
		for (const item of items) {
			if (lineItemHasOurHighlightLink(item, byG)) {
				has = true;
				break;
			}
		}
	} catch (_) {}
	setWorkspaceRecordHasHighlightLinks(plugin, rg, has);
	return has;
}

function simpleNeighborType(seg) {
	if (!seg) return null;
	if (seg.type === "text" || seg.type === "bold" || seg.type === "italic") return seg.type;
	return null;
}

/**
 * After Thymer toggles bold/italic on a range, highlight linkobjs stay separate segments with a stale
 * sourceSegmentType. Align that field with neighboring text/bold/italic segments.
 * @returns {{ segments: object[], changed: boolean }}
 */
function syncHighlightSourceTypesWithNeighbors(segments) {
	if (!segments?.length) return { segments, changed: false };
	let changed = false;
	const next = [];
	for (let i = 0; i < segments.length; i++) {
		const s = segments[i];
		if (!isOurHighlightSegment(s)) {
			next.push(s);
			continue;
		}
		const lt = simpleNeighborType(next[next.length - 1]);
		const rt = simpleNeighborType(segments[i + 1]);
		let inferred = "text";
		if (lt && rt && lt === rt) inferred = lt;
		else if (lt && rt && lt !== rt) {
			if (lt === "bold" || rt === "bold") inferred = "bold";
			else if (lt === "italic" || rt === "italic") inferred = "italic";
			else inferred = lt;
		} else if (lt) inferred = lt;
		else if (rt) inferred = rt;
		const prevSt = s.text.sourceSegmentType ?? "text";
		if (prevSt !== inferred) {
			next.push({
				type: "linkobj",
				text: { ...s.text, sourceSegmentType: inferred },
			});
			changed = true;
		} else {
			next.push(s);
		}
	}
	return { segments: next, changed };
}

function highlightLinkTitle(seg) {
	if (!isOurHighlightSegment(seg)) return null;
	const t = seg.text.title;
	return t == null ? "" : String(t);
}

/** text / bold / italic segment the highlight was parsed from (unwrap restores this type). */
function highlightStoredSourceType(seg) {
	if (!isOurHighlightSegment(seg)) return "text";
	const t = seg.text.sourceSegmentType;
	if (t === "bold" || t === "italic" || t === "text") return t;
	return "text";
}

/** Escape title so it is safe inside a restored == … == pair for our parser. */
function escapeInnerForMarkers(s) {
	return String(s).replace(/\\/g, "\\\\").replace(/==/g, "\\==");
}

function domWalkLineGuid(node, validGuids) {
	let n = node?.nodeType === 3 ? node.parentElement : node;
	for (let i = 0; i < 36 && n; i++, n = n.parentElement) {
		const g = readLineItemDomGuid(n);
		if (g && validGuids.has(g)) return g;
	}
	return null;
}

/**
 * Map a DOM Selection to line item guids.
 * Multi-line ranges often keep both endpoints under the first line’s DOM; we never treat ga === gb as “one line only”.
 */
function lineGuidsFromDomTextSelection(sel, validGuids, orderedItems) {
	if (!sel?.rangeCount || !orderedItems?.length) return new Set();
	return lineGuidsFromDomTextSelectionRange(sel.getRangeAt(0), validGuids, orderedItems);
}

function lineGuidsFromDomTextSelectionRange(range, validGuids, orderedItems) {
	const out = new Set();
	if (!range || !orderedItems?.length) return out;
	if (range.collapsed) {
		const g = domWalkLineGuid(range.startContainer, validGuids);
		if (g) out.add(g);
		return out;
	}
	const ga = domWalkLineGuid(range.startContainer, validGuids);
	const gb = domWalkLineGuid(range.endContainer, validGuids);
	if (ga) out.add(ga);
	if (gb) out.add(gb);
	for (const g of lineGuidsFromRangePointSamplingRange(range, validGuids)) out.add(g);
	const idxs = [...out].map((g) => orderedItems.findIndex((it) => it.guid === g)).filter((i) => i >= 0);
	if (idxs.length >= 2) {
		const lo = Math.min(...idxs);
		const hi = Math.max(...idxs);
		for (let k = lo; k <= hi; k++) out.add(orderedItems[k].guid);
	}
	return out;
}

/** Selection nodes may live under shadow roots where host.contains(anchor) is false. */
function selectionTouchesEditorRoot(sel, root) {
	if (!sel?.rangeCount || !root) return false;
	const r = sel.getRangeAt(0);
	try {
		return (
			rootContainsDeep(root, r.startContainer) ||
			rootContainsDeep(root, r.endContainer) ||
			rootContainsDeep(root, r.commonAncestorContainer)
		);
	} catch (_) {
		return false;
	}
}

/**
 * Whether the DOM selection plausibly belongs to the editor panel (incl. shadow roots where bbox checks fail).
 */
function selectionLikelyInEditorRoots(sel, roots) {
	if (!sel?.rangeCount || !roots?.length) return false;
	if (
		roots.some((r) => selectionTouchesEditorRoot(sel, r)) ||
		selectionBBoxIntersectsAnyRoot(sel, roots)
	) {
		return true;
	}
	const range = sel.getRangeAt(0);
	try {
		const ca = range.commonAncestorContainer;
		return (
			roots.some((r) => rootContainsDeep(r, ca)) ||
			roots.some(
				(r) => rootContainsDeep(r, range.startContainer) || rootContainsDeep(r, range.endContainer)
			)
		);
	} catch (_) {
		return false;
	}
}

function rectsIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
	return ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1;
}

/** Union of `range.getClientRects()` (falls back to `getBoundingClientRect`). Use a cloned range after the live selection may have collapsed. */
function getRangeClientRectUnion(range) {
	if (!range) return null;
	const rects = Array.from(range.getClientRects()).filter((cr) => cr.width >= 0 && cr.height >= 0);
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const cr of rects) {
		if (cr.width === 0 && cr.height === 0) continue;
		minX = Math.min(minX, cr.left);
		minY = Math.min(minY, cr.top);
		maxX = Math.max(maxX, cr.right);
		maxY = Math.max(maxY, cr.bottom);
	}
	if (minX === Infinity) {
		try {
			const br = range.getBoundingClientRect();
			minX = br.left;
			minY = br.top;
			maxX = br.right;
			maxY = br.bottom;
		} catch (_) {
			return null;
		}
	}
	if (!(maxX > minX || maxY > minY)) return null;
	return { minX, minY, maxX, maxY };
}

/** Union of `getClientRects()` for the first range in `sel` (falls back to `getBoundingClientRect`). */
function getSelectionClientRectUnion(sel) {
	if (!sel?.rangeCount) return null;
	return getRangeClientRectUnion(sel.getRangeAt(0));
}

function clientUnionIntersectsAnyRoot(u, roots) {
	if (!u || !roots?.length) return false;
	if (!(u.maxX > u.minX || u.maxY > u.minY)) return false;
	for (const root of roots) {
		let cr;
		try {
			if (root.nodeType === 1 && root.getBoundingClientRect) cr = root.getBoundingClientRect();
			else if (root.nodeType === 11 && root.host?.getBoundingClientRect) cr = root.host.getBoundingClientRect();
		} catch (_) {}
		if (!cr) continue;
		if (rectsIntersect(u.minX, u.minY, u.maxX, u.maxY, cr.left, cr.top, cr.right, cr.bottom)) return true;
	}
	return false;
}

/** Like `selectionTouchesEditorRoot` but for a static `Range` (e.g. cloned before `await`). */
function rangeTouchesEditorRoot(range, root) {
	if (!range || !root) return false;
	try {
		return (
			rootContainsDeep(root, range.startContainer) ||
			rootContainsDeep(root, range.endContainer) ||
			rootContainsDeep(root, range.commonAncestorContainer)
		);
	} catch (_) {
		return false;
	}
}

function rangeLikelyInEditorRoots(range, roots) {
	if (!range || range.collapsed || !roots?.length) return false;
	if (roots.some((r) => rangeTouchesEditorRoot(range, r))) return true;
	const u = getRangeClientRectUnion(range);
	if (u && clientUnionIntersectsAnyRoot(u, roots)) return true;
	try {
		const ca = range.commonAncestorContainer;
		return (
			roots.some((r) => rootContainsDeep(r, ca)) ||
			roots.some(
				(r) => rootContainsDeep(r, range.startContainer) || rootContainsDeep(r, range.endContainer)
			)
		);
	} catch (_) {
		return false;
	}
}

/** Lines in `panelEl` whose row box intersects client union `u`. */
function lineGuidsFromPanelUnionOverlap(panelEl, validGuids, u) {
	const out = new Set();
	if (!panelEl?.querySelectorAll || !validGuids?.size || !u || typeof document === "undefined") return out;
	if (!(u.maxX > u.minX || u.maxY > u.minY)) return out;
	const minX = u.minX;
	const minY = u.minY;
	const maxX = u.maxX;
	const maxY = u.maxY;
	try {
		panelEl
			.querySelectorAll(
				"[data-line-item-id], [data-lineitem-id], [data-line-item-guid], [data-item-id], [data-row-id], [data-key], [id], .line-div"
			)
			.forEach((el) => {
				const br = el.getBoundingClientRect();
				if (!rectsIntersect(minX, minY, maxX, maxY, br.left, br.top, br.right, br.bottom)) return;
				scanAttrsForValidLineGuids(el, validGuids, out);
				const g = readLineItemDomGuid(el);
				if (g && validGuids.has(g)) out.add(g);
			});
	} catch (_) {}
	return out;
}

/** Lines whose bounding box intersects the selection union rect (works without data-* on every wrapper). */
function lineGuidsFromSelectionRectOverlap(panelEl, validGuids, domSel) {
	const out = new Set();
	if (!panelEl?.querySelectorAll || !validGuids?.size || typeof document === "undefined") return out;
	const sel = domSel ?? document.getSelection?.();
	const u = getSelectionClientRectUnion(sel);
	if (!u) return out;
	for (const g of lineGuidsFromPanelUnionOverlap(panelEl, validGuids, u)) out.add(g);
	return out;
}

function lineGuidFromCaretGeometry(panelEl, validGuids, domSel) {
	if (!panelEl || !validGuids?.size || typeof document === "undefined") return null;
	const sel = domSel ?? document.getSelection?.();
	if (!sel?.rangeCount) return null;
	const range = sel.getRangeAt(0);
	const cr = range.getBoundingClientRect();
	const x = cr.left + (cr.width > 0 ? cr.width / 2 : 0);
	const y = cr.top + (cr.height > 0 ? cr.height / 2 : 0);
	try {
		const hit = document.elementFromPoint(x, y);
		const found = guidsFromAncestorsDeep(hit, validGuids);
		if (found.size) return [...found][0];
	} catch (_) {}
	return null;
}

function lineGuidsFromPointerHit(panelEl, validGuids, x, y) {
	const out = new Set();
	if (!panelEl || !validGuids?.size || typeof document === "undefined") return out;
	if (typeof x !== "number" || typeof y !== "number") return out;
	let br = null;
	try {
		if (panelEl.nodeType === 1 && panelEl.getBoundingClientRect) br = panelEl.getBoundingClientRect();
		else if (panelEl.nodeType === 11 && panelEl.host?.getBoundingClientRect) {
			br = panelEl.host.getBoundingClientRect();
		}
	} catch (_) {
		return out;
	}
	if (!br || x < br.left || x > br.right || y < br.top || y > br.bottom) return out;
	try {
		const hit = document.elementFromPoint(x, y);
		let n = hit;
		for (let i = 0; i < 44 && n; i++, n = n.parentElement) {
			const g = readLineItemDomGuid(n);
			if (g && validGuids.has(g)) {
				out.add(g);
				break;
			}
		}
	} catch (_) {}
	return out;
}

/** Gutter / shift-range drag: all lines whose vertical center lies between two pointer Y positions. */
function lineGuidsInVerticalBand(panelEl, validGuids, y0, y1) {
	const out = new Set();
	if (!panelEl?.querySelectorAll || !validGuids?.size) return out;
	if (typeof y0 !== "number" || typeof y1 !== "number") return out;
	const lo = Math.min(y0, y1);
	const hi = Math.max(y0, y1);
	try {
		panelEl
			.querySelectorAll(
				"[data-line-item-id], [data-lineitem-id], [data-line-item-guid], [data-item-id], [id], .line-div"
			)
			.forEach((el) => {
				const br = el.getBoundingClientRect();
				const cy = (br.top + br.bottom) / 2;
				if (cy < lo || cy > hi) return;
				scanAttrsForValidLineGuids(el, validGuids, out);
				const g = readLineItemDomGuid(el);
				if (g && validGuids.has(g)) out.add(g);
			});
	} catch (_) {}
	return out;
}

/**
 * Captures row / text selection into plugin._recentSelectionGuidsFromEvents while the editor still has focus.
 * Command palette often moves focus before onSelected runs, so we also listen on document (capture).
 */
async function snapshotEditorSelectionInto(plugin, panel) {
	if (!plugin || !panel || panel.getType?.() !== PANEL_TYPE_EDITOR) return;
	const record = panel.getActiveRecord?.();
	if (!record) return;
	let items;
	try {
		items = await record.getLineItems(false);
	} catch (_) {
		return;
	}
	if (!items?.length) return;
	const valid = new Set(items.map((it) => it.guid));
	plugin._lastLineValidForSelection = valid;
	plugin._lastLineItemsForSelection = items;
	const merged = new Set();
	for (const root of collectPanelDomRoots(panel)) {
		for (const g of gatherDomSelectedLineGuids(root, valid)) merged.add(g);
		for (const g of gatherDomLineGuidsByAncestorSelection(root, valid)) merged.add(g);
	}
	/* Always merge: when focus moves to the palette, touches is often false and the DOM range is collapsed. */
	for (const g of plugin._lastTextSelectionLineGuids || []) {
		if (valid.has(g)) merged.add(g);
	}
	const rootsGeom = collectPanelDomRoots(panel);
	const storedUnion = plugin._lastNonCollapsedSelectionUnion;
	if (
		storedUnion &&
		Date.now() - storedUnion.t < 120000 &&
		items.length &&
		(storedUnion.maxX > storedUnion.minX || storedUnion.maxY > storedUnion.minY)
	) {
		const uSt = {
			minX: storedUnion.minX,
			minY: storedUnion.minY,
			maxX: storedUnion.maxX,
			maxY: storedUnion.maxY,
		};
		for (const g of lineGuidsFromItemsIntersectingClientUnion(items, valid, rootsGeom, uSt)) {
			if (!valid.has(g)) continue;
			merged.add(g);
			plugin._lastTextSelectionLineGuids.add(g);
		}
		const ySt = uSt.maxY - uSt.minY;
		if (ySt >= 4) {
			for (const root of rootsGeom) {
				for (const g of lineGuidsInVerticalBand(root, valid, uSt.minY, uSt.maxY)) {
					if (!valid.has(g)) continue;
					merged.add(g);
					plugin._lastTextSelectionLineGuids.add(g);
				}
			}
		}
	}
	if (typeof document !== "undefined") {
		const sel = getEditorDomSelection(panel);
		if (sel?.rangeCount) {
			const roots = collectPanelDomRoots(panel);
			const touches =
				roots.some((r) => selectionTouchesEditorRoot(sel, r)) ||
				selectionBBoxIntersectsAnyRoot(sel, roots);
			if (touches) {
				for (const g of lineGuidsFromDomTextSelection(sel, valid, items)) merged.add(g);
				for (const root of roots) {
					for (const g of lineGuidsFromSelectionRectOverlap(root, valid, sel)) merged.add(g);
				}
				for (const g of lineGuidsFromRangePointSampling(sel, valid)) merged.add(g);
				for (const g of lineGuidsFromVerticalStackSweep(sel, valid, roots)) merged.add(g);
				for (const g of lineGuidsFromItemsIntersectingSelectionRect(items, valid, roots, sel)) merged.add(g);
				if (!sel.getRangeAt(0).collapsed) {
					await captureTextSelectionLinesForCommands(plugin, panel);
				}
				if (sel.getRangeAt(0).collapsed) {
					for (const root of roots) {
						const gc = lineGuidFromCaretGeometry(root, valid, sel);
						if (gc) merged.add(gc);
					}
				}
			}
		}
	}
	const lp = plugin._lastPointerInEditor;
	if (lp && Date.now() - lp.t < 12000) {
		for (const root of collectPanelDomRoots(panel)) {
			for (const g of lineGuidsFromPointerHit(root, valid, lp.x, lp.y)) merged.add(g);
		}
	}
	if (!merged.size) {
		for (const root of collectPanelDomRoots(panel)) {
			for (const g of gatherFocusedLineGuidsInPanel(root, valid)) merged.add(g);
		}
	}
	plugin._recentSelectionGuidsFromEvents = merged;
	clearTimeout(plugin._selectionGuidsFromEventClearT);
	plugin._selectionGuidsFromEventClearT = setTimeout(() => {
		plugin._recentSelectionGuidsFromEvents = new Set();
	}, 15000);
}

/**
 * @param {"plain" | "markers"} mode plain: link title only; markers: ==title== (escaped)
 * @returns {object[]|null} new segments, or null if nothing to unwrap
 */
function transformSegmentsUnwrap(segments, mode) {
	if (!segments || !segments.length) return null;
	const out = [];
	let changed = false;
	for (const seg of segments) {
		if (isOurHighlightSegment(seg)) {
			changed = true;
			const title = highlightLinkTitle(seg);
			const outType = highlightStoredSourceType(seg);
			if (mode === "plain") {
				if (title.length) out.push({ type: outType, text: title });
			} else {
				const inner = escapeInnerForMarkers(title);
				out.push({ type: outType, text: `==${inner}==` });
			}
		} else {
			out.push({ type: seg.type, text: seg.text });
		}
	}
	if (!changed) return null;
	if (!out.length) return [{ type: "text", text: "" }];
	return mergeAdjacentSameType(out);
}

function getSimpleTextCell(item) {
	const segs = item.segments;
	if (!segs || segs.length !== 1) return null;
	const s = segs[0];
	if (s.type !== "text" && s.type !== "bold" && s.type !== "italic") return null;
	if (SKIP_SEGMENT_TYPES.has(s.type)) return null;
	return { type: s.type, text: String(s.text) };
}

function mergeAdjacentKindParts(parts) {
	const out = [];
	for (const p of parts) {
		const prev = out[out.length - 1];
		if (prev && prev.kind === p.kind && (p.kind === "text" || p.kind === "highlight")) {
			prev.value += p.value;
		} else {
			out.push({ kind: p.kind, value: p.value });
		}
	}
	return out;
}

function lineOffsetsFromLens(lens) {
	const starts = [];
	let off = 0;
	for (let k = 0; k < lens.length; k++) {
		starts.push(off);
		off += lens[k];
		if (k < lens.length - 1) off += 1;
	}
	return starts;
}

function projectRangesOntoLines(combined, ranges, starts, lens) {
	const n = lens.length;
	const lineParts = Array.from({ length: n }, () => []);
	const lineEnd = (k) => starts[k] + lens[k];
	for (const r of ranges) {
		for (let k = 0; k < n; k++) {
			const lo = Math.max(r.start, starts[k]);
			const hi = Math.min(r.end, lineEnd(k));
			if (lo < hi) {
				lineParts[k].push({
					kind: r.kind,
					value: unescapeText(combined.slice(lo, hi)),
				});
			}
		}
	}
	return lineParts.map((lp) => mergeAdjacentKindParts(lp));
}

function segmentsFromParts(baseType, mergedParts) {
	const out = partsToSegments(baseType, mergedParts);
	if (!out.length) return [{ type: baseType, text: "" }];
	return out;
}

async function maybeRewriteCrossLineChain(chain, skipGuids) {
	if (skipGuids && chain.some((c) => skipGuids.has(c.item.guid))) return;
	const baseType = chain[0].type;
	const lens = chain.map((c) => c.text.length);
	for (const c of chain) {
		if (c.text.includes(LINE_JOIN_CHAR)) return;
	}
	let combined = "";
	const map = [];
	for (let si = 0; si < chain.length; si++) {
		const t = chain[si].text;
		for (let k = 0; k < t.length; k++) map.push({ si });
		combined += t;
		if (si < chain.length - 1) {
			for (let k = 0; k < LINE_JOIN_CHAR.length; k++) map.push({ si: -1 });
			combined += LINE_JOIN_CHAR;
		}
	}
	if (!containsUnescapedEqEqInRun(combined, map)) return;

	const ranges = splitByHighlightMarkerRanges(combined, map);
	const hasHighlight = ranges.some((r) => r.kind === "highlight");
	if (!hasHighlight) return;

	const starts = lineOffsetsFromLens(lens);
	const perLine = projectRangesOntoLines(combined, ranges, starts, lens);

	for (let k = 0; k < chain.length; k++) {
		const newSegs = segmentsFromParts(baseType, perLine[k]);
		const oldSegs = chain[k].item.segments;
		if (!segmentsDiffer(oldSegs, newSegs)) continue;
		await chain[k].item.setSegments(newSegs);
	}
}

async function applyCrossLineHighlightChains(record, skipGuids, itemsPreloaded) {
	const items = itemsPreloaded ?? (await record.getLineItems(false));
	const byG = lineItemsByGuidMap(items);
	let i = 0;
	while (i < items.length) {
		if (lineItemIsNonProseHighlightHost(items[i], byG)) {
			i++;
			continue;
		}
		const first = getSimpleTextCell(items[i]);
		if (!first) {
			i++;
			continue;
		}
		if (skipGuids?.has(items[i].guid)) {
			i++;
			continue;
		}
		let j = i;
		const chain = [{ item: items[i], type: first.type, text: first.text }];
		while (j + 1 < items.length) {
			if (skipGuids?.has(items[j + 1].guid)) break;
			if (lineItemIsNonProseHighlightHost(items[j + 1], byG)) break;
			const next = getSimpleTextCell(items[j + 1]);
			if (!next || next.type !== first.type) break;
			if (next.text.includes(LINE_JOIN_CHAR)) break;
			chain.push({ item: items[j + 1], type: next.type, text: next.text });
			j++;
		}
		if (chain.length >= 2) await maybeRewriteCrossLineChain(chain, skipGuids);
		i = j + 1;
	}
}

function injectHighlightStyles(ui) {
	ui.injectCSS(`
a[href^="${HIGHLIGHT_LINK}"] {
	/* Obsidian-style ==mark==: pale creamy gold + deep golden-brown label text */
	/* Longhands (not font: shorthand) so H1/H2 size wins over global link styles in Thymer */
	font-family: inherit !important;
	font-size: inherit !important;
	/* bolder steps from computed parent so bold rows still read bold inside linkobj overrides */
	font-weight: bolder !important;
	font-style: inherit !important;
	font-stretch: inherit !important;
	font-variant: inherit !important;
	line-height: inherit !important;
	letter-spacing: inherit !important;
	text-transform: inherit !important;
	vertical-align: baseline;
	display: inline !important;
	background-color: #fdf0d4;
	border: 1px solid #ead6b2;
	border-radius: 3px;
	padding: 0.1em 0.32em;
	margin: 0 0.04em;
	color: #5c4819 !important;
	text-decoration: none !important;
	box-decoration-break: clone;
	-webkit-box-decoration-break: clone;
	cursor: inherit;
	pointer-events: none;
}
/* Highlight <a> often keeps default weight inside bold UI — match common Thymer / rich-text wrappers */
.line-div strong a.lineitem-linkobj[href^="${HIGHLIGHT_LINK}"],
.line-div strong a[href^="${HIGHLIGHT_LINK}"],
.line-div b a.lineitem-linkobj[href^="${HIGHLIGHT_LINK}"],
.line-div b a[href^="${HIGHLIGHT_LINK}"],
.lineitem-text.bold a.lineitem-linkobj[href^="${HIGHLIGHT_LINK}"],
.lineitem-text.bold a[href^="${HIGHLIGHT_LINK}"],
.line-div [class*="lineitem-bold"] a.lineitem-linkobj[href^="${HIGHLIGHT_LINK}"],
.line-div [class*="segment-bold"] a.lineitem-linkobj[href^="${HIGHLIGHT_LINK}"],
.font-bold a.lineitem-linkobj[href^="${HIGHLIGHT_LINK}"],
[data-font-weight="bold"] a.lineitem-linkobj[href^="${HIGHLIGHT_LINK}"] {
	font-weight: 700 !important;
}
.line-div em a.lineitem-linkobj[href^="${HIGHLIGHT_LINK}"],
.line-div em a[href^="${HIGHLIGHT_LINK}"],
.line-div i a.lineitem-linkobj[href^="${HIGHLIGHT_LINK}"] {
	font-style: italic !important;
}
h1 a[href^="${HIGHLIGHT_LINK}"],
h2 a[href^="${HIGHLIGHT_LINK}"],
h3 a[href^="${HIGHLIGHT_LINK}"],
h4 a[href^="${HIGHLIGHT_LINK}"],
h5 a[href^="${HIGHLIGHT_LINK}"],
h6 a[href^="${HIGHLIGHT_LINK}"] {
	font-size: inherit !important;
	font-weight: inherit !important;
	font-style: inherit !important;
	line-height: inherit !important;
	letter-spacing: inherit !important;
	font-family: inherit !important;
}
/* Thymer applies heading size to .lineitem-text, not the parent .line-div — inherit on the <a> stays body-sized.
   Match each heading level explicitly and override .lineitem-linkobj monospace. */
.line-div.heading-h1 a.lineitem-linkobj[href^="${HIGHLIGHT_LINK}"],
.line-div.heading-h1 a[href^="${HIGHLIGHT_LINK}"] {
	font-size: 2rem !important;
	font-weight: 700 !important;
	font-style: normal !important;
	line-height: 1.2 !important;
	letter-spacing: inherit !important;
	font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
}
.line-div.heading-h2 a.lineitem-linkobj[href^="${HIGHLIGHT_LINK}"],
.line-div.heading-h2 a[href^="${HIGHLIGHT_LINK}"] {
	font-size: 1.65rem !important;
	font-weight: 650 !important;
	font-style: normal !important;
	line-height: 1.22 !important;
	letter-spacing: inherit !important;
	font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
}
.line-div.heading-h3 a.lineitem-linkobj[href^="${HIGHLIGHT_LINK}"],
.line-div.heading-h3 a[href^="${HIGHLIGHT_LINK}"] {
	font-size: 1.35rem !important;
	font-weight: 600 !important;
	font-style: normal !important;
	line-height: 1.25 !important;
	letter-spacing: inherit !important;
	font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
}
.line-div.heading-h4 a.lineitem-linkobj[href^="${HIGHLIGHT_LINK}"],
.line-div.heading-h4 a[href^="${HIGHLIGHT_LINK}"] {
	font-size: 1.2rem !important;
	font-weight: 600 !important;
	font-style: normal !important;
	line-height: 1.28 !important;
	letter-spacing: inherit !important;
	font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
}
.line-div.heading-h5 a.lineitem-linkobj[href^="${HIGHLIGHT_LINK}"],
.line-div.heading-h5 a[href^="${HIGHLIGHT_LINK}"] {
	font-size: 1.05rem !important;
	font-weight: 600 !important;
	font-style: normal !important;
	line-height: 1.3 !important;
	letter-spacing: inherit !important;
	font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
}
.line-div.heading-h6 a.lineitem-linkobj[href^="${HIGHLIGHT_LINK}"],
.line-div.heading-h6 a[href^="${HIGHLIGHT_LINK}"] {
	font-size: 0.95rem !important;
	font-weight: 600 !important;
	font-style: normal !important;
	line-height: 1.32 !important;
	letter-spacing: inherit !important;
	font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
}
@media (prefers-color-scheme: dark) {
	a[href^="${HIGHLIGHT_LINK}"] {
		background-color: #3d3428;
		border-color: #5c4f38;
		color: #f2e8c8 !important;
	}
}
`);
}

/** Matches Thymer's NAVIGATION_PANEL_EDITOR — editor / note body. */
const PANEL_TYPE_EDITOR = "edit_panel";

/**
 * Command palette / modals can become the “active” panel while the note stays open in the editor.
 * Selection events and DOM roots must still target the editor panel.
 */
function getEditorPanelForSelection(ui) {
	if (!ui) return null;
	try {
		const active = ui.getActivePanel?.();
		if (active?.getType?.() === PANEL_TYPE_EDITOR) return active;
		const panels = ui.getPanels?.();
		if (panels && typeof panels[Symbol.iterator] === "function") {
			for (const p of panels) {
				if (p?.getType?.() === PANEL_TYPE_EDITOR && p?.getActiveRecord?.()) return p;
			}
			for (const p of panels) {
				if (p?.getType?.() === PANEL_TYPE_EDITOR) return p;
			}
		}
	} catch (_) {}
	return null;
}

function looksLikeUuid(s) {
	return (
		typeof s === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim())
	);
}

function walkNavForGuids(value, out, depth) {
	if (value == null || depth > 28) return;
	if (typeof value === "string") {
		if (looksLikeUuid(value)) out.add(value.trim());
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) walkNavForGuids(v, out, depth + 1);
		return;
	}
	if (typeof value !== "object") return;
	for (const [k, v] of Object.entries(value)) {
		const kl = k.toLowerCase();
		const deep =
			depth < 22 ||
			kl.includes("select") ||
			kl.includes("line") ||
			(kl.includes("item") && kl.includes("guid")) ||
			kl.includes("range") ||
			kl.includes("cursor") ||
			kl.includes("anchor") ||
			kl === "head" ||
			kl === "focus";
		if (deep) walkNavForGuids(v, out, depth + 1);
	}
}

function readLineItemDomGuid(el) {
	if (!el?.getAttribute) return null;
	return (
		el.getAttribute("data-line-item-id") ||
		el.getAttribute("data-lineitem-id") ||
		el.getAttribute("data-line-item-guid") ||
		el.getAttribute("data-guid") ||
		el.getAttribute("data-item-id") ||
		el.getAttribute("data-row-id") ||
		null
	);
}

/** Thymer may store the line UUID in any attribute or inside a compound id. */
function scanAttrsForValidLineGuids(el, validGuids, out) {
	if (!el || el.nodeType !== 1 || !out || !validGuids?.size) return;
	try {
		const chunks = [];
		if (el.id) chunks.push(el.id);
		for (const name of el.getAttributeNames?.() || []) {
			const v = el.getAttribute(name);
			if (v) chunks.push(v);
		}
		for (const part of chunks) {
			const t = part.trim();
			if (validGuids.has(t)) out.add(t);
			const found = t.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
			if (found) {
				for (const g of found) {
					if (validGuids.has(g)) out.add(g);
				}
			}
		}
	} catch (_) {}
}

function guidsFromAncestorsDeep(node, validGuids) {
	const out = new Set();
	let n = node?.nodeType === 3 ? node?.parentElement : node;
	for (let i = 0; i < 80 && n; i++, n = n.parentElement) {
		scanAttrsForValidLineGuids(n, validGuids, out);
		const g = readLineItemDomGuid(n);
		if (g && validGuids.has(g)) out.add(g);
	}
	return out;
}

function selectionBBoxIntersectsAnyRoot(sel, roots) {
	if (!sel?.rangeCount || !roots?.length) return false;
	let br;
	try {
		br = sel.getRangeAt(0).getBoundingClientRect();
	} catch (_) {
		return false;
	}
	if (br.width <= 0 && br.height <= 0) return false;
	for (const root of roots) {
		let cr;
		try {
			if (root.nodeType === 1 && root.getBoundingClientRect) cr = root.getBoundingClientRect();
			else if (root.nodeType === 11 && root.host?.getBoundingClientRect) cr = root.host.getBoundingClientRect();
		} catch (_) {}
		if (!cr) continue;
		if (rectsIntersect(br.left, br.top, br.right, br.bottom, cr.left, cr.top, cr.right, cr.bottom)) return true;
	}
	return false;
}

function lineGuidsFromRangePointSamplingRange(range, validGuids) {
	const out = new Set();
	if (!range || !validGuids?.size || typeof document === "undefined") return out;
	const rects = Array.from(range.getClientRects()).filter((cr) => cr.width >= 0 && cr.height >= 0);
	const pts = [];
	for (const cr of rects) {
		if (cr.width === 0 && cr.height === 0) continue;
		const xs = [cr.left + 1, cr.left + cr.width * 0.5, cr.right - 1];
		const ys = [cr.top + 1, cr.top + cr.height * 0.5, cr.bottom - 1];
		for (const x of xs) {
			for (const y of ys) pts.push([x, y]);
		}
	}
	if (!pts.length) {
		const cr = range.getBoundingClientRect();
		pts.push([cr.left + Math.max(1, cr.width) * 0.5, cr.top + Math.max(1, cr.height) * 0.5]);
	}
	for (const [x, y] of pts.slice(0, 48)) {
		let hit = null;
		try {
			hit = document.elementFromPoint(x, y);
		} catch (_) {
			continue;
		}
		for (const g of guidsFromAncestorsDeep(hit, validGuids)) out.add(g);
	}
	return out;
}

function lineGuidsFromRangePointSampling(sel, validGuids) {
	if (!sel?.rangeCount || !validGuids?.size || typeof document === "undefined") return new Set();
	return lineGuidsFromRangePointSamplingRange(sel.getRangeAt(0), validGuids);
}

function rootContainsDeep(root, el) {
	if (!root || !el) return false;
	try {
		if (el.getRootNode?.() === root) return true;
	} catch (_) {}
	try {
		if (root.contains(el)) return true;
	} catch (_) {}
	try {
		if (root.nodeType === 11 && root.host?.contains(el)) return true;
	} catch (_) {}
	let n = el;
	for (let i = 0; i < 90 && n; i++, n = n.parentNode) {
		if (n === root) return true;
	}
	return false;
}

/** True when range endpoints live under roots from collectPanelDomRoots (handles shadow / nested DOM). */
function rangeAnchoredInEditorRoots(range, panel) {
	if (!range || !panel) return false;
	let roots;
	try {
		roots = collectPanelDomRoots(panel);
	} catch (_) {
		return false;
	}
	if (!roots.length) return false;
	const ok = (node) => {
		if (!node) return false;
		try {
			return roots.some((r) => rootContainsDeep(r, node));
		} catch (_) {
			return false;
		}
	};
	try {
		return (
			ok(range.startContainer) ||
			ok(range.endContainer) ||
			ok(range.commonAncestorContainer)
		);
	} catch (_) {
		return false;
	}
}

function lineGuidsFromVerticalStackSweepRange(range, validGuids, panelRoots) {
	const out = new Set();
	if (!range || !validGuids?.size || !panelRoots?.length || typeof document === "undefined") {
		return out;
	}
	const rects = Array.from(range.getClientRects()).filter((cr) => cr.width >= 0 && cr.height >= 0);
	let minY = Infinity;
	let maxY = -Infinity;
	let minX = Infinity;
	let maxX = -Infinity;
	for (const cr of rects) {
		if (cr.width === 0 && cr.height === 0) continue;
		minY = Math.min(minY, cr.top);
		maxY = Math.max(maxY, cr.bottom);
		minX = Math.min(minX, cr.left);
		maxX = Math.max(maxX, cr.right);
	}
	if (minY === Infinity) {
		const br = range.getBoundingClientRect();
		minY = br.top;
		maxY = br.bottom;
		minX = br.left;
		maxX = br.right;
	}
	const h = Math.max(1, maxY - minY);
	const cx = (minX + maxX) * 0.5;
	const w = Math.max(0, maxX - minX);
	let xsUse = w > 24 ? [minX + 3, cx, maxX - 3].filter((x, i, a) => a.indexOf(x) === i) : [cx];
	if (!xsUse.length || xsUse.some((x) => typeof x !== "number" || Number.isNaN(x))) xsUse = [cx];
	const steps = Math.max(14, Math.min(56, Math.ceil(h / 5)));
	for (let s = 0; s <= steps; s++) {
		const y = minY + (h * s) / Math.max(1, steps) + 1;
		for (const x of xsUse) {
			let stack;
			try {
				stack = document.elementsFromPoint(x, y);
			} catch (_) {
				continue;
			}
			for (const el of stack || []) {
				if (!panelRoots.some((r) => rootContainsDeep(r, el))) continue;
				for (const g of guidsFromAncestorsDeep(el, validGuids)) out.add(g);
			}
		}
	}
	return out;
}

/**
 * Multi-line ranges often keep start/end in the first line’s subtree; walk Y with elementsFromPoint
 * so every row the highlight crosses is included.
 */
function lineGuidsFromVerticalStackSweep(sel, validGuids, panelRoots) {
	if (!sel?.rangeCount || !validGuids?.size || !panelRoots?.length || typeof document === "undefined") {
		return new Set();
	}
	return lineGuidsFromVerticalStackSweepRange(sel.getRangeAt(0), validGuids, panelRoots);
}

/**
 * Map each valid line guid to DOM nodes that represent that row (for geometry vs selection).
 * Prefers explicit data-* ids; otherwise a single UUID match from attribute/id scan.
 */
function buildGuidToLineElementsMap(panelRoots, validGuids) {
	const m = new Map();
	if (!panelRoots?.length || !validGuids?.size) return m;
	const selector =
		"[data-line-item-id], [data-lineitem-id], [data-line-item-guid], [data-item-id], [data-row-id], .line-div";
	for (const root of panelRoots) {
		if (!root?.querySelectorAll) continue;
		try {
			root.querySelectorAll(selector).forEach((el) => {
				let g = readLineItemDomGuid(el);
				if (g && !validGuids.has(g)) g = null;
				if (!g) {
					const tmp = new Set();
					scanAttrsForValidLineGuids(el, validGuids, tmp);
					if (tmp.size !== 1) return;
					g = [...tmp][0];
				}
				if (!m.has(g)) m.set(g, []);
				m.get(g).push(el);
			});
		} catch (_) {}
	}
	return m;
}

/** Row nodes for a line GUID when the broad map misses (exact attribute match). */
function queryLineRowElementsForGuid(panelRoots, g) {
	const out = [];
	if (!g || !panelRoots?.length) return out;
	let esc = String(g);
	try {
		if (typeof CSS !== "undefined" && CSS.escape) esc = CSS.escape(esc);
	} catch (_) {}
	const sels = [
		`[data-line-item-id="${esc}"]`,
		`[data-lineitem-id="${esc}"]`,
		`[data-line-item-guid="${esc}"]`,
		`[data-guid="${esc}"]`,
		`[data-item-id="${esc}"]`,
		`[data-row-id="${esc}"]`,
	];
	for (const root of panelRoots) {
		if (!root?.querySelectorAll) continue;
		for (const s of sels) {
			try {
				root.querySelectorAll(s).forEach((el) => out.push(el));
			} catch (_) {}
		}
	}
	return out;
}

/** Line items whose row DOM intersects client-rect union `u` (no live Selection needed). */
function lineGuidsFromItemsIntersectingClientUnion(items, validGuids, panelRoots, u) {
	const out = new Set();
	if (!u || !items?.length || !validGuids?.size || !panelRoots?.length) return out;
	const map = buildGuidToLineElementsMap(panelRoots, validGuids);
	for (const it of items) {
		const g = it.guid;
		if (!validGuids.has(g)) continue;
		let els = map.get(g);
		if (!els?.length) els = queryLineRowElementsForGuid(panelRoots, g);
		if (!els?.length) continue;
		for (const el of els) {
			let br;
			try {
				br = el.getBoundingClientRect();
			} catch (_) {
				continue;
			}
			if (rectsIntersect(u.minX, u.minY, u.maxX, u.maxY, br.left, br.top, br.right, br.bottom)) {
				out.add(g);
				break;
			}
		}
	}
	return out;
}

/** Every line item whose row rect intersects the selection union (stable when range endpoints sit on one line). */
function lineGuidsFromItemsIntersectingSelectionRect(items, validGuids, panelRoots, sel) {
	const u = getSelectionClientRectUnion(sel);
	return lineGuidsFromItemsIntersectingClientUnion(items, validGuids, panelRoots, u);
}

function gatherDomSelectedLineGuids(panelEl, validGuids) {
	const out = new Set();
	if (!panelEl?.querySelectorAll || !validGuids?.size) return out;

	const selectors = [
		"[data-line-item-id].selected",
		"[data-line-item-id].is-selected",
		".selected[data-line-item-id]",
		"[data-line-item-id][aria-selected=\"true\"]",
		"[data-lineitem-id].selected",
		"[data-lineitem-id].is-selected",
		"[data-lineitem-id][aria-selected=\"true\"]",
		"[data-guid].selected",
		".selected[data-guid]",
		".line-div.selected[data-line-item-id]",
		".line-div.is-selected[data-line-item-id]",
	];
	for (const sel of selectors) {
		try {
			panelEl.querySelectorAll(sel).forEach((node) => {
				const g = readLineItemDomGuid(node);
				if (g && validGuids.has(g)) out.add(g);
			});
		} catch (_) {}
	}

	try {
		panelEl.querySelectorAll("[data-line-item-id], [data-lineitem-id]").forEach((el) => {
			const g = readLineItemDomGuid(el);
			if (!g || !validGuids.has(g)) return;
			if (
				el.classList.contains("selected") ||
				el.classList.contains("is-selected") ||
				el.getAttribute("aria-selected") === "true"
			) {
				out.add(g);
				return;
			}
			let p = el.parentElement;
			for (let d = 0; d < 6 && p; d++, p = p.parentElement) {
				if (p.classList?.contains("selected") || p.classList?.contains("is-selected")) {
					out.add(g);
					return;
				}
			}
		});
	} catch (_) {}

	try {
		panelEl.querySelectorAll(".selected, .is-selected").forEach((mark) => {
			const carrier =
				mark.closest("[data-line-item-id], [data-lineitem-id]") ||
				mark.querySelector("[data-line-item-id], [data-lineitem-id]");
			const g = readLineItemDomGuid(carrier);
			if (g && validGuids.has(g)) out.add(g);
		});
	} catch (_) {}

	return out;
}

function activeElementInsidePanelTree(panelEl, ae) {
	if (!panelEl || !ae) return false;
	if (panelEl.contains(ae)) return true;
	try {
		let n = ae;
		for (let i = 0; i < 12 && n; i++, n = n.parentNode) {
			if (n === panelEl) return true;
			if (n instanceof ShadowRoot && panelEl.contains(n.host)) return true;
		}
	} catch (_) {}
	return false;
}

/** Last resort: caret inside the panel maps to one line item guid. */
function gatherFocusedLineGuidsInPanel(panelEl, validGuids) {
	const out = new Set();
	if (!panelEl || !validGuids?.size) return out;
	let ae = null;
	try {
		const root = panelEl.getRootNode?.();
		ae = root?.activeElement ?? (typeof document !== "undefined" ? document.activeElement : null);
	} catch (_) {
		return out;
	}
	if (!ae || !activeElementInsidePanelTree(panelEl, ae)) return out;
	let n = ae;
	for (let i = 0; i < 28 && n; i++, n = n.parentElement) {
		const g = readLineItemDomGuid(n);
		if (g && validGuids.has(g)) {
			out.add(g);
			break;
		}
	}
	return out;
}

function collectPanelDomRoots(panel) {
	const roots = [];
	const seen = new Set();
	const add = (el) => {
		if (!el) return;
		if (typeof el.querySelectorAll === "function" && !seen.has(el)) {
			seen.add(el);
			roots.push(el);
		}
		if (el?.shadowRoot && typeof el.shadowRoot.querySelectorAll === "function" && !seen.has(el.shadowRoot)) {
			seen.add(el.shadowRoot);
			roots.push(el.shadowRoot);
		}
		if (el.nodeType === 1 && el.tagName === "IFRAME") {
			try {
				const docEl = el.contentDocument?.documentElement;
				if (docEl) add(docEl);
			} catch (_) {}
		}
		if (el.nodeType === 1 && typeof el.querySelectorAll === "function") {
			try {
				for (const fr of el.querySelectorAll("iframe")) {
					try {
						const docEl = fr.contentDocument?.documentElement;
						if (docEl) add(docEl);
					} catch (_) {}
				}
			} catch (_) {}
		}
	};
	try {
		const host = panel?.getElement?.();
		add(host);
		add(panel?.element);
		add(panel?.getDomRoot?.());
	} catch (_) {}
	return roots;
}

/**
 * `Element.contains()` is false for nodes in a child document or in shadow trees vs host.
 * Pass the raw event when possible so `composedPath()` sees shadow-internal targets.
 */
function eventTargetInEditorPanel(panel, evOrTarget) {
	if (!panel || panel.getType?.() !== PANEL_TYPE_EDITOR) return false;
	const candidates = [];
	try {
		if (evOrTarget && typeof evOrTarget.composedPath === "function") {
			for (const n of evOrTarget.composedPath()) {
				if (n != null) candidates.push(n);
			}
		}
	} catch (_) {}
	const t = evOrTarget?.target ?? evOrTarget;
	if (t != null) {
		if (!candidates.includes(t)) candidates.push(t);
	}
	if (!candidates.length) return false;
	try {
		const el = panel.getElement?.();
		if (el?.nodeType === 1 && el.tagName === "IFRAME") {
			const doc = el.contentDocument;
			if (doc) {
				for (const node of candidates) {
					if (node?.ownerDocument === doc) return true;
				}
			}
		}
		if (el?.nodeType === 1 && typeof el.contains === "function") {
			for (const node of candidates) {
				if (node?.nodeType === 1 && el.contains(node)) return true;
			}
		}
		for (const r of collectPanelDomRoots(panel)) {
			if (typeof r.contains !== "function") continue;
			for (const node of candidates) {
				if (r.contains(node)) return true;
			}
		}
	} catch (_) {}
	return false;
}

/** Documents that can legally answer elementFromPoint / getSelection for this editor (main + nested same-origin iframes). */
function collectHitTestDocuments(panel, range) {
	const docs = [];
	const add = (d) => {
		if (d && typeof d.elementFromPoint === "function" && !docs.includes(d)) docs.push(d);
	};
	try {
		if (typeof document !== "undefined") add(document);
	} catch (_) {}
	try {
		if (range?.startContainer?.ownerDocument) add(range.startContainer.ownerDocument);
		if (range?.endContainer?.ownerDocument) add(range.endContainer.ownerDocument);
	} catch (_) {}
	try {
		const host = panel?.getElement?.();
		if (host?.tagName === "IFRAME" && host.contentDocument) add(host.contentDocument);
	} catch (_) {}
	return docs;
}

/** `document.elementFromPoint` on the wrong document only sees the outer page — misses iframe/shadow content entirely. */
function hitElementFromClientPointForLineGuids(cx, cy, panel, range, validGuids) {
	for (const doc of collectHitTestDocuments(panel, range)) {
		try {
			const stack = doc.elementsFromPoint?.(cx, cy);
			if (stack?.length) {
				for (const el of stack) {
					for (const g of guidsFromAncestorsDeep(el, validGuids)) {
						return { el, doc };
					}
				}
			}
			const one = doc.elementFromPoint(cx, cy);
			if (one) {
				for (const g of guidsFromAncestorsDeep(one, validGuids)) {
					return { el: one, doc };
				}
			}
		} catch (_) {}
	}
	return null;
}

/** Iframes first — the editor’s Selection usually lives in `contentWindow`, not the outer `document`. */
function collectEditorWindowsInPriorityOrder(panel) {
	const wins = [];
	const seen = new Set();
	const add = (w) => {
		if (w && typeof w.getSelection === "function" && !seen.has(w)) {
			seen.add(w);
			wins.push(w);
		}
	};
	const visit = (node) => {
		if (!node) return;
		if (node.nodeType === 1 && node.tagName === "IFRAME") {
			try {
				add(node.contentWindow);
				visit(node.contentDocument?.documentElement);
			} catch (_) {}
		}
		try {
			node.querySelectorAll?.("iframe")?.forEach((fr) => visit(fr));
		} catch (_) {}
		if (node.shadowRoot) visit(node.shadowRoot);
	};
	try {
		visit(panel?.getElement?.());
		visit(panel?.element);
		visit(panel?.getDomRoot?.());
	} catch (_) {}
	add(typeof window !== "undefined" ? window : null);
	return wins;
}

/** True if `win` is the main page hosting `panel.getElement()`, or any same-origin iframe under that subtree. */
function selectionWindowBelongsToEditorPanel(panel, win) {
	if (!panel || !win) return false;
	const main = typeof window !== "undefined" ? window : null;
	try {
		const host = panel.getElement?.();
		if (!host) return win === main;
		if (host.tagName === "IFRAME") {
			if (host.contentWindow === win) return true;
			try {
				const inner = host.contentDocument?.querySelectorAll?.("iframe");
				if (inner) {
					for (const fr of inner) {
						try {
							if (fr.contentWindow === win) return true;
						} catch (_) {}
					}
				}
			} catch (_) {}
			return false;
		}
		const hostWin = host.ownerDocument?.defaultView;
		if (hostWin && win === hostWin) return true;
		if (win === main && host.ownerDocument === main?.document) return true;
		const visit = (node) => {
			if (!node) return false;
			if (node.nodeType === 1 && node.tagName === "IFRAME") {
				try {
					if (node.contentWindow === win) return true;
					if (visit(node.contentDocument?.documentElement)) return true;
				} catch (_) {}
			}
			try {
				const iframes = node.querySelectorAll?.("iframe");
				if (iframes) {
					for (const fr of iframes) {
						if (visit(fr)) return true;
					}
				}
			} catch (_) {}
			if (node.shadowRoot && visit(node.shadowRoot)) return true;
			return false;
		};
		return visit(host);
	} catch (_) {
		return false;
	}
}

/** Selection API for the editor surface: any same-origin iframe `window` under the panel may hold the real Selection. */
function getEditorDomSelection(panel) {
	if (typeof document === "undefined") return null;
	const roots =
		panel?.getType?.() === PANEL_TYPE_EDITOR && panel ? collectPanelDomRoots(panel) : [];
	const wins = collectEditorWindowsInPriorityOrder(panel);
	let fallbackCollapsed = null;
	for (const w of wins) {
		let sel;
		try {
			sel = w.getSelection?.();
		} catch (_) {
			continue;
		}
		if (!sel?.rangeCount) continue;
		const rr = sel.getRangeAt(0);
		if (!roots.length) {
			if (!rr.collapsed) return sel;
			fallbackCollapsed = fallbackCollapsed || sel;
			continue;
		}
		const touches =
			selectionLikelyInEditorRoots(sel, roots) || roots.some((r) => selectionTouchesEditorRoot(sel, r));
		const anchored = !rr.collapsed && rangeAnchoredInEditorRoots(rr, panel);
		if (!rr.collapsed && (touches || anchored)) return sel;
		if (rr.collapsed && touches) fallbackCollapsed = fallbackCollapsed || sel;
	}
	/* Prefer non‑collapsed selections only from windows that actually host this panel (avoids random iframes). */
	for (const w of wins) {
		if (!selectionWindowBelongsToEditorPanel(panel, w)) continue;
		try {
			const s = w.getSelection?.();
			if (!s?.rangeCount || s.getRangeAt(0).collapsed) continue;
			const rr = s.getRangeAt(0);
			const touches =
				selectionLikelyInEditorRoots(s, roots) || roots.some((r) => selectionTouchesEditorRoot(s, r));
			if (touches || rangeAnchoredInEditorRoots(rr, panel)) return s;
		} catch (_) {}
	}
	for (const w of wins) {
		if (!selectionWindowBelongsToEditorPanel(panel, w)) continue;
		try {
			const s = w.getSelection?.();
			if (s?.rangeCount && !s.getRangeAt(0).collapsed) return s;
		} catch (_) {}
	}
	return fallbackCollapsed ?? document.getSelection?.() ?? null;
}

function detachIframeSelectionListener(plugin) {
	if (!plugin) return;
	if (plugin._iframeSelLoadCleanup) {
		try {
			plugin._iframeSelLoadCleanup();
		} catch (_) {}
		plugin._iframeSelLoadCleanup = null;
	}
	if (plugin._editorSelDocAttachments?.length) {
		for (const { doc, handler } of plugin._editorSelDocAttachments) {
			try {
				doc.removeEventListener("selectionchange", handler, true);
			} catch (_) {}
		}
		plugin._editorSelDocAttachments = [];
	}
	if (plugin._iframeSelDocAttached && plugin._iframeSelHandler) {
		try {
			plugin._iframeSelDocAttached.removeEventListener("selectionchange", plugin._iframeSelHandler, true);
		} catch (_) {}
	}
	plugin._iframeSelDocAttached = null;
	plugin._iframeSelHandler = null;
}

/**
 * `selectionchange` on the root `document` does not fire for selections inside nested iframes.
 * Attach on `host.ownerDocument` and every reachable same-origin iframe document under the panel.
 */
function ensureEditorDocumentSelectionListeners(plugin, panel) {
	if (typeof document === "undefined" || !plugin) return;
	detachIframeSelectionListener(plugin);
	const handler = () => plugin._boundSelSelectionChange?.();
	if (!panel || panel.getType?.() !== PANEL_TYPE_EDITOR) {
		plugin._editorSelDocAttachments = [];
		try {
			document.addEventListener("selectionchange", handler, true);
			plugin._editorSelDocAttachments.push({ doc: document, handler });
		} catch (_) {}
		return;
	}
	const docs = [];
	const seen = new Set();
	const add = (d) => {
		if (d && typeof d.addEventListener === "function" && !seen.has(d)) {
			seen.add(d);
			docs.push(d);
		}
	};
	const visit = (node) => {
		if (!node) return;
		if (node.nodeType === 1 && node.tagName === "IFRAME") {
			try {
				const d = node.contentDocument;
				if (d) {
					add(d);
					visit(d.documentElement);
				} else {
					const prev = node._thymerHighlighterOnSelDocLoad;
					if (prev) {
						try {
							node.removeEventListener("load", prev);
						} catch (_) {}
					}
					const onLoad = () => {
						node._thymerHighlighterOnSelDocLoad = null;
						try {
							node.removeEventListener("load", onLoad);
						} catch (_) {}
						ensureEditorDocumentSelectionListeners(plugin, panel);
					};
					node._thymerHighlighterOnSelDocLoad = onLoad;
					try {
						node.addEventListener("load", onLoad);
					} catch (_) {}
				}
			} catch (_) {}
		}
		try {
			node.querySelectorAll?.("iframe")?.forEach((fr) => visit(fr));
		} catch (_) {}
		if (node.shadowRoot) visit(node.shadowRoot);
	};
	try {
		const host = panel.getElement?.();
		if (host?.ownerDocument) add(host.ownerDocument);
		visit(host);
	} catch (_) {}
	if (!docs.length) add(document);
	plugin._editorSelDocAttachments = [];
	for (const doc of docs) {
		try {
			doc.addEventListener("selectionchange", handler, true);
			plugin._editorSelDocAttachments.push({ doc, handler });
		} catch (_) {}
	}
}

function domNodeLooksSelected(n) {
	if (!n) return false;
	if (n.getAttribute?.("aria-selected") === "true") return true;
	const ds = n.getAttribute?.("data-selected");
	if (ds === "true" || ds === "1") return true;
	const cn = (n.getAttribute?.("class") || "").trim();
	if (!cn) return false;
	const tokens = cn.split(/\s+/);
	return (
		tokens.includes("selected") ||
		tokens.includes("is-selected") ||
		tokens.includes("selection-active")
	);
}

/** Thymer may mark selection only on a wrapper; walk ancestors for each line row. */
function gatherDomLineGuidsByAncestorSelection(panelEl, validGuids) {
	const out = new Set();
	if (!panelEl?.querySelectorAll || !validGuids?.size) return out;
	for (const attr of ["data-line-item-id", "data-lineitem-id", "data-line-item-guid", "data-item-id"]) {
		try {
			panelEl.querySelectorAll(`[${attr}]`).forEach((el) => {
				const g = el.getAttribute(attr);
				if (!g || !validGuids.has(g)) return;
				let n = el;
				for (let d = 0; d < 16 && n; d++, n = n.parentElement) {
					if (domNodeLooksSelected(n)) {
						out.add(g);
						return;
					}
				}
			});
		} catch (_) {}
	}
	return out;
}

function tryRecordApiSelectedGuids(record, valid) {
	if (!record || !valid?.size) return null;
	for (const key of [
		"getSelectedLineItemGuids",
		"getSelectedLineGuids",
		"getSelectedLineItemIds",
		"getSelectedLineItems",
	]) {
		const fn = record[key];
		if (typeof fn !== "function") continue;
		try {
			const r = fn.call(record);
			const xs = Array.isArray(r)
				? r
				: r != null && typeof r[Symbol.iterator] === "function" && typeof r === "object"
					? [...r]
					: r == null
						? []
						: [r];
			const out = new Set();
			for (const x of xs) {
				const g =
					typeof x === "string" && looksLikeUuid(x)
						? x.trim()
						: x && typeof x === "object" && looksLikeUuid(String(x.guid || ""))
							? String(x.guid).trim()
							: null;
				if (g && valid.has(g)) out.add(g);
			}
			if (out.size) return out;
		} catch (_) {}
	}
	return null;
}

function tryUiApiSelectedGuids(ui, valid) {
	if (!ui || !valid?.size) return null;
	for (const key of ["getSelectedLineItemGuids", "getSelectedLineGuids"]) {
		const fn = ui[key];
		if (typeof fn !== "function") continue;
		try {
			const r = fn.call(ui);
			const xs = Array.isArray(r)
				? r
				: r != null && typeof r[Symbol.iterator] === "function" && typeof r === "object"
					? [...r]
					: r == null
						? []
						: [r];
			const out = new Set();
			for (const x of xs) {
				const g =
					typeof x === "string" && looksLikeUuid(x)
						? x.trim()
						: x && typeof x === "object" && looksLikeUuid(String(x.guid || ""))
							? String(x.guid).trim()
							: null;
				if (g && valid.has(g)) out.add(g);
			}
			if (out.size) return out;
		} catch (_) {}
	}
	return null;
}

function selectedGuidsFromLineItemFlags(items, valid) {
	const out = new Set();
	for (const it of items) {
		const g = it?.guid;
		if (!g || !valid.has(g)) continue;
		if (it.selected === true || it.isSelected === true) out.add(g);
		try {
			if (it.selection?.selected === true) out.add(g);
		} catch (_) {}
	}
	return out.size ? out : null;
}

function tryRecordFocusedLineGuid(record, valid) {
	if (!record || !valid?.size) return null;
	for (const key of ["getFocusedLineItemGuid", "getFocusedLineItem", "getActiveLineItem"]) {
		const fn = record[key];
		if (typeof fn !== "function") continue;
		try {
			const r = fn.call(record);
			const g =
				typeof r === "string" && looksLikeUuid(r)
					? r.trim()
					: r && typeof r === "object" && looksLikeUuid(String(r.guid || ""))
						? String(r.guid).trim()
						: null;
			if (g && valid.has(g)) return new Set([g]);
		} catch (_) {}
	}
	return null;
}

function tryExtractSelectionGuidsFromLineEvent(ev) {
	const out = new Set();
	const walk = (v, depth) => {
		if (v == null || depth > 14) return;
		if (typeof v === "string") {
			if (looksLikeUuid(v)) out.add(v.trim());
			return;
		}
		if (Array.isArray(v)) {
			for (const x of v) walk(x, depth + 1);
			return;
		}
		if (typeof v !== "object") return;
		for (const [k, val] of Object.entries(v)) {
			const kl = k.toLowerCase();
			if (
				kl.includes("select") ||
				kl.includes("lineitem") ||
				kl.includes("line") ||
				kl.endsWith("guids") ||
				kl === "guids"
			) {
				walk(val, depth + 1);
			}
		}
	};
	try {
		walk(ev?.selection, 0);
		walk(ev?.payload, 0);
		walk(ev?.detail, 0);
	} catch (_) {}
	return out;
}

function tryPanelApiSelectedGuids(panel, valid) {
	for (const key of ["getSelectedLineItemGuids", "getSelectedLineGuids", "getSelectedLineItemIds"]) {
		const fn = panel?.[key];
		if (typeof fn !== "function") continue;
		try {
			const r = fn.call(panel);
			const xs = Array.isArray(r)
				? r
				: r != null && typeof r[Symbol.iterator] === "function" && typeof r === "object"
					? [...r]
					: r == null
						? []
						: [r];
			const out = new Set();
			for (const x of xs) {
				const g =
					typeof x === "string" && looksLikeUuid(x)
						? x.trim()
						: x && typeof x === "object" && looksLikeUuid(String(x.guid || ""))
							? String(x.guid).trim()
							: null;
				if (g && valid.has(g)) out.add(g);
			}
			if (out.size) return out;
		} catch (_) {}
	}
	return null;
}

/**
 * Clone and retain the last non‑collapsed text range. The live Selection often collapses before
 * `await record.getLineItems()` returns (palette focus, etc.), so capture must fall back to this.
 */
function rememberFrozenTextSelectionRange(plugin, panel) {
	if (!plugin || typeof document === "undefined") return;
	const wins = collectEditorWindowsInPriorityOrder(panel);
	const tryFreeze = (w) => {
		if (!w) return false;
		let sel;
		try {
			sel = w.getSelection?.();
		} catch (_) {
			return false;
		}
		if (!sel?.rangeCount) return false;
		const r = sel.getRangeAt(0);
		if (r.collapsed) return false;
		try {
			const clone = r.cloneRange();
			plugin._frozenTextSelection = { range: clone, t: Date.now() };
			const u = getRangeClientRectUnion(clone);
			if (u && (u.maxX > u.minX || u.maxY > u.minY)) {
				plugin._lastNonCollapsedSelectionUnion = {
					minX: u.minX,
					minY: u.minY,
					maxX: u.maxX,
					maxY: u.maxY,
					t: Date.now(),
				};
			}
			return true;
		} catch (_) {
			return false;
		}
	};
	for (const w of wins) {
		if (!selectionWindowBelongsToEditorPanel(panel, w)) continue;
		if (tryFreeze(w)) return;
	}
	for (const w of wins) {
		if (tryFreeze(w)) return;
	}
}

/**
 * Updates the persistent “last highlighted text” line set (non-collapsed DOM selection only).
 * Opening the palette often collapses the selection; we do not clear this cache on collapse.
 */
async function captureTextSelectionLinesForCommands(plugin, panel) {
	if (!plugin || !panel || panel.getType?.() !== PANEL_TYPE_EDITOR) {
		return;
	}
	if (typeof document === "undefined") {
		return;
	}
	const sel = getEditorDomSelection(panel);
	if (!sel?.rangeCount) {
		return;
	}
	const liveRange = sel.getRangeAt(0);
	const frozenRef = plugin._frozenTextSelection;
	let rangeSnap = null;
	if (!liveRange.collapsed) {
		try {
			rangeSnap = liveRange.cloneRange();
			try {
				plugin._frozenTextSelection = { range: rangeSnap.cloneRange(), t: Date.now() };
			} catch (_) {}
		} catch (_) {
			return;
		}
	} else if (frozenRef && Date.now() - frozenRef.t < FROZEN_TEXT_SELECTION_MS) {
		try {
			rangeSnap = frozenRef.range.cloneRange();
		} catch (_) {
			return;
		}
	}
	let unionSnap = rangeSnap ? getRangeClientRectUnion(rangeSnap) : null;
	if (!unionSnap) {
		const stU = plugin._lastNonCollapsedSelectionUnion;
		if (
			stU &&
			Date.now() - stU.t < FROZEN_TEXT_SELECTION_MS &&
			(stU.maxX > stU.minX || stU.maxY > stU.minY)
		) {
			unionSnap = { minX: stU.minX, minY: stU.minY, maxX: stU.maxX, maxY: stU.maxY };
		}
	}
	let bandY0 = null;
	let bandY1 = null;
	if (!rangeSnap && !unionSnap) {
		const b = plugin._lastVerticalSelectBand;
		if (
			b &&
			Date.now() - b.t < VERTICAL_SELECT_BAND_MS &&
			typeof b.yTop === "number" &&
			typeof b.yBot === "number"
		) {
			bandY0 = Math.min(b.yTop, b.yBot);
			bandY1 = Math.max(b.yTop, b.yBot);
		}
	}
	if (!rangeSnap && !unionSnap && (bandY0 == null || bandY1 == null)) {
		return;
	}
	const roots = collectPanelDomRoots(panel);
	const record = panel.getActiveRecord?.();
	if (!record) {
		return;
	}
	let items;
	try {
		items = await record.getLineItems(false);
	} catch (_) {
		return;
	}
	if (!items?.length) {
		return;
	}
	const valid = new Set(items.map((it) => it.guid));
	let allowCapture =
		(rangeSnap && rangeLikelyInEditorRoots(rangeSnap, roots)) ||
		(!liveRange.collapsed && selectionLikelyInEditorRoots(sel, roots)) ||
		(unionSnap && clientUnionIntersectsAnyRoot(unionSnap, roots)) ||
		(bandY0 != null && bandY1 != null);
	if (!allowCapture && rangeSnap) {
		const probe = new Set();
		for (const g of guidsFromAncestorsDeep(rangeSnap.startContainer, valid)) probe.add(g);
		for (const g of guidsFromAncestorsDeep(rangeSnap.endContainer, valid)) probe.add(g);
		if (probe.size) allowCapture = true;
	}
	if (!allowCapture && rangeSnap) {
		const uProbe = getRangeClientRectUnion(rangeSnap);
		const nRect = Array.from(rangeSnap.getClientRects()).filter((cr) => cr.width > 0 || cr.height > 0)
			.length;
		const dy = uProbe ? uProbe.maxY - uProbe.minY : 0;
		if (uProbe && (dy >= 5 || nRect >= 2)) allowCapture = true;
	}
	try {
		if (!allowCapture && rangeSnap && !rangeSnap.collapsed) allowCapture = true;
	} catch (_) {}
	if (!allowCapture) {
		return;
	}
	const merged = new Set();
	if (bandY0 != null && bandY1 != null) {
		for (const root of roots) {
			for (const g of lineGuidsInVerticalBand(root, valid, bandY0, bandY1)) merged.add(g);
		}
	}
	if (unionSnap) {
		for (const root of roots) {
			for (const g of lineGuidsFromPanelUnionOverlap(root, valid, unionSnap)) merged.add(g);
		}
		for (const g of lineGuidsFromItemsIntersectingClientUnion(items, valid, roots, unionSnap)) merged.add(g);
	}
	if (rangeSnap) {
		for (const g of guidsFromAncestorsDeep(rangeSnap.startContainer, valid)) merged.add(g);
		for (const g of guidsFromAncestorsDeep(rangeSnap.endContainer, valid)) merged.add(g);
		for (const g of lineGuidsFromDomTextSelectionRange(rangeSnap, valid, items)) merged.add(g);
		for (const g of lineGuidsFromRangePointSamplingRange(rangeSnap, valid)) merged.add(g);
		for (const g of lineGuidsFromVerticalStackSweepRange(rangeSnap, valid, roots)) merged.add(g);
	}

	const rectsRows = rangeSnap
		? Array.from(rangeSnap.getClientRects()).filter((cr) => cr.width >= 0 && cr.height >= 0)
		: [];
	for (let ri = 0; ri < Math.min(rectsRows.length, 48); ri++) {
		const cr = rectsRows[ri];
		if (cr.width === 0 && cr.height === 0) continue;
		const cx = cr.left + Math.max(1, Math.min(cr.width * 0.5, cr.width - 0.5));
		const cy = cr.top + Math.max(1, Math.min(cr.height * 0.5, cr.height - 0.5));
		const hit = hitElementFromClientPointForLineGuids(cx, cy, panel, rangeSnap, valid);
		if (hit?.el) {
			for (const g of guidsFromAncestorsDeep(hit.el, valid)) merged.add(g);
		}
	}

	if (!merged.size && rangeSnap) {
		for (const g of guidsFromAncestorsDeep(rangeSnap.commonAncestorContainer, valid)) merged.add(g);
		if (!merged.size) {
			const g0 = domWalkLineGuid(rangeSnap.startContainer, valid);
			const g1 = domWalkLineGuid(rangeSnap.endContainer, valid);
			if (g0) merged.add(g0);
			if (g1) merged.add(g1);
		}
	}

	let uBand = unionSnap || (rangeSnap ? getRangeClientRectUnion(rangeSnap) : null);
	if (!uBand && bandY0 != null && bandY1 != null) {
		uBand = { minX: -1e6, minY: bandY0, maxX: 1e6, maxY: bandY1 };
	}
	const ySpan = uBand ? uBand.maxY - uBand.minY : 0;
	const runVerticalBand =
		uBand &&
		(ySpan >= 3 ||
			rectsRows.length >= 2 ||
			merged.size <= 1 ||
			(bandY0 != null && bandY1 != null && Math.abs(bandY1 - bandY0) >= 2));
	if (runVerticalBand && uBand) {
		for (const root of roots) {
			for (const g of lineGuidsInVerticalBand(root, valid, uBand.minY, uBand.maxY)) merged.add(g);
		}
	}
	let idxs = [...merged].map((g) => items.findIndex((it) => it.guid === g)).filter((i) => i >= 0);
	if (idxs.length >= 2) {
		const lo = Math.min(...idxs);
		const hi = Math.max(...idxs);
		for (let k = lo; k <= hi; k++) merged.add(items[k].guid);
	}
	if (merged.size) {
		plugin._lastTextSelectionLineGuids = merged;
	}
	if (unionSnap && (unionSnap.maxX > unionSnap.minX || unionSnap.maxY > unionSnap.minY)) {
		plugin._lastNonCollapsedSelectionUnion = {
			minX: unionSnap.minX,
			minY: unionSnap.minY,
			maxX: unionSnap.maxX,
			maxY: unionSnap.maxY,
			t: Date.now(),
		};
	}
}

/**
 * Best-effort: current selection (cached), event cache, record/ui APIs, line-item flags, panel APIs, navigation, DOM, caret.
 * @returns {Set<string>|null} null if nothing detected
 */
function getSelectedLineItemGuidSet(panel, items, plugin, record) {
	if (!panel || !items?.length) {
		return null;
	}
	const valid = new Set(items.map((it) => it.guid));

	const unionCaches = new Set();
	for (const g of plugin?._lastTextSelectionLineGuids || []) {
		if (valid.has(g)) unionCaches.add(g);
	}
	for (const g of plugin?._recentSelectionGuidsFromEvents || []) {
		if (valid.has(g)) unionCaches.add(g);
	}
	const storedU = plugin?._lastNonCollapsedSelectionUnion;
	if (
		storedU &&
		Date.now() - storedU.t < 120000 &&
		(storedU.maxX > storedU.minX || storedU.maxY > storedU.minY)
	) {
		const u = { minX: storedU.minX, minY: storedU.minY, maxX: storedU.maxX, maxY: storedU.maxY };
		const roots = collectPanelDomRoots(panel);
		for (const g of lineGuidsFromItemsIntersectingClientUnion(items, valid, roots, u)) unionCaches.add(g);
		const ys = u.maxY - u.minY;
		if (ys >= 4) {
			for (const root of roots) {
				for (const g of lineGuidsInVerticalBand(root, valid, u.minY, u.maxY)) unionCaches.add(g);
			}
		}
	}
	const ixUnion = [...unionCaches].map((g) => items.findIndex((it) => it.guid === g)).filter((i) => i >= 0);
	if (ixUnion.length >= 2) {
		const lo = Math.min(...ixUnion);
		const hi = Math.max(...ixUnion);
		for (let k = lo; k <= hi; k++) unionCaches.add(items[k].guid);
	}
	if (unionCaches.size) {
		return unionCaches;
	}

	const fromRecord = tryRecordApiSelectedGuids(record, valid);
	if (fromRecord?.size && !singleGuidApiLikelyWrongForMultiline(plugin, fromRecord)) {
		return fromRecord;
	}

	const fromUi = tryUiApiSelectedGuids(plugin?.ui, valid);
	if (fromUi?.size && !singleGuidApiLikelyWrongForMultiline(plugin, fromUi)) {
		return fromUi;
	}

	const fromFlags = selectedGuidsFromLineItemFlags(items, valid);
	if (fromFlags?.size && !singleGuidApiLikelyWrongForMultiline(plugin, fromFlags)) {
		return fromFlags;
	}

	const api = tryPanelApiSelectedGuids(panel, valid);
	if (api?.size && !singleGuidApiLikelyWrongForMultiline(plugin, api)) {
		return api;
	}

	const fromNav = new Set();
	try {
		walkNavForGuids(panel.getNavigation?.(), fromNav, 0);
	} catch (_) {}
	const navHits = new Set([...fromNav].filter((g) => valid.has(g)));
	if (navHits.size) {
		return navHits;
	}

	const domHits = new Set();
	for (const root of collectPanelDomRoots(panel)) {
		for (const g of gatherDomSelectedLineGuids(root, valid)) domHits.add(g);
		for (const g of gatherDomLineGuidsByAncestorSelection(root, valid)) domHits.add(g);
	}
	if (domHits.size) {
		return domHits;
	}

	for (const root of collectPanelDomRoots(panel)) {
		for (const g of gatherFocusedLineGuidsInPanel(root, valid)) domHits.add(g);
	}
	if (domHits.size) {
		return domHits;
	}

	const focused = tryRecordFocusedLineGuid(record, valid);
	if (focused?.size) {
		return focused;
	}

	return null;
}

class Plugin extends AppPlugin {
	onLoad() {
		this._skipHighlightOnce = new Set();
		this._markerRestoreSkipClearTimeouts = [];
		this._recordHighlightIndexTimers = new Map();
		this._globalHighlightGuidsFn = null;
		this._recentSelectionGuidsFromEvents = new Set();
		this._lastTextSelectionLineGuids = new Set();
		this._frozenTextSelection = null;
		this._lastNonCollapsedSelectionUnion = null;
		this._lastVerticalSelectBand = null;
		this._selectionGuidsFromEventClearT = 0;
		this._highlightDetectionEnabled = readHighlightDetectionEnabled(this);
		injectHighlightStyles(this.ui);
		const opts = { collection: "*" };
		const onLine = (ev) => {
			void this._applyHighlights(ev);
		};
		this._handlerCreated = this.events.on("lineitem.created", onLine, opts);
		this._handlerUpdated = this.events.on("lineitem.updated", onLine, opts);

		this._cmdUnwrapPlainSel = this.ui.addCommandPaletteCommand({
			label: "Highlighter: Selection: plain text (strip == highlight links)",
			icon: "eraser",
			onSelected: () => {
				void this._unwrapHighlightsInActiveNote("plain", "selection");
			},
		});
		this._cmdRestoreMarkersAllWorkspace = this.ui.addCommandPaletteCommand({
			label: "Highlighter: All notes: literal ==…== for Markdown export",
			icon: "refresh",
			onSelected: () => {
				void this._restoreMarkersInAllWorkspaceRecords();
			},
		});
		this._cmdRebuildHighlightRecordIndex = this.ui.addCommandPaletteCommand({
			label: "Highlighter: Rebuild local index of notes with highlight links",
			icon: "list",
			onSelected: () => {
				void this._rebuildWorkspaceHighlightRecordIndex();
			},
		});
		this._cmdUnwrapMarkersWhole = this.ui.addCommandPaletteCommand({
			label: "Highlighter: This note: literal ==…== for Markdown export",
			icon: "refresh",
			onSelected: () => {
				void this._unwrapHighlightsInActiveNote("markers", "whole");
			},
		});
		this._cmdUnwrapPlainWhole = this.ui.addCommandPaletteCommand({
			label: "Highlighter: This note: plain text (strip == highlight links)",
			icon: "eraser",
			onSelected: () => {
				void this._unwrapHighlightsInActiveNote("plain", "whole");
			},
		});
		this._cmdDisableHighlightDetection = this.ui.addCommandPaletteCommand({
			label: "Highlighter: Disable ==…== → highlight auto-convert",
			icon: "ban",
			onSelected: () => {
				if (!this._highlightDetectionEnabled) {
					this.ui.addToaster({
						title: "Highlighter",
						message: "== highlight auto-detection is already off.",
						dismissible: true,
						autoDestroyTime: 4500,
					});
					return;
				}
				this._highlightDetectionEnabled = false;
				persistHighlightDetectionEnabled(this, false);
				this.ui.addToaster({
					title: "Highlighter",
					message:
						"== highlight auto-detection is off. Existing highlights stay; new == won't convert until you turn it back on.",
					dismissible: true,
					autoDestroyTime: 6500,
				});
			},
		});
		this._cmdEnableHighlightDetection = this.ui.addCommandPaletteCommand({
			label: "Highlighter: Enable ==…== → highlight auto-convert",
			icon: "highlight",
			onSelected: () => {
				if (this._highlightDetectionEnabled) {
					this.ui.addToaster({
						title: "Highlighter",
						message: "== highlight auto-detection is already on.",
						dismissible: true,
						autoDestroyTime: 4500,
					});
					return;
				}
				this._highlightDetectionEnabled = true;
				persistHighlightDetectionEnabled(this, true);
				const panel = getEditorPanelForSelection(this.ui) ?? this.ui.getActivePanel();
				void this._scanRecordLineItemsForHighlights(panel);
				this.ui.addToaster({
					title: "Highlighter",
					message: "== highlight auto-detection is on. The open note was rescanned.",
					dismissible: true,
					autoDestroyTime: 5500,
				});
			},
		});
		this._cmdUnwrapMarkersSel = this.ui.addCommandPaletteCommand({
			label: "Highlighter: Selection: literal ==…== for Markdown export",
			icon: "refresh",
			onSelected: () => {
				void this._unwrapHighlightsInActiveNote("markers", "selection");
			},
		});

		const onPanel = (ev) => {
			const panel = ev.panel;
			ensureEditorDocumentSelectionListeners(this, panel);
			setTimeout(() => {
				void this._scanRecordLineItemsForHighlights(panel);
				ensureEditorDocumentSelectionListeners(this, panel);
			}, 0);
		};
		this._handlerPanelNavigated = this.events.on("panel.navigated", onPanel);
		this._handlerPanelFocused = this.events.on("panel.focused", onPanel);
		this._handlerReload = this.events.on("reload", () => {
			this._highlightDetectionEnabled = readHighlightDetectionEnabled(this);
			this._lastTextSelectionLineGuids = new Set();
			this._frozenTextSelection = null;
			this._lastNonCollapsedSelectionUnion = null;
			this._lastVerticalSelectBand = null;
			setTimeout(() => {
				const panel = getEditorPanelForSelection(this.ui) ?? this.ui.getActivePanel();
				ensureEditorDocumentSelectionListeners(this, panel);
				void this._scanRecordLineItemsForHighlights(panel);
			}, 0);
		});

		this._selSnapRaf = 0;
		this._bandSelectY0 = null;
		this._lastLineValidForSelection = null;
		this._lastLineItemsForSelection = null;
		this._lastPointerInEditor = null;
		this._boundSelPointerDown = (ev) => {
			const panel = getEditorPanelForSelection(this.ui);
			if (!panel || !eventTargetInEditorPanel(panel, ev)) return;
			this._bandSelectY0 = ev.clientY;
		};
		this._boundSelPointerUp = (ev) => {
			const panel = getEditorPanelForSelection(this.ui);
			if (!panel) return;
			const startedInEditor = this._bandSelectY0 != null;
			if (!startedInEditor && !eventTargetInEditorPanel(panel, ev)) return;
			this._lastPointerInEditor = { x: ev.clientX, y: ev.clientY, t: Date.now() };
			const y0 = this._bandSelectY0;
			this._bandSelectY0 = null;
			rememberFrozenTextSelectionRange(this, panel);
			let yTop = y0;
			let yBot = ev.clientY;
			if (y0 != null && typeof ev.clientY === "number") {
				if (Math.abs(yTop - yBot) < 8) {
					yTop -= 6;
					yBot += 6;
				}
				this._lastVerticalSelectBand = { yTop, yBot, t: Date.now() };
			}
			void (async () => {
				await captureTextSelectionLinesForCommands(this, panel);
				await snapshotEditorSelectionInto(this, panel);
				const valid = this._lastLineValidForSelection;
				if (valid?.size && y0 != null && typeof ev.clientY === "number") {
					const roots = collectPanelDomRoots(panel);
					for (const root of roots) {
						for (const g of lineGuidsInVerticalBand(root, valid, yTop, yBot)) {
							this._recentSelectionGuidsFromEvents.add(g);
						}
					}
				}
			})();
		};
		this._boundSelSelectionChange = () => {
			if (typeof document === "undefined") return;
			const panel = getEditorPanelForSelection(this.ui);
			if (!panel) return;
			rememberFrozenTextSelectionRange(this, panel);
			const sel = getEditorDomSelection(panel);
			if (!sel?.rangeCount) return;
			const range = sel.getRangeAt(0);
			let rangeSnap = null;
			if (!range.collapsed) {
				try {
					rangeSnap = range.cloneRange();
					const u = getRangeClientRectUnion(rangeSnap);
					if (u && (u.maxX > u.minX || u.maxY > u.minY)) {
						this._lastNonCollapsedSelectionUnion = {
							minX: u.minX,
							minY: u.minY,
							maxX: u.maxX,
							maxY: u.maxY,
							t: Date.now(),
						};
					}
				} catch (_) {}
			}
			void (async () => {
				await captureTextSelectionLinesForCommands(this, panel);
				this._scheduleSelectionSnapshot();
			})();
		};
		if (typeof window !== "undefined") {
			window.addEventListener("pointerdown", this._boundSelPointerDown, true);
			window.addEventListener("pointerup", this._boundSelPointerUp, true);
		}
		setTimeout(() => {
			const panel = getEditorPanelForSelection(this.ui) ?? this.ui.getActivePanel();
			ensureEditorDocumentSelectionListeners(this, panel);
		}, 0);

		this._globalHighlightGuidsFn = () => getWorkspaceHighlightRecordGuids(this);
		if (typeof globalThis !== "undefined") {
			globalThis.thymerHighlighterGetHighlightRecordGuids = this._globalHighlightGuidsFn;
		}
	}

	onUnload() {
		if (this._handlerCreated) this.events.off(this._handlerCreated);
		if (this._handlerUpdated) this.events.off(this._handlerUpdated);
		if (this._handlerPanelNavigated) this.events.off(this._handlerPanelNavigated);
		if (this._handlerPanelFocused) this.events.off(this._handlerPanelFocused);
		if (this._handlerReload) this.events.off(this._handlerReload);
		this._cmdUnwrapPlainSel?.remove();
		this._cmdRestoreMarkersAllWorkspace?.remove();
		this._cmdRebuildHighlightRecordIndex?.remove();
		this._cmdUnwrapMarkersWhole?.remove();
		this._cmdUnwrapPlainWhole?.remove();
		this._cmdDisableHighlightDetection?.remove();
		this._cmdEnableHighlightDetection?.remove();
		this._cmdUnwrapMarkersSel?.remove();
		for (const tid of this._markerRestoreSkipClearTimeouts || []) clearTimeout(tid);
		this._markerRestoreSkipClearTimeouts = [];
		clearTimeout(this._selectionGuidsFromEventClearT);
		if (typeof window !== "undefined") {
			if (this._boundSelPointerDown) {
				window.removeEventListener("pointerdown", this._boundSelPointerDown, true);
			}
			if (this._boundSelPointerUp) {
				window.removeEventListener("pointerup", this._boundSelPointerUp, true);
			}
		}
		detachIframeSelectionListener(this);
		if (this._selSnapRaf) cancelAnimationFrame(this._selSnapRaf);
		for (const tid of this._recordHighlightIndexTimers?.values() ?? []) clearTimeout(tid);
		this._recordHighlightIndexTimers?.clear();
		if (typeof globalThis !== "undefined" && this._globalHighlightGuidsFn) {
			if (globalThis.thymerHighlighterGetHighlightRecordGuids === this._globalHighlightGuidsFn) {
				delete globalThis.thymerHighlighterGetHighlightRecordGuids;
			}
		}
		this._globalHighlightGuidsFn = null;
	}

	_scheduleRecordHighlightIndexUpdate(record) {
		if (!record) return;
		let rg = "";
		try {
			rg = String(record.getGuid?.() ?? record.guid ?? "").trim();
		} catch (_) {}
		if (!rg) return;
		const prev = this._recordHighlightIndexTimers.get(rg);
		if (prev) clearTimeout(prev);
		const tid = setTimeout(() => {
			this._recordHighlightIndexTimers.delete(rg);
			void recomputeAndStoreRecordHighlightFlag(this, record);
		}, RECORD_HIGHLIGHT_INDEX_DEBOUNCE_MS);
		this._recordHighlightIndexTimers.set(rg, tid);
	}

	/** Rescan every workspace note and refresh {@link LS_KEY_RECORDS_WITH_HIGHLIGHTS} for this browser. */
	async _rebuildWorkspaceHighlightRecordIndex() {
		let records;
		try {
			records = this.data.getAllRecords?.();
		} catch (_) {
			this.ui.addToaster({
				title: "Highlighter",
				message: "Could not read workspace notes.",
				dismissible: true,
				autoDestroyTime: 5000,
			});
			return;
		}
		if (!records?.length) {
			this.ui.addToaster({
				title: "Highlighter",
				message: "No notes found in this workspace.",
				dismissible: true,
				autoDestroyTime: 5000,
			});
			return;
		}
		let withHits = 0;
		for (const record of records) {
			try {
				if (await recomputeAndStoreRecordHighlightFlag(this, record)) withHits++;
			} catch (_) {}
		}
		this.ui.addToaster({
			title: "Highlighter — index rebuilt",
			message: `${records.length} note(s) scanned. ${withHits} note(s) listed as containing highlight links (browser-local; see README).`,
			dismissible: true,
			autoDestroyTime: 9000,
		});
	}

	_scheduleSelectionSnapshot() {
		const panel = getEditorPanelForSelection(this.ui) ?? this.ui.getActivePanel();
		if (typeof requestAnimationFrame === "undefined") {
			void snapshotEditorSelectionInto(this, panel);
			return;
		}
		if (this._selSnapRaf) cancelAnimationFrame(this._selSnapRaf);
		this._selSnapRaf = requestAnimationFrame(() => {
			this._selSnapRaf = 0;
			const p = getEditorPanelForSelection(this.ui) ?? this.ui.getActivePanel();
			void snapshotEditorSelectionInto(this, p);
		});
	}

	/**
	 * @param {Array<{ guid: string, segments: object }>} targets line items to transform
	 * @param {"plain" | "markers"} mode
	 * @returns {Promise<{ markerGuids: string[] }>}
	 */
	async _unwrapTargetsToMode(targets, mode) {
		const markerGuids = [];
		for (const item of targets) {
			const next = transformSegmentsUnwrap(item.segments, mode);
			if (!next) continue;
			if (mode === "markers") {
				this._skipHighlightOnce.add(item.guid);
				markerGuids.push(item.guid);
			}
			await item.setSegments(next);
		}
		return { markerGuids };
	}

	_scheduleMarkerSkipClear(markerGuids) {
		if (!markerGuids?.length) return;
		const list = markerGuids.slice();
		const tid = setTimeout(() => {
			const arr = this._markerRestoreSkipClearTimeouts;
			const ix = arr.indexOf(tid);
			if (ix !== -1) arr.splice(ix, 1);
			for (const g of list) this._skipHighlightOnce.delete(g);
		}, 220);
		this._markerRestoreSkipClearTimeouts.push(tid);
	}

	/** Every record in the workspace: highlight links → ==markers== (same as per-note “convert to markers”). */
	async _restoreMarkersInAllWorkspaceRecords() {
		let records;
		try {
			records = this.data.getAllRecords?.();
		} catch (_) {
			this.ui.addToaster({
				title: "Highlighter",
				message: "Could not read workspace notes.",
				dismissible: true,
				autoDestroyTime: 5000,
			});
			return;
		}
		if (!records?.length) {
			this.ui.addToaster({
				title: "Highlighter",
				message: "No notes found in this workspace.",
				dismissible: true,
				autoDestroyTime: 5000,
			});
			return;
		}

		const dryRun = readWorkspaceMarkdownExportDryRun();
		const n = records.length;
		this.ui.addToaster({
			title: "Highlighter",
			message: dryRun
				? `Dry-run started: ${n} note(s). No writes — counting lines with == highlight links only. Open the browser console for per-note detail.`
				: `Started: scanning ${n} note(s) for highlight links…`,
			dismissible: true,
			autoDestroyTime: dryRun ? 8000 : 5000,
		});

		if (dryRun) {
			let notesWithHits = 0;
			let linesWithHighlights = 0;
			/** @type {{ noteName: string, noteGuid: string, lineGuids: string[], lineCount: number }[]} */
			const report = [];
			for (const record of records) {
				let noteGuid = "";
				try {
					noteGuid = String(record.getGuid?.() ?? record.guid ?? "").trim();
				} catch (_) {}
				try {
					const items = await record.getLineItems(false);
					const byG = lineItemsByGuidMap(items);
					const hitGuids = [];
					for (const item of items) {
						if (lineItemHasOurHighlightLink(item, byG)) {
							hitGuids.push(item.guid);
							linesWithHighlights++;
						}
					}
					if (noteGuid) setWorkspaceRecordHasHighlightLinks(this, noteGuid, hitGuids.length > 0);
					if (hitGuids.length) {
						notesWithHits++;
						let noteName = "";
						try {
							noteName = record.getName?.() ?? "";
						} catch (_) {}
						report.push({
							noteName: noteName || "(untitled)",
							noteGuid,
							lineGuids: hitGuids,
							lineCount: hitGuids.length,
						});
					}
				} catch (_) {}
			}
			if (typeof console !== "undefined" && console.log) {
				console.log("[Highlighter] workspace Markdown export dry-run", {
					notesScanned: n,
					notesWithHighlightLines: notesWithHits,
					lineItemsWithHighlightLinks: linesWithHighlights,
					perNote: report,
				});
			}
			const sample =
				report.length <= 3
					? report.map((r) => `${r.noteName}: ${r.lineCount} line(s)`).join(" · ")
					: `${report.length} notes (see console for names & line GUIDs)`;
			this.ui.addToaster({
				title: "Highlighter — dry-run done",
				message: `${n} note(s) scanned. ${notesWithHits} note(s) with ${linesWithHighlights} line item(s) containing highlight links. ${sample}`,
				dismissible: true,
				autoDestroyTime: 12000,
			});
			return;
		}

		const allMarkerGuids = [];
		let recordsConverted = 0;
		for (const record of records) {
			try {
				let items = await record.getLineItems(false);
				await applyCrossLineHighlightChains(record, this._skipHighlightOnce, items);
				items = await record.getLineItems(false);
				const byG = lineItemsByGuidMap(items);
				const { markerGuids } = await this._unwrapTargetsToMode(
					items.filter((it) => !lineItemIsNonProseHighlightHost(it, byG)),
					"markers",
				);
				if (markerGuids.length) recordsConverted++;
				for (const g of markerGuids) allMarkerGuids.push(g);
				void recomputeAndStoreRecordHighlightFlag(this, record);
			} catch (_) {}
		}
		this._scheduleMarkerSkipClear(allMarkerGuids);
		const totalReviewed = records.length;
		const reviewedPhrase =
			totalReviewed === 1 ? "Reviewed 1 note." : `Reviewed ${totalReviewed} notes.`;
		const changedPhrase =
			recordsConverted === 0
				? "No highlight links were converted to == markers."
				: recordsConverted === 1
					? "Converted highlight links to == markers in 1 note."
					: `Converted highlight links to == markers in ${recordsConverted} notes.`;
		this.ui.addToaster({
			title: "Highlighter",
			message: `${reviewedPhrase} ${changedPhrase}`,
			dismissible: true,
			autoDestroyTime: 7500,
		});
	}
	/**
	 * @param {"plain" | "markers"} mode
	 * @param {"whole" | "selection"} scope whole = every line; selection = only detected selected line items
	 */
	async _unwrapHighlightsInActiveNote(mode, scope) {
		const active = this.ui.getActivePanel();
		const record = active?.getActiveRecord?.();
		if (!record) {
			return;
		}
		const panel =
			scope === "selection" ? getEditorPanelForSelection(this.ui) ?? active : active;
		if (scope === "selection") {
			rememberFrozenTextSelectionRange(this, panel);
			await captureTextSelectionLinesForCommands(this, panel);
			await snapshotEditorSelectionInto(this, panel);
		}
		let items = await record.getLineItems(false);
		await applyCrossLineHighlightChains(record, this._skipHighlightOnce, items);
		items = await record.getLineItems(false);
		const byG = lineItemsByGuidMap(items);
		const selectedSet = getSelectedLineItemGuidSet(panel, items, this, record);

		if (scope === "selection" && (!selectedSet || !selectedSet.size)) {
			return;
		}

		const targets = (scope === "whole" ? items : items.filter((it) => selectedSet.has(it.guid))).filter(
			(it) => !lineItemIsNonProseHighlightHost(it, byG),
		);

		const { markerGuids } = await this._unwrapTargetsToMode(targets, mode);
		if (mode === "markers" && markerGuids.length) this._scheduleMarkerSkipClear(markerGuids);
		this._scheduleRecordHighlightIndexUpdate(record);
	}

	async _processLineItemHighlight(lineItem, segmentsPreferred, itemsByGuid) {
		if (!lineItem || !this._highlightDetectionEnabled) return;
		if (this._skipHighlightOnce.has(lineItem.guid)) return;
		const byG = itemsByGuid ?? new Map();
		if (lineItemIsNonProseHighlightHost(lineItem, byG)) return;
		let segments = segmentsPreferred ?? lineItem.segments;
		if (!segments || !segments.length) return;

		const synced = syncHighlightSourceTypesWithNeighbors(segments);
		if (synced.changed) {
			await lineItem.setSegments(synced.segments);
			segments = synced.segments;
		}

		if (!mightContainHighlightSyntax(segments)) return;
		const next = transformSegments(segments);
		if (!segmentsDiffer(segments, next)) return;
		await lineItem.setSegments(next);
	}

	async _applyHighlights(ev) {
		const fromEvSel = tryExtractSelectionGuidsFromLineEvent(ev);
		if (fromEvSel.size) {
			this._recentSelectionGuidsFromEvents = fromEvSel;
			clearTimeout(this._selectionGuidsFromEventClearT);
			this._selectionGuidsFromEventClearT = setTimeout(() => {
				this._recentSelectionGuidsFromEvents = new Set();
			}, 4000);
		}

		const record = ev.getRecord();
		let itemsPre = null;
		let itemsByGuid = null;
		if (record) {
			itemsPre = await record.getLineItems(false);
			itemsByGuid = lineItemsByGuidMap(itemsPre);
		}
		if (this._highlightDetectionEnabled && record)
			await applyCrossLineHighlightChains(record, this._skipHighlightOnce, itemsPre ?? undefined);

		const lineItem = await ev.getLineItem();
		if (!lineItem) {
			if (record) this._scheduleRecordHighlightIndexUpdate(record);
			return;
		}

		let segmentsPreferred = null;
		if (!record && ev.eventName === "lineitem.updated" && ev.hasSegments()) {
			const fromEvent = ev.getSegments();
			if (fromEvent) segmentsPreferred = fromEvent;
		}
		await this._processLineItemHighlight(lineItem, segmentsPreferred, itemsByGuid ?? new Map());
		if (record) this._scheduleRecordHighlightIndexUpdate(record);
	}

	async _scanRecordLineItemsForHighlights(panel) {
		if (!this._highlightDetectionEnabled) return;
		if (!panel || panel.getType() !== PANEL_TYPE_EDITOR) return;
		const record = panel.getActiveRecord();
		if (!record) return;
		const items = await record.getLineItems(false);
		await applyCrossLineHighlightChains(record, this._skipHighlightOnce, items);
		const itemsAfter = await record.getLineItems(false);
		const byG = lineItemsByGuidMap(itemsAfter);
		for (const item of itemsAfter) {
			await this._processLineItemHighlight(item, null, byG);
		}
		this._scheduleRecordHighlightIndexUpdate(record);
	}
}
