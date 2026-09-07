// HTML sanitizer for corpus-sourced markup rendered via {@html}/set:html.
//
// The reader injects pre-rendered HTML from the corpus in several places — LSJ
// dictionary entries, built-in footnotes, endnotes. That HTML comes from the
// build pipeline, not from user input, so this is a supply-chain/defense-in-
// depth boundary rather than a live XSS sink: it guarantees that even a stray
// tag or a compromised data file can only ever emit an allowlisted subset of
// inline markup, never script, event handlers, or javascript: URLs.
//
// Lives in shared/ so both the Astro site and the shared reader components
// (WordPopup, FootnotePopup, EndnoteSidebar) apply the SAME rules. app/src/lib/
// html.ts re-exports this so existing app imports keep working.

// Ostwald prints two diagrams inside his notes (the equal-lines construction at
// 1132b and the diagonal pairing at 1133a): the figure IS the note, so it has
// to survive into the popup. Only shape and label elements are allowed, and the
// dangerous parts of SVG are deliberately absent — `use`/`image`/`foreignObject`
// (they fetch or embed foreign content), `animate`/`set` (they can retarget
// another element's attributes), `style` and `script`. Nothing left in the set
// takes a URL, and every `on*` attribute is dropped below, so no allowlisted
// figure can fetch or execute anything.
const SVG_TAGS = new Set(['svg', 'g', 'path', 'text', 'figure', 'figcaption']);

// `div` carries the ONLY structure LSJ entries have: stage5 emits every sense
// as <div class="lsj-sense" data-level="N">, nesting sub-senses inside their
// parent. Dropping the tag (as this allowlist did until 2026-08-19) collapsed
// LSJ's A → I → 1 → a hierarchy into one undifferentiated paragraph — the
// "wall of text" the stylesheet's .lsj-sense rules were written for and never
// got to match. A div is inert: no URL, no script, no event surface.
const ALLOWED_TAGS = new Set([
  'a',
  'b',
  'br',
  'div',
  'em',
  'i',
  'li',
  'ol',
  'p',
  'span',
  'strong',
  'sub',
  'sup',
  'ul',
  ...SVG_TAGS,
]);

const VOID_TAGS = new Set(['br']);

// Attribute names arrive lowercased; the HTML parser restores the camelCase of
// known SVG attributes (viewBox) when it adopts them into the SVG namespace.
const SVG_ATTRS = new Set([
  'viewbox', 'd', 'x', 'y', 'width', 'height', 'role', 'fill', 'stroke',
  'stroke-width', 'stroke-linecap', 'stroke-dasharray', 'font-size',
  'font-style', 'text-anchor',
]);
// Geometry, path data (letters + numbers), and keyword colours — never a URL,
// a quote, or a bracket, so a value can neither escape the attribute nor smuggle
// url(...) into a presentation attribute.
const SVG_VALUE = /^[\w\s.,#%-]*$/;

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeHref(value: string): string | null {
  const trimmed = value.trim();
  // Strip whitespace and control characters (\p{Cc} = C0 0x00-0x1F and DEL/C1
  // 0x7F-0x9F) before scheme-matching, so "java\tscript:" or a leading control
  // char can't slip a dangerous scheme past the prefix check.
  const normalized = trimmed.replace(/[\s\p{Cc}]+/gu, '').toLowerCase();
  if (
    normalized.startsWith('javascript:') ||
    normalized.startsWith('data:') ||
    normalized.startsWith('vbscript:')
  ) {
    return null;
  }
  return trimmed;
}

// An attribute value arrives as HTML source, entities and all, and leaves
// through escapeAttr, which escapes every "&" again: title="Smith &amp; Jones"
// reached the browser as "Smith &amp;amp; Jones" and showed the entity itself.
// Decoding first also puts the scheme check on what the browser would see —
// "&#106;avascript:" IS "javascript:" — instead of on its spelling. Only the
// entities the pipeline (and escapeAttr) write; anything else stays literal and
// is re-escaped, so no decoding can be undone twice.
const NAMED_ENTITY: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};
function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|(amp|lt|gt|quot|apos));/gi, (m, hex, dec, named) => {
    if (named) return NAMED_ENTITY[named.toLowerCase()];
    const cp = hex ? parseInt(hex, 16) : Number(dec);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

function sanitizeAttrs(raw: string, tag: string): string {
  const attrs: string[] = [];
  const attrRe = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(raw))) {
    const name = match[1].toLowerCase();
    const value = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
    if (name.startsWith('on')) continue;

    if (name === 'class' && /^[\w -]+$/.test(value)) {
      attrs.push(`class="${escapeAttr(value)}"`);
    } else if (name === 'href' && tag === 'a') {
      const href = safeHref(value);
      if (href) attrs.push(`href="${escapeAttr(href)}"`);
    } else if (name === 'data-level' && /^\d{1,2}$/.test(value)) {
      // Sense depth, the hook the hierarchy styling indents from. Digits only:
      // the value reaches CSS as an attribute selector, never as markup.
      attrs.push(`data-level="${value}"`);
    } else if (name === 'title' || name === 'aria-label') {
      attrs.push(`${name}="${escapeAttr(value)}"`);
    } else if (name === 'style' && tag === 'span' && /^\s*font-variant\s*:\s*small-caps\s*;?\s*$/i.test(value)) {
      attrs.push('style="font-variant: small-caps"');
    } else if (SVG_TAGS.has(tag) && SVG_ATTRS.has(name) && SVG_VALUE.test(value)) {
      attrs.push(`${name}="${escapeAttr(value)}"`);
    }
  }
  return attrs.length ? ` ${attrs.join(' ')}` : '';
}

