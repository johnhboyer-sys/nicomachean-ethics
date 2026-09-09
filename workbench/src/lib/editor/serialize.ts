// Row-doc ↔ one-line markup, lossless (design doc D1 §"Serialization").
//
// Syntax (per the doc's table):
//   bold        **text**
//   italic      *text*
//   underline   ++text++
//   greek span  {grc:τὸ τί ἦν εἶναι}     (literal Unicode inside)
//   footnote    {^3:anchored phrase}      (fnRef mark over the phrase, with the
//                                          footnoteMarker node implicit at its
//                                          end; `{^3:}` = marker alone)
//   escapes     backslash before literal \ * + { [ ^ ¶  (always) and } inside
//               {...} spans. Parse side accepts \X → X for any X. `⏎` is NOT
//               escaped here — the generic serializer never changes existing
//               [ENGLISH] bytes over it; only the [ENGLISH.PARA] boundary
//               (encodeParaLine) escapes a literal `⏎` before minting its
//               structural token.
//
// SEGMENT DELIMITER (design doc D6 — line splits): `¶` (U+00B6) is a
// STRUCTURAL token at the [ENGLISH]-row-markup level, one level ABOVE this
// file's run syntax. It delimits the English segments of a paragraph-split
// Bekker line: parseRowSegments splits a physical line on unescaped `¶`
// before parseRow ever sees it, and serializeRowSegments joins segment
// markups with it. A literal pilcrow in text (it never occurs in practice)
// is escaped as `\¶` by escapeText and unescaped by parseRow's generic
// `\X → X` rule — so the segment round trip holds by construction. parseRow
// itself treats an unescaped `¶` as literal text (single-segment callers and
// older files are unchanged).
//
// CANONICAL MARK ORDER (outermost → innermost): fnRef, greek, bold, italic,
// underline (MARK_ORDER in schema.ts). Marks are a set in ProseMirror, so
// overlapping combinations (bold spanning a greek boundary, etc.) are emitted
// stack-style: to move between mark sets we close down to the common prefix in
// canonical order and re-open. That makes serialization a pure function of the
// document — round-trip determinism is what the property test enforces.
//
// `*`-run disambiguation: closing italic then opening bold (or similar) can
// emit runs like `***` or `****`. The parser resolves them STATEFULLY, in a
// way that mirrors the serializer's stack discipline: italic is always deeper
// than bold (canonical order), so while italic is open a `*` always closes it
// first; then `**` closes/opens bold; a lone `*` toggles italic. Toggle
// semantics make the mark SET, not the token split, the parse result — which
// is exactly what the doc stores.
//
// FOOTNOTE INVARIANT (maintained by the editor, see ChapterEditor): a fnRef(id)
// range is contiguous and immediately followed by its footnoteMarker(id).
// The serializer additionally accepts a marker with no preceding fnRef run
// (`{^id:}`, the anchor phrase was deleted). A fnRef run whose marker is gone
// is NOT representable and is serialized as plain text (the editor strips such
// marks; this is the documented normalization, not data loss — the footnote
// body itself lives in the chapter's footnote table).

import type { Mark, Node as PMNode } from '@tiptap/pm/model';
import { Fragment } from '@tiptap/pm/model';
import { rowSchema, MARK_ORDER } from './schema';
import type { PMDocJSON } from './schema';

/** Structural English-segment delimiter in row markup (see module header). */
const PILCROW = '¶';
/** Structural paragraph-layer newline token in [ENGLISH.PARA] markup. */
const RETURN_SYMBOL = '⏎';

// ── shared inline-run model ────────────────────────────────────────────────