// A tag is what the HTML tokenizer calls a tag: "<" or "</" followed AT ONCE by
// a letter, through to the next ">". Allowing whitespace after the "<" (as this
// did until 2026-09-07) read "a < b and c > d" as a <b> element and ate the
// prose between; the browser shows that as text, and so does this now.
//
// Every "<" the tag pass leaves behind is escaped. The output is not always
// mounted on its own: renderLsjEntry and the forms block concatenate more
// markup after it, and set:html splices it into a server-rendered page. A
// trailing `<a href=x onclick=alert(1)` with no ">" — which the tag pass
// cannot match — passed through verbatim and closed itself on whatever came
// next, `</div>` included, into a live handler. As text it is "&lt;a href…",
// which is what the parser would have shown for it anyway. A stray "<!" or
// "<?" likewise opened a bogus comment that hid everything up to the next ">".
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(\/?)([a-z][\w:-]*)([^>]*)>|</gi, (full, slash, rawTag, rawAttrs) => {
      if (rawTag === undefined) return '&lt;';
      const tag = rawTag.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return '';
      if (slash) return VOID_TAGS.has(tag) ? '' : `</${tag}>`;
      return `<${tag}${sanitizeAttrs(rawAttrs ?? '', tag)}>`;
    });
}

// LSJ shard HTML carries site-root-relative citation hrefs (the pipeline
// cannot know the deploy base); every renderer must prefix them. The pattern
// matches sanitizeHtml's own serialization (class before href, as stage5
// emits) — the word-popup round-trip test locks that. Idempotent: an
// already-prefixed href is left alone, and an empty or bare-slash base is a
// no-op rather than a protocol-relative "//" corruption.
export function prefixLsjCitationHrefs(html: string, base: string): string {
  if (!base || base === '/') return html;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(
    new RegExp(`(<a class="lsj-bibl" href=")(?!${escaped}/)/`, 'g'),
    `$1${base}/`,
  );
}

// ── LSJ sense outline ───────────────────────────────────────────────────────
// A long LSJ entry (λόγος, ἔχω, γίγνομαι) runs to hundreds of lines of prose.
// Indentation alone does not make it navigable: the reader still has to scroll
// the whole thing to learn how many top-level senses there are. This lifts the
// level-1 senses out as a jump list — number, a snippet of the sense's own
// leading prose, and an anchor id stamped into the markup to jump to.
//
// It runs on ALREADY-SANITIZED html (the ids are minted here, so `id` never has
// to be allowlisted in the sanitizer) and matches sanitizeHtml's serialization.
// Both lookaheads, so it holds whichever order the attributes come in.
export interface LsjSenseRef {
  /** The sense number as LSJ prints it ("A", "B", …), without its full stop. */
  n: string;
  /** Anchor id stamped onto the sense div. */
  id: string;
  /** Truncated first words of the sense, for the jump list. */
  label: string;
}

// Every sense div at any depth. A lookahead for the class so attribute order
// is free, and the attributes captured so a rewrite can put them back verbatim.
const SENSE_OPEN = /<div(?=[^>]*\bclass="lsj-sense")([^>]*)>/g;
const LEVEL_OF = /\bdata-level="(\d{1,2})"/;
const DEPTH_OF = /\bdata-depth="(\d)"/;
const SENSE_N = /^\s*<b class="lsj-sense-n">([\s\S]*?)<\/b>/;
const LABEL_MAX = 56;