/** Marks normalized to names + fnRef id, in canonical order. */
export interface MarkSet {
  fnRef?: string; // footnote id
  greek?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export type InlineRun =
  | { kind: 'text'; text: string; marks: MarkSet }
  | { kind: 'marker'; id: string };

function markSetOf(marks: readonly Mark[]): MarkSet {
  const set: MarkSet = {};
  for (const m of marks) {
    if (m.type.name === 'fnRef') set.fnRef = String(m.attrs.id);
    else if (m.type.name === 'greek') set.greek = true;
    else if (m.type.name === 'bold') set.bold = true;
    else if (m.type.name === 'italic') set.italic = true;
    else if (m.type.name === 'underline') set.underline = true;
  }
  return set;
}

function sameMarks(a: MarkSet, b: MarkSet): boolean {
  return (
    a.fnRef === b.fnRef &&
    !!a.greek === !!b.greek &&
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline
  );
}

/** Ordered list of open "frames" for a mark set, canonical order. */
function frames(set: MarkSet): string[] {
  const out: string[] = [];
  for (const name of MARK_ORDER) {
    if (name === 'fnRef') {
      if (set.fnRef !== undefined) out.push(`fnRef:${set.fnRef}`);
    } else if (set[name]) {
      out.push(name);
    }
  }
  return out;
}

const OPEN: Record<string, string> = { greek: '{grc:', bold: '**', italic: '*', underline: '++' };
const CLOSE: Record<string, string> = { greek: '}', bold: '**', italic: '*', underline: '++' };

function openToken(frame: string): string {
  if (frame.startsWith('fnRef:')) return `{^${frame.slice(6)}:`;
  return OPEN[frame];
}
function closeToken(frame: string): string {
  if (frame.startsWith('fnRef:')) return '}';
  return CLOSE[frame];
}
function isSpanFrame(frame: string): boolean {
  return frame === 'greek' || frame.startsWith('fnRef:');
}

// ── serialize ──────────────────────────────────────────────────────────────

function escapeText(text: string, inSpan: boolean): string {
  let out = '';
  for (const ch of text) {
    if (ch === '\\' || ch === '*' || ch === '+' || ch === '{' || ch === '[' || ch === '^' || ch === PILCROW) {
      out += '\\' + ch;
    } else if (ch === '}' && inSpan) {
      out += '\\}';
    } else {
      out += ch;
    }
  }
  return out;
}

export function runsOf(doc: PMNode): InlineRun[] {
  const runs: InlineRun[] = [];
  doc.forEach((node) => {
    if (node.isText) {
      runs.push({ kind: 'text', text: node.text ?? '', marks: markSetOf(node.marks) });
    } else if (node.type.name === 'footnoteMarker') {
      runs.push({ kind: 'marker', id: String(node.attrs.id) });
    }
  });
  return runs;
}

export function serializeRuns(runs: InlineRun[]): string {
  let out = '';
  const stack: string[] = [];

  const closeTo = (depth: number) => {
    while (stack.length > depth) out += closeToken(stack.pop()!);
  };

  for (const run of runs) {
    if (run.kind === 'marker') {
      const fnFrame = `fnRef:${run.id}`;
      const at = stack.indexOf(fnFrame);
      if (at >= 0) {
        // Close inner frames, then the fnRef span itself — the marker IS its
        // closing brace.
        closeTo(at + 1);
        out += closeToken(stack.pop()!);
      } else {
        // Marker with no anchored phrase.
        out += `{^${run.id}:}`;
      }
      continue;
    }

    const target = frames(run.marks);
    // Orphaned fnRef (no marker will close it): serialize as plain — drop the
    // fnRef frame. See module header.
    const targetSafe = target.filter((f) => !f.startsWith('fnRef:') || hasClosingMarker(runs, run, f.slice(6)));

    let common = 0;
    while (common < stack.length && common < targetSafe.length && stack[common] === targetSafe[common]) common++;
    closeTo(common);
    for (let i = common; i < targetSafe.length; i++) {
      const frame = targetSafe[i];
      stack.push(frame);
      out += openToken(frame);
    }
    const inSpan = stack.some(isSpanFrame);
    out += escapeText(run.text, inSpan);
  }
  closeTo(0);
  return out;
}

/** Does a marker for `id` appear after `from` with fnRef(id) unbroken until it? */
function hasClosingMarker(runs: InlineRun[], from: InlineRun, id: string): boolean {
  let seen = false;
  for (const r of runs) {
    if (r === from) {
      seen = true;
      continue;
    }
    if (!seen) continue;
    if (r.kind === 'marker') {
      if (r.id === id) return true;
      continue; // other markers (e.g. `{^n:}`) may sit inside the phrase run
    }
    if (r.marks.fnRef !== id) return false; // fnRef run interrupted → orphan
  }
  return false;
}

/** Serialize one row document to its one-line markup. */
export function serializeRow(doc: PMNode): string {
  return serializeRuns(runsOf(doc));
}

/**
 * fnRef ids whose anchor run is NOT closed by its marker (marker deleted, or
 * the run was interrupted by an edit). Such anchors are unrepresentable in
 * the markup — the editor strips them right after the edit that caused them.
 */
export function orphanFnRefIds(doc: PMNode): string[] {
  const runs = runsOf(doc);
  const orphans = new Set<string>();
  for (const run of runs) {
    if (run.kind === 'text' && run.marks.fnRef !== undefined) {
      if (!hasClosingMarker(runs, run, run.marks.fnRef)) orphans.add(run.marks.fnRef);
    }
  }
  return [...orphans];
}

// ── parse ──────────────────────────────────────────────────────────────────

/**
 * Merge adjacent equal-mark text runs and drop empties, then build a row doc.
 * Shared normalizer: the parser and any programmatic doc construction go
 * through this so structural equality is well-defined.
 */
export function buildRowDoc(runs: InlineRun[]): PMNode {
  const merged: InlineRun[] = [];
  for (const run of runs) {
    if (run.kind === 'text' && run.text.length === 0) continue;
    const prev = merged[merged.length - 1];
    if (run.kind === 'text' && prev?.kind === 'text' && sameMarks(prev.marks, run.marks)) {
      prev.text += run.text;
    } else {
      merged.push(run.kind === 'text' ? { ...run, marks: { ...run.marks } } : run);
    }
  }

  const nodes = merged.map((run) => {
    if (run.kind === 'marker') {
      return rowSchema.nodes.footnoteMarker.create({ id: run.id });
    }
    const marks: Mark[] = [];
    if (run.marks.fnRef !== undefined) marks.push(rowSchema.marks.fnRef.create({ id: run.marks.fnRef }));
    if (run.marks.greek) marks.push(rowSchema.marks.greek.create());
    if (run.marks.bold) marks.push(rowSchema.marks.bold.create());
    if (run.marks.italic) marks.push(rowSchema.marks.italic.create());
    if (run.marks.underline) marks.push(rowSchema.marks.underline.create());
    return rowSchema.text(run.text, marks);
  });
  return rowSchema.topNodeType.create(null, Fragment.fromArray(nodes));
}

/** Parse one line of markup back into a row document. */
export function parseRow(line: string): PMNode {
  const runs: InlineRun[] = [];
  // Active state (a set — see module header on toggle semantics).
  const active: MarkSet = {};
  // Span stack entries: 'greek' | 'fnRef:<id>'; used for nesting-aware `}`.
  const spanStack: string[] = [];

  let i = 0;
  const emit = (text: string) => {
    if (text) runs.push({ kind: 'text', text, marks: { ...active } });
  };

  const FN_OPEN = /^\{\^([A-Za-z0-9_-]+):/;

  while (i < line.length) {
    const ch = line[i];

    if (ch === '\\' && i + 1 < line.length) {
      emit(line[i + 1]);
      i += 2;
      continue;
    }

    if (line.startsWith('{grc:', i)) {
      spanStack.push('greek');
      active.greek = true;
      i += 5;
      continue;
    }

    const fn = FN_OPEN.exec(line.slice(i));
    if (fn) {
      spanStack.push(`fnRef:${fn[1]}`);
      active.fnRef = fn[1];
      i += fn[0].length;
      continue;
    }

    if (ch === '}' && spanStack.length > 0) {
      const frame = spanStack.pop()!;
      if (frame === 'greek') {
        // (nested greek spans never occur — same mark merges — but stay exact)
        active.greek = spanStack.includes('greek');
      } else {
        const id = frame.slice(6);
        runs.push({ kind: 'marker', id });
        const lower = spanStack.filter((f) => f.startsWith('fnRef:')).pop();
        active.fnRef = lower ? lower.slice(6) : undefined;
      }
      i++;
      continue;
    }

    if (line.startsWith('++', i)) {
      active.underline = !active.underline;
      i += 2;
      continue;
    }

    if (ch === '*') {
      // Stateful `*`-run resolution (see module header).
      if (active.italic) {
        active.italic = false;
        i++;
      } else if (active.bold && line.startsWith('**', i)) {
        active.bold = false;
        i += 2;
      } else if (line.startsWith('**', i)) {
        active.bold = true;
        i += 2;
      } else {
        active.italic = true;
        i++;
      }
      continue;
    }

    // Anything else — including stray `}` at top level and unmatched `{` —
    // is literal text (the serializer always escapes what it emits; parsing
    // is lenient for hand-edited files).
    emit(ch);
    i++;
  }

  return buildRowDoc(runs);
}

// ── paragraph segments (design doc D6 — line splits) ───────────────────────

/**
 * Split a physical [ENGLISH] line on unescaped `¶`, respecting the markup's
 * backslash escapes (`\¶` is a literal pilcrow inside a segment, `\\` is a
 * literal backslash — the char after any backslash never delimits).
 */
function splitOnUnescapedPilcrow(line: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++; // the escaped character can never be a delimiter
    } else if (ch === PILCROW) {
      parts.push(line.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(line.slice(start));
  return parts;
}

/**
 * Encode one paragraph-layer row for [ENGLISH.PARA]. This is the paragraph
 * analog of the PILCROW segment discipline, but the escaping lives HERE, not
 * in the generic serializer (escapeText must never rewrite the bytes of
 * existing [ENGLISH] lines over a literal `⏎`): in one escape-aware walk, a
 * literal `⏎` in the markup becomes `\⏎` (parseRow's generic `\X → X` rule
 * restores it) and each raw PM text newline becomes the unescaped structural
 * `⏎` token, so the file section remains one physical line per row.
 */
export function encodeParaLine(markup: string): string {
  let out = '';
  for (let i = 0; i < markup.length; i++) {
    const ch = markup[i];
    if (ch === '\\' && i + 1 < markup.length) {
      out += ch + markup[i + 1];
      i++;
    } else if (ch === '\r') {
      // A pasted Windows line ending. A raw CR in the section is read back as
      // a line break of its own, and the row counts stop matching — the file
      // then refuses to open. CRLF is one break; a lone CR is one break.
      out += RETURN_SYMBOL;
      if (markup[i + 1] === '\n') i++;
    } else if (ch === '\n') {
      out += RETURN_SYMBOL;
    } else if (ch === RETURN_SYMBOL) {
      out += '\\' + RETURN_SYMBOL;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Decode one [ENGLISH.PARA] physical line before parseRow. Backslash escapes
 * skip the next character exactly like splitOnUnescapedPilcrow, so escaped
 * `\⏎` stays escaped for parseRow to unescape into a literal return symbol;
 * only unescaped `⏎` becomes an in-memory newline.
 */
export function decodeParaLine(line: string): string {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      out += ch + line[i + 1];
      i++;
    } else if (ch === RETURN_SYMBOL) {
      out += '\n';
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Parse one physical [ENGLISH] line into its 1..N segment docs (PM JSON) —
 * a thin wrapper over parseRow: split on unescaped `¶`, parse each piece.
 * A line with no `¶` yields exactly [parseRow(line)] — older files are
 * byte-for-byte unchanged through this path.
 */
export function parseRowSegments(line: string): PMDocJSON[] {
  return splitOnUnescapedPilcrow(line).map((segment) => parseRow(segment).toJSON());
}

/**
 * Serialize segment docs back to the one physical line — a thin wrapper over
 * serializeRow: serialize each segment, join with `¶`. serializeRow escapes
 * any literal pilcrow in text (`\¶`), so every unescaped `¶` in the output is
 * structural and parseRowSegments(serializeRowSegments(docs)) round-trips by
 * construction. An empty docs array (never produced by the model — a row has
 * at least segment 0) serializes as the empty line.
 */
export function serializeRowSegments(docs: PMDocJSON[]): string {
  return docs.map((doc) => serializeRow(rowSchema.nodeFromJSON(doc))).join(PILCROW);
}

/**
 * Rejoin segment docs into ONE row doc, non-empty segments separated by a
 * single plain space — the app's existing join convention (un-split,
 * paste-flatten, copy-as-citation). Hydration's drift policy uses this: when
 * a stored split can't be honored, the line loads unsplit and every segment's
 * English (marks, markers and all) is preserved in order — nothing lost.
 */
export function joinRowDocs(docs: PMDocJSON[]): PMDocJSON {
  const runs: InlineRun[] = [];
  for (const doc of docs) {
    const segmentRuns = runsOf(rowSchema.nodeFromJSON(doc));
    if (segmentRuns.length === 0) continue;
    if (runs.length > 0) runs.push({ kind: 'text', text: ' ', marks: {} });
    runs.push(...segmentRuns);
  }
  return buildRowDoc(runs).toJSON();
}

/**
 * Strip footnote markup from a row doc: marker nodes are removed and fnRef
 * marks are cleared, keeping every character of text (lossless for the
 * surrounding prose; only the footnote DECORATION goes).
 *
 * D8 v1 rule: footnotes are a SENTENCE-LAYER feature, period. The paragraph
 * layer ([ENGLISH.PARA] / RowModel.englishPara) does not model footnote
 * markers — the editor blocks inserting them there (D8 Phase E2) — but marker
 * markup can still arrive via paste or a hand-edited file. Every boundary
 * where sentence-layer markers become LIVE footnotes (hydration,
 * serialization, export) runs paragraph-layer content through this instead,
 * so a para-layer `{^id:phrase}` deterministically degrades to plain
 * "phrase": it never anchors, creates, renumbers, or exports a footnote.
 */
export function stripFootnoteRuns(runs: InlineRun[]): InlineRun[] {
  return runs
    .filter((run) => run.kind !== 'marker')
    .map((run) =>
      run.kind === 'text' && run.marks.fnRef !== undefined
        ? { ...run, marks: { ...run.marks, fnRef: undefined } }
        : run,
    );
}

/** stripFootnoteRuns on a whole row doc (see that function for the policy). */
export function stripFootnoteMarkup(doc: PMNode): PMNode {
  return buildRowDoc(stripFootnoteRuns(runsOf(doc)));
}

/** stripFootnoteMarkup at the one-line-markup level (export-side helper). */
export function stripFootnoteMarkupLine(line: string): string {
  return serializeRow(stripFootnoteMarkup(parseRow(line)));
}

/** Dev-build guard: assert the round-trip on a doc; throws on mismatch. */
export function assertRoundTrip(doc: PMNode): void {
  const line = serializeRow(doc);
  const back = parseRow(line);
  const normalized = buildRowDoc(runsOf(doc));
  if (!back.eq(normalized)) {
    throw new Error(
      `Row serialization round-trip failed.\n  line: ${line}\n  doc:  ${JSON.stringify(normalized.toJSON())}\n  back: ${JSON.stringify(back.toJSON())}`,
    );
  }
}