function plainText(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // &amp; last, so "&amp;lt;" cannot be unescaped twice into a tag.
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    // Dropping a tag leaves a space where the markup was, and LSJ sets its
    // punctuation OUTSIDE the italic run (<i>relation</i>, ) — without this the
    // label reads "relation , correspondence , proportion".
    .replace(/\s+([,;:.!?)\]])/g, '$1')
    .replace(/([([])\s+/g, '$1')
    .trim();
}

function truncateLabel(text: string): string {
  const trimmed = text.replace(/^[\s,;:.·—–-]+/, '').replace(/[\s,;:.·—–-]+$/, '');
  if (trimmed.length <= LABEL_MAX) return trimmed;
  const cut = trimmed.slice(0, LABEL_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > LABEL_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}…`;
}

interface SenseHit {
  /** Offset of the opening `<div`. */
  start: number;
  /** Offset just past the opening tag — where the sense's own prose begins. */
  end: number;
  /** The opening tag's attributes, verbatim, to put back on a rewrite. */
  attrs: string;
  /** `data-level` as the pipeline wrote it. */
  level: number;
  /** The sense number as LSJ prints it, "" when the sense is unnumbered. */
  n: string;
  label: string;
}

function scanSenses(html: string): SenseHit[] {
  const hits: SenseHit[] = [];
  SENSE_OPEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENSE_OPEN.exec(html))) {
    const level = LEVEL_OF.exec(match[1]);
    hits.push({
      start: match.index,
      end: match.index + match[0].length,
      attrs: match[1],
      level: level ? Number(level[1]) : 1,
      n: '',
      label: '',
    });
  }
  // A sense's OWN prose stops where the next sense begins, whatever its depth.
  for (let i = 0; i < hits.length; i += 1) {
    const stop = i + 1 < hits.length ? hits[i + 1].start : html.length;
    const body = html.slice(hits[i].end, stop);
    const nMatch = SENSE_N.exec(body);
    hits[i].n = nMatch ? plainText(nMatch[1]).replace(/\.$/, '') : '';
    hits[i].label = truncateLabel(plainText(body.slice(nMatch ? nMatch[0].length : 0)));
  }
  return hits;
}

// `data-level` is absolute across the dictionary, but an entry does not have to
// start at level 1 and most do not: of 14,047 deployed entries, 759 have no
// level-1 sense at all — λόγος opens at level 2, so its I/II/III are the
// entry's real sections. Styling straight off `data-level` indented them like
// sub-senses and greyed their numbers. `data-depth` is that level made relative
// to the shallowest one THIS entry uses, so every entry's own top sections read
// as top sections. Stamped after sanitizing, like the outline ids, so the
// attribute never has to be allowlisted. Idempotent: already-stamped html is
// returned untouched.
export function stampSenseDepth(html: string): string {
  const hits = scanSenses(html);
  if (!hits.length) return html;
  // Per TAG, not per string: an entry whose prose happens to quote the text
  // data-depth="1" would otherwise suppress stamping for the whole entry.
  if (hits.every((hit) => DEPTH_OF.test(hit.attrs))) return html;
  // The ranks THIS entry uses, compressed onto consecutive depths. Subtracting
  // the shallowest is not enough: 1,836 deployed entries skip a rank outright
  // (1,621 of them run level 1 → 3, LSJ going A. then straight to 1.), and
  // subtraction left those a step further in than their parent, wearing the
  // grade of a rank that is not in the entry at all.
  // Level 0 is not a rank. Two entries use it (ὅς, ποιέω) and it holds a note
  // above the entry proper — "USAGE of the Relat. Pron." — so counting it as a
  // rank pushed their real A/B sections down a level and stripped the section
  // accent off them. It is ranked with the top, not above it.
  const ranks = [...new Set(hits.map((hit) => hit.level).filter((level) => level >= 1))]
    .sort((a, b) => a - b);
  const depthOfLevel = new Map(ranks.map((level, i) => [level, Math.min(5, i + 1)]));
  let out = '';
  let cursor = 0;
  for (const hit of hits) {
    const depth = hit.level < 1 ? 1 : depthOfLevel.get(hit.level) ?? 1;
    out += html.slice(cursor, hit.start);
    // Drop a stale depth rather than prepending a second one: a partially
    // stamped tree would otherwise carry data-depth twice on the same tag.
    out += `<div data-depth="${depth}"${hit.attrs.replace(/\s*data-depth="\d"/g, '')}>`;
    cursor = hit.end;
  }
  return out + html.slice(cursor);
}

// The jump list indexes ONE depth: the shallowest that actually carries enough
// numbered sections to be worth listing. Hardcoding depth 1 published a list
// for 92 entries and none for λόγος; it also emitted eleven blank rows for
// δέκα, whose level-1 divs are unnumbered compound-holders. An unnumbered sense
// is never a section, so it never counts toward the threshold and is never
// listed.
export function outlineLsjSenses(
  html: string,
  idPrefix = 'lsj-sense',
  outlineMin = 1,
): { html: string; senses: LsjSenseRef[] } {
  const stamped = stampSenseDepth(html);
  const hits = scanSenses(stamped);
  const depthOf = (attrs: string): number => {
    const found = DEPTH_OF.exec(attrs);
    return found ? Number(found[1]) : 1;
  };

  // The shallowest depth that is a real division — two numbered sections or
  // more. Descending past one (because it held fewer than outlineMin) listed
  // sub-senses belonging to different parents side by side and labelled them
  // the entry's main senses. A depth with a single numbered section is not a
  // division, so it is passed over: that is how an entry whose whole body sits
  // under one unnumbered or solitary heading still gets a usable list.
  // A section number has to be a number or a letter. LSJ sets a bare bullet on
  // an entry-opening note, and a list row reading "•" indexes nothing.
  // A letter or a digit in ANY script: LSJ numbers some sections with Greek
  // capitals (Α in ἑαυτοῦ, ἐάω, ἔαρ), which an ASCII test threw away. A bare
  // bullet is punctuation in every script and stays excluded.
  const numbered = (hit: SenseHit): boolean => /[\p{L}\p{N}]/u.test(hit.n);
  // The sense each sense hangs under: the nearest one before it that sits
  // shallower. The markup is a flat run, so this is what nesting would have
  // said. Senses at the shallowest depth share the root.
  const parentOf = new Map<SenseHit, number>();
  hits.forEach((hit, i) => {
    let parent = -1;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (depthOf(hits[j].attrs) < depthOf(hit.attrs)) { parent = j; break; }
    }
    parentOf.set(hit, parent);
  });

  // A division is ONE parent's own sections. Listing a depth whose numbered
  // senses hang under different parents produced lists like ἀναιρέω's
  // "II, III, II, III" — two parents' subdivisions concatenated, their numbers
  // repeating, presented as the entry's main senses. 480 entries did that.
  let chosen = 0;
  for (let depth = 1; depth <= 5; depth += 1) {
    const at = hits.filter((hit) => depthOf(hit.attrs) === depth && numbered(hit));
    // Fewer than two numbered sections is not a division. Look deeper — this
    // is what gives an entry sitting under one heading a usable list.
    if (at.length < 2) continue;

    // From here the depth IS populated, so it is this entry's division or the
    // entry has none. A failure below must NOT send the search deeper: doing
    // that took εὔσημος, whose depth 2 reads "II, II", and published one
    // branch's "2, 3, 4, 5" as the entry's four main senses. 16 entries did
    // that. Refuse the entry instead.
    const parents = new Set(at.map((hit) => parentOf.get(hit)));
    if (parents.size !== 1) break;

    // Sections below the top must hang under a REAL sense. In ἄγω the level-2
    // run precedes the only level-1 section, so those senses have no parent
    // and share the root with it; the list published "I–VII" and silently
    // dropped B, a main section. 12 entries did that.
    const parent = [...parents][0];
    if (depth > 1 && parent === -1) break;

    // And the division has to cover the ENTRY, not one branch of it. Descending
    // past a depth that held a single numbered section skipped that section:
    // ἆρα listed a level-3 run while II and B sat above it, unlisted. So every
    // numbered sense shallower than the chosen depth must lie on the chosen
    // parent's own ancestry — it may be a heading the list sits under, never a
    // sibling section the list leaves out.
    const ancestry = new Set<number>();
    for (let a = parent; a !== -1 && a !== undefined; a = parentOf.get(hits[a]) ?? -1) {
      ancestry.add(a);
    }
    const skipped = hits.some(
      (hit, i) => depthOf(hit.attrs) < depth && numbered(hit) && !ancestry.has(i),
    );
    if (skipped) break;

    // A division numbers its sections once each. A repeat means this is not
    // one run, whatever the markup says, and "I, II, II" is worse than no list.
    const labels = at.map((hit) => hit.n);
    if (new Set(labels).size !== labels.length) break;

    chosen = depth;
    break;
  }
  if (!chosen) return { html: stamped, senses: [] };
  const atChosen = hits.filter((hit) => depthOf(hit.attrs) === chosen && numbered(hit)).length;
  if (atChosen < Math.max(1, outlineMin)) return { html: stamped, senses: [] };

  const senses: LsjSenseRef[] = [];
  const used = new Set<string>();
  let out = '';
  let cursor = 0;
  for (const hit of hits) {
    if (depthOf(hit.attrs) !== chosen || !numbered(hit)) continue;
    const slug = hit.n.replace(/[^A-Za-z0-9]+/g, '').toLowerCase() || String(senses.length + 1);
    let id = `${idPrefix}-${slug}`;
    for (let dup = 2; used.has(id); dup += 1) id = `${idPrefix}-${slug}-${dup}`;
    used.add(id);
    senses.push({ n: hit.n, id, label: hit.label });
    out += stamped.slice(cursor, hit.start);
    out += `<div id="${id}"${hit.attrs}>`;
    cursor = hit.end;
  }
  return { html: out + stamped.slice(cursor), senses };
}

// ── the block of forms before the senses ────────────────────────────────────
// 65% of entries open with one: a run of inflected forms, each introduced by a
// grammatical label — "fut. λέξω Od. 24.224: aor. ἔλεξα A. Pers. 292". It is
// NOT a run of quotations, and treating it as one put every line break between
// a label and the form it labels, stranding "fut." at the end of the line
// above. The words worst hit are the ones most looked up: εἰμί and τίθημι
// carry 69 forms each, οἶδα 39, δίδωμι 37.
//
// The rows cannot be found from the markup alone, because a label is not always
// tagged — in λέγω the "Ep." before ἐλέγμην is bare text between two citations.
// What IS reliable is the dictionary's own punctuation: it closes one form and
// opens the next with ":" or ";" (and ":—" at a voice change). So the block is
// cut there, and each row is whatever label text precedes that row's citation.
const SENSE_DIV = '<div class="lsj-sense"';
const FORMS_MIN_ALIGNED = 4;   // below this a run reads better as prose
const FORMS_MIN_FOLDED = 12;   // above this it buries the senses beneath it

/** Split at ":" / ";" that sit between tags, never inside one. */
function splitOnSeparators(html: string): string[] {
  const parts: string[] = [];
  let depth = 0;   // inside a tag
  let open = 0;    // inside an element
  let start = 0;
  for (let i = 0; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === '<') {
      depth += 1;
      // Track element nesting as well: a separator inside <span>…;…</span>
      // would otherwise split the element across two segments and leave both
      // halves unbalanced (ἀντιάω did exactly this).
      const tag = /^<(\/?)([a-z][\w-]*)/i.exec(html.slice(i, i + 24));
      if (tag) {
        if (tag[1]) open = Math.max(0, open - 1);
        else if (!VOID_TAGS.has(tag[2].toLowerCase())) open += 1;
      }
    } else if (ch === '>') depth -= 1;
    else if (depth <= 0 && open <= 0 && (ch === ':' || ch === ';')) {
      // A ";" also ends an HTML entity, and LSJ marks an editorial supplement
      // with angle brackets — φ&lt;ε&gt;ισθήσομαι. Splitting there tore "&lt;"
      // in half and the reader saw a raw "&lt". Three entries do this.
      if (ch === ';' && /&[a-zA-Z]{2,8}$|&#x?[0-9a-fA-F]{1,6}$/i.test(html.slice(Math.max(0, i - 10), i))) continue;
      // ":—" is one separator, not two
      const end = html[i + 1] === '\u2014' ? i + 2 : i + 1;
      parts.push(html.slice(start, end));
      start = end;
      i = end - 1;
    }
  }
  if (start < html.length) parts.push(html.slice(start));
  return parts.filter((part) => part.trim());
}

/** What a grammatical label is: a short chain of LSJ's own grammatical
 *  abbreviations — tense, mood, voice, dialect, case, person and number — with
 *  the few bare words LSJ sets among them ("late fut.", "only impf.", "3 dual",
 *  "aor. 1"). It is the guard that stops the headword cut from firing on a
 *  cross-reference, so prose must not match.
 *
 *  Vocabulary, not shape. Its first version accepted anything short and ASCII
 *  that ended in a period, and so took "cf." for a label; and it rejected
 *  "aor. 1", "impf. 3 sg." and "Pass., fut.", which are labels — 19 entries
 *  kept their headword in the label for that. Codex found both. */
const LABEL_ABBR =
  'pres|impf|fut|aor|pf|plpf|ind|subj|opt|imper|inf|part|iter|iterat' +
  '|act|med|mid|pass' +
  '|att|ep|ion|dor|aeol|boeot|lacon|cret|arc|cypr|thess|lesb|poet' +
  '|nom|gen|dat|acc|voc|masc|fem|neut|sg|pl|pers';
const LABEL_TOKEN = `(?:(?:${LABEL_ABBR})\\.|late|only|dual|[1-3])`;
// At least one abbreviation (or "dual") somewhere, so a bare "1" or "late" is
// not a label.
const LABELISH = new RegExp(
  `^(?=.*(?:\\b(?:${LABEL_ABBR})\\.|\\bdual\\b))${LABEL_TOKEN}(?:,?\\s${LABEL_TOKEN}){0,5}$`, 'i');

function plainLabel(fragment: string): string {
  return plainText(fragment)
    .replace(/^[\s:;\u2014,.]+/, '')
    .replace(/[\s:;,]+$/, '')
    .trim();
}

/**
 * Rebuild the pre-sense block as labelled rows. Returns the block's html and
 * how many forms it holds, so the caller can decide how to present it.
 */
export function buildFormsBlock(preamble: string): { html: string; rows: number } {
  const segments = splitOnSeparators(preamble);
  if (!segments.length) return { html: preamble, rows: 0 };

  // The head is everything up to the first segment that carries a citation:
  // the headword, its gender, and whatever prose introduces the forms.
  // A form is a citation, OR a Greek phrase with a reference beside it — LSJ
  // uses both shapes in the same block.
  // A headword's quantity mark is an .lsj-greek span with the entry's own
  // references behind it, so it passed that test and opened the table on the
  // lemma: ἀλήθεια put "ᾰλ], ἡ, Dor. ἀλάθεια" in a body, and ἀπατάω put "[ᾰπ]"
  // where "impf. ἠπάτων" belonged. A quantity mark is notation, not a form,
  // and its brackets say so in either of the two shapes LSJ writes them:
  // inside the span ("[ᾰπ"), or around it ("[" + "ᾱγλᾰ-" + "]"). Length does
  // NOT say so — ὕβρις marks quantity in forty characters, and ἦν is a form in
  // two. Square brackets only: a parenthesis in the same position opens an
  // etymology, and reading "(ἀ- priv., διδράσκω)" as notation costs entries
  // like ἀδελφός their opening bracket. Both traps were measured in
  // homer-reader before this was ported here.
  const quantityMark = (seg: string, at: number): boolean => {
    const open = seg.indexOf('>', at);
    const close = open === -1 ? -1 : seg.indexOf('</span>', open);
    if (close === -1) return false;
    if (/^\[/.test(plainText(seg.slice(open + 1, close)).trim())) return true;
    return /\[\s*$/.test(seg.slice(0, at).replace(/<[^>]*>/g, ''));
  };
  // A clause LSJ opens with "cf." is a comparison, not a row of the paradigm:
  // ἱδρόω's "[ῐ by nature, cf. ἀφῐδρωσον Com.Adesp. 3 D.]" sits inside the
  // quantity aside, and taking that citation for the first form labelled the
  // row "cf." and pushed the real first form, fut. -ώσω, to the second row.
  // Six entries open their table that way, and in each the citation after
  // "cf." is a compound (ἐπάμερος under ἡμέρα), a phrase (ξυμφορὴ γίνεται δ.
  // under διδάσκαλος), or another verb's form (ἀμέλησον under ἀμέλει); eight
  // more carry a "cf." row further down the table.
  //
  // The whole SEGMENT declines, not just the one citation. Skipping the
  // citation alone let the same segment's spelling variant (βοηθέω) or the
  // next compared item in the list (ἡμέρα's αὐθημερόν) be taken for the form
  // instead, and opened two entries on an empty head.
  const compared = (seg: string, at: number): boolean =>
    /\bcf\.\s*$/.test(plainText(seg.slice(0, at)));
  // A form inside an unclosed "(" is not a row. ἀριθμός's "[ᾰ], (" and
  // ἀντιτίθημι's "(pres. part." both opened the table on a parenthetical, and
  // the row read the headword and an open bracket as its label — 83 entries.
  // A parenthesis is counted from the START of the preamble, not of the
  // segment: "(pres. part. X; aor. Y)" is one aside across two segments, and
  // its second half is no more a row than its first. Plain text only, so a
  // bracket inside a tag never counts; and ")" never goes below zero, so a
  // stray close cannot open a table by itself.
  const parenDepth = (html: string, from: number): number => {
    let depth = from;
    for (const ch of plainText(html)) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth = Math.max(0, depth - 1);
    }
    return depth;
  };
  const depthBefore: number[] = [0];
  for (const seg of segments) depthBefore.push(parenDepth(seg, depthBefore[depthBefore.length - 1]));
  const parenthesized = (seg: string, at: number, before: number): boolean =>
    parenDepth(seg.slice(0, at), before) > 0;
  const formAt = (seg: string, before = 0): number => {
    const cit = seg.indexOf('<span class="lsj-cit">');
    // The whole segment declines for a parenthesized citation, as for "cf.":
    // whatever follows the ")" in the same clause is prose about the aside.
    if (cit !== -1) return compared(seg, cit) || parenthesized(seg, cit, before) ? -1 : cit;
    for (
      let greek = seg.indexOf('<span class="lsj-greek');
      greek !== -1;
      greek = seg.indexOf('<span class="lsj-greek', greek + 1)
    ) {
      if (quantityMark(seg, greek)) continue;
      // A Greek phrase inside the bracket is skipped like a quantity mark —
      // Ἀδράστεια's "(ἀ- priv., διδράσκω)" is an etymology, not a form — and
      // the next phrase outside it is judged on its own.
      if (parenthesized(seg, greek, before)) continue;
      return seg.indexOf('class="lsj-bibl"', greek) !== -1 ? greek : -1;
    }
    return -1;
  };
  // A lead that ends in "for" is a cross-reference, not a paradigm: ἀναγκαίη's
  // "ἡ, Ep. and Ion, for ἀνάγκη", διπλός's "ή, όν, poet. for διπλοῦς" — 38
  // entries, none with a form of its own. The English word at the END of the
  // lead, after a space, never "for" inside a Greek run or mid-lead; and only
  // the lead, so a "for" further down a real table is still a row's label.
  // The segment stays in the head as prose; the table, if any, opens later.
  const crossRef = (seg: string, at: number): boolean =>
    /(?:^|\s)for$/i.test(plainLabel(seg.slice(0, at)));
  const firstForm = segments.findIndex((seg, i) => {
    const at = formAt(seg, depthBefore[i]);
    return at !== -1 && !crossRef(seg, at);
  });
  if (firstForm === -1) return { html: preamble, rows: 0 };

  let head = segments.slice(0, firstForm).join('');
  const rows: string[] = [];
  const tail = segments.slice(firstForm);
  // The first form's segment usually carries the sentence that introduces the
  // whole block ("tenses for signf. I and II, fut."). Only the last clause is
  // that form's label; the rest belongs above, with the headword.
  //
  // formAt, not indexOf: a first form of the lsj-greek + lsj-bibl shape
  // ("ἀπολείπω, aor. -έλιπον Il. 12.169") skipped this whole block, and its
  // headword stayed in the label — 99 entries, the largest class after the
  // article fix. The citation shape is remembered because the >22 length
  // path below is FORBIDDEN for Greek-shaped forms: ἀναγκαίη's "ἡ, Ep. and
  // Ion, for" is 29 characters of prose, and the length path would hand the
  // row the label "for". Greek-shaped leads cut on vocabulary evidence only.
  const firstAt = formAt(tail[0], depthBefore[firstForm]);
  const citFirst = tail[0].startsWith('<span class="lsj-cit">', firstAt);
  if (firstAt > 0) {
    const lead = tail[0].slice(0, firstAt);
    // The comma has to be OUTSIDE every tag. ἄγω's lead ends
    // `<span class="lsj-greek">ἦγον,</span>`, and cutting at that comma left
    // the span unclosed with the whole forms grid injected through it — 90
    // entries did this.
    // ELEMENT depth, not tag depth. A comma inside `<span>ἦγον,</span>` sits
    // between two tags, so counting angle brackets called it depth 0 and the
    // cut still tore the span in half — 84 entries, ἄγω among them.
    let cut = -1;
    let open = 0;
    const tagRe = /<(\/?)([a-z][\w-]*)[^>]*>/gi;
    let mark: RegExpExecArray | null;
    let at = 0;
    const scan = (from: number, to: number) => {
      if (open !== 0) return;
      for (let i = from; i < to; i += 1) if (lead[i] === ',') cut = i;
    };
    while ((mark = tagRe.exec(lead))) {
      scan(at, mark.index);
      if (mark[1]) open = Math.max(0, open - 1);
      else if (!VOID_TAGS.has(mark[2].toLowerCase())) open += 1;
      at = mark.index + mark[0].length;
    }
    scan(at, lead.length);
    // A headword is never a form's label. Where the lead opens with the
    // headword and a grammatical label ends it, the 22-character threshold
    // below never fires — "αἱρέω, impf." is only twelve — so the row read
    // "αἱρέω, impf." against ᾕρεον. 495 entries did this.
    //
    // The LAST clause is the form's label; everything before the last comma
    // describes the lemma and goes up with the head. That holds whatever
    // stands in between: a vocabulary run ("προσερέσθαι, aor. 2 inf., fut."),
    // or the article and gender ("δεσμός, ὁ, pl." — requiring the whole run
    // to be vocabulary left the headword in the label there for the article's
    // sake).
    //
    // And only where that last clause IS grammatical vocabulary. LSJ writes
    // plenty of leads that are prose — ἀναγκαίη ends "for", Ἀθήναια ends
    // "older name of the" — and inventing a label there would be worse than
    // leaving the headword where it is.
    const headFirst = /^\s*<b class="lsj-head">/.test(lead);
    const afterLast = cut === -1 ? '' : plainLabel(lead.slice(cut + 1));
    if (headFirst && cut !== -1 && LABELISH.test(afterLast)) {
      head += lead.slice(0, cut + 1);
      tail[0] = lead.slice(cut + 1) + tail[0].slice(firstAt);
    } else if (citFirst && cut !== -1 && plainLabel(lead).length > 22) {
      head += lead.slice(0, cut + 1);
      tail[0] = lead.slice(cut + 1) + tail[0].slice(firstAt);
    }
  }
  // A preamble is a table only as far as it stays one. λέγω's runs out after
  // seven forms and turns into prose — "also post-Hom. in these senses, but
  // only in compos., esp. with ἀπο-, ἐκ-, κατα-, συν-" — which has no citation
  // in it at all. Feeding that to the grid made every stray run of text its own
  // cell, so "(" landed in the label column opposite "κατ-, συν". Rows stop at
  // the first segment with no form in it; the remainder stays prose.
  let note = '';
  const labels: string[] = [];
  for (const [i, seg] of tail.entries()) {
    const at = formAt(seg, depthBefore[firstForm + i]);
    if (at === -1) {
      // A segment with no form in it is either an interruption or the end of
      // the table. τίθημι is interrupted after two forms by a 136-character
      // aside ("but τίθης is found in Pl. R. l.c. codd. AD…") and then carries
      // on for fifty more; λέγω simply stops being a table. Look ahead: if any
      // later segment still holds a form, this is an aside — keep it with the
      // row above, INSIDE that row, never loose in the grid where it would
      // become its own cell.
      const more = tail.slice(i + 1).some((rest, j) => formAt(rest, depthBefore[firstForm + i + 1 + j]) !== -1);
      if (!more) { note = tail.slice(i).join(''); break; }
      // Before any row exists there is nothing to attach to — it belongs to the
      // head, and must never simply vanish.
      if (!rows.length) { head += seg; continue; }
      if (rows.length) {
        rows[rows.length - 1] = rows[rows.length - 1].replace(/<\/span><\/div>$/, `${seg}</span></div>`);
      }
      continue;
    }
    const label = plainLabel(seg.slice(0, at));
    const body = seg.slice(at).replace(/[\s:;\u2014]+$/, '');
    labels.push(label);
    rows.push(
      `<div class="lsj-form"><span class="lsj-form-label">${escapeText(label)}</span>` +
      `<span class="lsj-form-body">${body}</span></div>`,
    );
  }
  // A table whose only row has no label is not a table. διδάσκαλος and ὅλος
  // opened on such a row once the "cf." rule took their first row away: a
  // citation with nothing to label it. The preamble goes back whole, as prose.
  if (rows.length === 1 && labels[0] === '') return { html: preamble, rows: 0 };
  // Align into a label column only when the labels ARE short labels. In εἰμί a
  // single segment packs several forms of which only one is tagged, so its
  // "label" runs to half a line; a column built on that is worse than no
  // column. Those entries still get one row per form — the repair — just set
  // as lines rather than a table.
  // Judged on the bulk of the labels, not the longest: λέγω has six short ones
  // and a single "Med., fut. in pass. sense", and that one should wrap inside
  // the column rather than deny the other six their alignment. εἰμί, where the
  // long labels ARE the labels, still falls through to plain rows.
  const lengths = rows.map((row) => {
    const label = /class="lsj-form-label">([^<]*)</.exec(row);
    return label ? label[1].length : 0;
  });
  const short = lengths.filter((n) => n <= 20).length;
  const aligned = rows.length >= FORMS_MIN_ALIGNED && short / lengths.length >= 0.7;
  const cls = `lsj-forms${aligned ? ' lsj-forms-aligned' : ''}`;
  const notes = note ? `<div class="lsj-forms-note">${note}</div>` : '';
  return {
    html: `${head}<div class="${cls}">${rows.join('')}</div>${notes}`,
    rows: rows.length,
  };
}

// ── naming the other parts of an entry ──────────────────────────────────────
// Three things a reader looks for are already marked in the data and were being
// drawn identically to everything around them:
//
//  1. The DEFINITION. 56% of senses open with their gloss in italics — the one
//     line the reader actually came for, buried at the head of a paragraph.
//  2. A QUOTATION THAT IS NOT TAGGED AS ONE. A quotation comes in two shapes:
//     wrapped in .lsj-cit (87,758 of them), or as a bare .lsj-greek phrase with
//     its translation and a separate .lsj-bibl (33,430). Only the first got a
//     line, so within one sense some quotations stood out and others were
//     buried — and 17,991 senses contain both shapes.
//  3. Greek with NO source (12,810) is incidental to the prose around it and
//     is deliberately left inline.
const SENSE_OPEN_TAG = /(<div[^>]*class="lsj-sense"[^>]*>)(\s*<b class="lsj-sense-n">[\s\S]*?<\/b>)?(\s*)(<i>[\s\S]*?<\/i>)/g;
const GREEK_SPAN = /<span class="lsj-greek">[\s\S]*?<\/span>/g;

export function markEntryParts(html: string): string {
  // Only the senses. The block before them is morphology, and a "[ᾰπ]" quantity
  // mark beside a headword is not a quotation — marking it put a forced line
  // break through ἀπατάω's own head line.
  const senseAt = html.indexOf(SENSE_DIV);
  if (senseAt > 0) return html.slice(0, senseAt) + markEntryParts(html.slice(senseAt));
  if (senseAt === -1) return html;
  // A sense's opening gloss, so it can lead the sense instead of running into
  // the evidence behind it.
  let out = html.replace(SENSE_OPEN_TAG, (full, open, num, gap, gloss) =>
    `${open}${num ?? ''}${gap}<span class="lsj-def">${gloss}</span>`);

  // A Greek phrase that has a source is a quotation, whatever shape it arrived
  // in. "Has a source" means a .lsj-bibl follows before the next phrase,
  // citation or sense begins.
  out = out.replace(GREEK_SPAN, (span, at: number) => {
    const after = out.slice(at + span.length, at + span.length + 240);
    const stop = after.search(/<span class="lsj-(greek|cit)"|<div[^>]*class="lsj-sense"/);
    const window = stop === -1 ? after : after.slice(0, stop);
    if (!/class="lsj-bibl"/.test(window)) return span;
    // A quantity mark ("[ᾰπ", "ᾰ") is notation, not a quotation.
    const text = plainText(span);
    if (text.length <= 4 || /^[[(]/.test(text)) return span;
    return span.replace('<span class="lsj-greek">', '<span class="lsj-greek lsj-quoted">');
  });
  return out;
}

// ── one LSJ entry, rendered ─────────────────────────────────────────────────
// The single entry point every host uses to put an LSJ entry on screen: the
// site's lemma page and word popup, the desktop lexicon, and the sibling
// readers (plato-reader, homer-reader, classical-philosophy-reader) that copy
// this directory. Sanitize → base-prefix the citation links → optionally lift
// the top-level senses into a jump list → wrap in the class the stylesheet
// styles. Keeping all four steps here is what makes the presentation portable:
// a host supplies shard HTML and a base, and gets identical typography for
// free. Nothing in it is Aristotle-specific — see shared/README.md.
export interface RenderLsjEntryOptions {
  /** Deploy base for the shards' root-relative citation hrefs (site only). */
  base?: string;
  /** 'page' for a full-width reference view, 'popup' (default) for a sidebar. */
  scale?: 'popup' | 'page';
  /** Lift the top-level senses into a jump list above the entry. */
  outline?: boolean;
  /** Fewest top-level senses worth an outline — below it, none is rendered. */
  outlineMin?: number;
  /** Anchor-id prefix; give each entry its own when a page renders several. */
  idPrefix?: string;
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function outlineHtml(senses: LsjSenseRef[]): string {
  const items = senses
    .map(
      (sense) =>
        `<li><a href="#${sense.id}">` +
        `<span class="lsj-outline-n">${escapeText(sense.n)}</span>` +
        `<span class="lsj-outline-text">${escapeText(sense.label)}</span>` +
        '</a></li>',
    )
    .join('');
  return (
    '<nav class="lsj-outline" aria-label="Senses in this entry">' +
    `<p class="lsj-outline-label">${senses.length} main senses</p>` +
    `<ol class="lsj-outline-list">${items}</ol></nav>`
  );
}

export function renderLsjEntry(
  raw: string,
  options: RenderLsjEntryOptions = {},
): string {
  const {
    base = '',
    scale = 'popup',
    outline = false,
    outlineMin = 3,
    idPrefix = 'lsj-sense',
  } = options;
  const sanitized = prefixLsjCitationHrefs(sanitizeHtml(raw ?? ''), base);
  // An absent shard entry must render nothing at all, not an empty box: the
  // host's own `{#if}` keys off this string.
  if (!sanitized.trim()) return '';
  // Depth is stamped whether or not an outline is wanted — the word popup shows
  // no jump list but still has to indent λόγος correctly.
  // Cut the block of forms off the front and rebuild it as labelled rows, so a
  // line break lands between forms rather than between a form and its label.
  const marked = markEntryParts(sanitized);
  const senseAt = marked.indexOf(SENSE_DIV);
  let assembled = marked;
  if (senseAt !== 0) {
    const preamble = senseAt === -1 ? marked : marked.slice(0, senseAt);
    const body = senseAt === -1 ? '' : marked.slice(senseAt);
    const forms = buildFormsBlock(preamble);
    // Where the forms run past a dozen they stop being a preface and start
    // being the entry: Ποσειδῶν is 99% morphology, and a reader after a meaning
    // scrolls the whole way past it. Folded, but never on the page where the
    // reader came to read the whole entry.
    const foldable = forms.rows >= FORMS_MIN_FOLDED && scale !== 'page';
    // Fold the forms, never the word. The headword, its gender and its
    // etymology are the first thing the reader needs and were being shut
    // inside the disclosure with everything else — 103 of the 116 folds.
    const split = forms.html.indexOf('<div class="lsj-forms');
    const wordPart = split === -1 ? '' : forms.html.slice(0, split);
    const formsPart = split === -1 ? forms.html : forms.html.slice(split);
    assembled = foldable
      ? `${wordPart}<details class="lsj-forms-fold"><summary>${forms.rows} forms</summary>${formsPart}</details>${body}`
      : forms.html + body;
  }
  const depthed = stampSenseDepth(assembled);
  const { html, senses } = outline
    ? outlineLsjSenses(depthed, idPrefix, outlineMin)
    : { html: depthed, senses: [] as LsjSenseRef[] };
  const nav = senses.length >= outlineMin ? outlineHtml(senses) : '';
  const cls = scale === 'page' ? 'lsj-entry lsj-entry-page' : 'lsj-entry';
  return `<div class="${cls}">${nav}${html}</div>`;
}
