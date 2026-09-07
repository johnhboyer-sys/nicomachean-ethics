// Regression tests for the 2026-07-29 word-popup bug report (ported from
// plato-reader): with the word panel open, clicking another Greek word must
// swap the analysis in place — the old full-page backdrop swallowed that click
// and forced close/reopen with two page snaps.
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import WordPopup from '../components/WordPopup.svelte';
import { prefixLsjCitationHrefs } from '../lib/html';
import { fetchLemmata, fetchLsjHeads, lookupWord } from '../lib/data';

// The grammata widget is loaded over the network by URL; mocked here by that
// exact specifier so the site path can be exercised without it.
const { grammataLookup } = vi.hoisted(() => ({ grammataLookup: vi.fn(async () => {}) }));
vi.mock('https://grammata.pages.dev/t8/lookup.js', () => ({ lookup: grammataLookup }));

vi.mock('../lib/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/data')>();
  return {
    ...actual,
    fetchLemmata: vi.fn(async () => ({})),
    fetchLsjHeads: vi.fn(async () => ({})),
    lookupWord: vi.fn(async (_work: string, k: string) => ({
      analyses: [
        k === 'logos'
          ? { lemma: 'logos', gloss: 'word, account', parse: 'noun nom sg', lsj: [] }
          : { lemma: 'areth', gloss: 'goodness, excellence', parse: 'noun nom sg', lsj: [] },
      ],
      lsj: [],
    })),
  };
});

// The site popup defers the dictionary to grammata over the network; the
// packaged desktop app renders the bundled LSJ shards locally. WordPopup picks
// its path from __TAURI_INTERNALS__ at init, so tests must say which one they
// mean. Default to the local path: it is the one whose markup these tests
// assert, and it keeps the suite off the network. The site-path test below
// deletes the flag before rendering.
beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.clearAllMocks();
});

const baseProps = {
  work: 'EN',
  token: { t: 'λόγος', k: 'logos' },
  anchor: { x: 0, y: 0 },
};

describe('WordPopup', () => {
  it('prepends the site base to LSJ citation links', () => {
    expect(prefixLsjCitationHrefs(
      '<a class="lsj-bibl" href="/EN/book/1?loc=1094a:5">1094a5</a>',
      '/aristotle-reader',
    )).toBe(
      '<a class="lsj-bibl" href="/aristotle-reader/EN/book/1?loc=1094a:5">1094a5</a>',
    );
  });

  // The rewrite pattern matches the SANITIZED serialization, not stage5's raw
  // output — if sanitizeHtml ever reorders attributes, the rewrite misses
  // silently and readers get base-less 404 links. Lock the round trip.
  it('rewrites citation links after the sanitize round trip', async () => {
    const { sanitizeHtml } = await import('../lib/html');
    const sanitized = sanitizeHtml(
      '<a class="lsj-bibl" href="/APo/book/1?loc=71a:3">71a3</a>',
    );
    const rewritten = prefixLsjCitationHrefs(sanitized, '/aristotle-reader');
    expect(rewritten).toContain('href="/aristotle-reader/APo/book/1?loc=71a:3"');
  });

  it('is idempotent and leaves an empty or bare-slash base alone', () => {
    const html = '<a class="lsj-bibl" href="/EN/book/1?loc=1094a:5">1094a5</a>';
    const once = prefixLsjCitationHrefs(html, '/aristotle-reader');
    expect(prefixLsjCitationHrefs(once, '/aristotle-reader')).toBe(once);
    expect(prefixLsjCitationHrefs(html, '')).toBe(html);
    expect(prefixLsjCitationHrefs(html, '/')).toBe(html);
  });

  // The popup renders LSJ through the shared renderLsjEntry, so the sense
  // hierarchy has to survive into its DOM — it was stripped there too until
  // the sanitizer allowed the sense divs (2026-08-19).
  it('renders an LSJ entry with its sense hierarchy intact (desktop, local shards)', async () => {
    vi.mocked(lookupWord).mockResolvedValueOnce({
      analyses: [{ lemma: 'logos', gloss: 'word, account', parse: 'noun nom sg', lsj: ['logos'] }],
      lsj: [{
        key: 'logos',
        head: 'λόγος',
        html: '<b class="lsj-head">λόγος</b>, '
          + '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">A.</b> computation'
          + '<div class="lsj-sense" data-level="2"><b class="lsj-sense-n">I.</b> account of money'
          + '</div></div>',
      }],
    });
    const { container } = render(WordPopup, { props: { ...baseProps, onClose: vi.fn() } });
    await screen.findByText('word, account');

    // The entry now opens under the card it belongs to, so it starts closed —
    // asserting on it without tapping would pass on markup no reader can see.
    expect(container.querySelector('.card-entry')!.hasAttribute('hidden')).toBe(true);
    (container.querySelector('.card-face') as HTMLButtonElement).click();
    await tick();
    expect(container.querySelector('.card-entry')!.hasAttribute('hidden')).toBe(false);

    const entry = container.querySelector('.lsj-entry')!;
    expect(entry).toBeTruthy();
    expect(entry.querySelector('.lsj-sense[data-level="1"]')).toBeTruthy();
    // Nested, not flattened: the sub-sense sits INSIDE its parent sense.
    expect(entry.querySelector('.lsj-sense[data-level="1"] .lsj-sense[data-level="2"]'))
      .toBeTruthy();
    // The popup is a sidebar: no jump list, and no anchor ids to collide with
    // the reader's own.
    expect(entry.querySelector('.lsj-outline')).toBeNull();
    expect(entry.querySelector('[id]')).toBeNull();
  });

  it('hands the dictionary to grammata on the site, rendering no local entry', async () => {
    // The site path: no Tauri, so the popup mounts an empty container for the
    // grammata widget to fill and renders none of the shard HTML itself.
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.mocked(lookupWord).mockResolvedValueOnce({
      analyses: [{ lemma: 'logos', gloss: 'word, account', parse: 'noun nom sg', lsj: ['logos'] }],
      lsj: [{
        key: 'logos',
        head: 'λόγος',
        html: '<b class="lsj-head">λόγος</b>, computation',
      }],
    });
    const { container } = render(WordPopup, { props: { ...baseProps, onClose: vi.fn() } });
    await screen.findByText('word, account');

    // The mount point exists and the local entry does not — a regression here
    // would silently show BOTH dictionaries, or neither.
    // Closed until tapped: nothing is fetched from grammata for a reader who
    // only wanted the parse.
    expect(container.querySelector('.card-entry')!.hasAttribute('hidden')).toBe(true);
    expect(container.querySelector('.grammata-mount')).toBeTruthy();
    expect(container.querySelector('.lsj-entry')).toBeNull();
    // The reader's own analysis card stays: grammata replaces the dictionary
    // entry, not the parse, gloss and corpus-frequency link around it.
    expect(screen.getByText('noun nom sg')).toBeTruthy();
  });

  it('re-runs the lookup when the token changes (word-to-word jump)', async () => {
    const { rerender } = render(WordPopup, {
      props: { ...baseProps, onClose: vi.fn() },
    });
    await screen.findByText('word, account');

    await rerender({ token: { t: 'ἀρετή', k: 'areth' } });
    await screen.findByText('goodness, excellence');
    expect(lookupWord).toHaveBeenCalledTimes(2);
    // withLsj says whether to fetch the LSJ shard: true on the desktop, which
    // renders entries locally, false on the website, where grammata serves
    // them and a shard would be megabytes fetched to be thrown away.
    expect(lookupWord).toHaveBeenLastCalledWith('EN', 'areth', { withLsj: true });
  });

  it('closes on click outside, but not on the panel or on a Greek token', async () => {
    const tok = document.createElement('span');
    tok.className = 'tok';
    document.body.appendChild(tok);

    const onClose = vi.fn();
    render(WordPopup, { props: { ...baseProps, onClose } });
    await screen.findByText('word, account');

    // On a Greek token: the token's own handler swaps the word — no close.
    tok.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(onClose).not.toHaveBeenCalled();

    // Inside the panel: no close.
    document.querySelector('.word-sidebar')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(onClose).not.toHaveBeenCalled();

    // Anywhere else: close.
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);

    tok.remove();
  });

  it('closes even when the outside click stops propagation (footnote marker)', async () => {
    // Reader's fn-marker / Bekker-info / print-menu handlers stopPropagation();
    // the close listener runs in the capture phase so it still sees the click
    // (John's ruling 2026-07-29: a footnote click closes the word panel).
    const marker = document.createElement('button');
    marker.className = 'fn-marker';
    marker.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(marker);

    const onClose = vi.fn();
    render(WordPopup, { props: { ...baseProps, onClose } });
    await screen.findByText('word, account');

    marker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);

    marker.remove();
  });

  it('does NOT close on a bare pointerdown (touch pan / selection drag / right-click)', async () => {
    // A pan or drag produces pointerdown with no click; closing there would
    // dismiss the panel the moment a touch scroll starts (Sol review catch).
    const onClose = vi.fn();
    render(WordPopup, { props: { ...baseProps, onClose } });
    await screen.findByText('word, account');

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
    await tick();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders no click-blocking backdrop', async () => {
    render(WordPopup, { props: { ...baseProps, onClose: vi.fn() } });
    await screen.findByText('word, account');
    expect(document.querySelector('.popup-backdrop')).toBeNull();
  });

  it('renders distinctiveness_label when the lemma ref carries one', async () => {
    vi.mocked(fetchLemmata).mockResolvedValue({
      logos: { slug: 'logos', head: 'λόγος', count: 10, distinctiveness_label: 'coined by Aristotle' },
    });
    vi.mocked(lookupWord).mockResolvedValue({
      analyses: [{ lemma: 'logos', gloss: 'word, account', parse: 'noun nom sg', lsj: ['logos'] }],
      lsj: [],
    });
    render(WordPopup, { props: { ...baseProps, onClose: vi.fn() } });
    expect(await screen.findByText('coined by Aristotle')).toBeInTheDocument();
    expect(screen.getByText(/Appears 10/)).toBeInTheDocument();
  });

  it('renders no distinctiveness line when the lemma ref has none', async () => {
    vi.mocked(fetchLemmata).mockResolvedValue({
      logos: { slug: 'logos', head: 'λόγος', count: 10 },
    });
    vi.mocked(lookupWord).mockResolvedValue({
      analyses: [{ lemma: 'logos', gloss: 'word, account', parse: 'noun nom sg', lsj: ['logos'] }],
      lsj: [],
    });
    render(WordPopup, { props: { ...baseProps, onClose: vi.fn() } });
    await screen.findByText(/Appears 10/);
    expect(screen.queryByText('coined by Aristotle')).toBeNull();
    expect(screen.queryByText('rare before Aristotle')).toBeNull();
    expect(document.querySelector('.distinct-label')).toBeNull();
  });
  it('makes one card per dictionary entry, not one per analysis', async () => {
    // δεῖ's real shape: nine analyses naming three entries. Two of them are
    // LSJ homographs of δέω — "bind" and "lack" — which must stay apart, and
    // each entry's repeated parses must collapse into one card.
    const parses = [
      'pres ind mp 2nd sg', 'pres imperat act 2nd sg',
      'pres ind act 3rd sg', 'imperf ind act 3rd sg',
    ];
    vi.mocked(lookupWord).mockResolvedValueOnce({
      analyses: [
        ...parses.map(parse => ({ lemma: 'de/w1', gloss: 'bind', parse, lsj: ['de/w1'] })),
        ...parses.map(parse => ({ lemma: 'de/w2', gloss: 'lack', parse, lsj: ['de/w2'] })),
        { lemma: 'dei=', gloss: 'there is need', parse: 'imperf ind act 3rd sg', lsj: ['dei='] },
      ],
      lsj: [
        { key: 'de/w1', head: 'δέω', html: '<b class="lsj-head">δέω</b> (A), bind' },
        { key: 'de/w2', head: 'δέω', html: '<b class="lsj-head">δέω</b> (B), lack' },
        { key: 'dei=', head: 'δεῖ', html: '<b class="lsj-head">δεῖ</b>, there is need' },
      ],
    });
    const { container } = render(WordPopup, { props: { ...baseProps, onClose: vi.fn() } });
    await screen.findByText('bind');

    const cards = container.querySelectorAll('.analysis-card');
    expect(cards.length).toBe(3);
    // LSJ's own letter, read from the entry text — never derived from the key's
    // trailing digit, which disagrees with LSJ on six entries.
    expect(cards[0].querySelector('.lemma')!.textContent).toContain('(A)');
    expect(cards[1].querySelector('.lemma')!.textContent).toContain('(B)');
    expect(cards[2].querySelector('.lemma-hom')).toBeNull();
    // Four parses on each δέω card, one on δεῖ — no repeats.
    expect(cards[0].querySelectorAll('.parse-rows dt').length).toBe(4);
    expect(cards[2].querySelectorAll('.parse-rows dt').length).toBe(1);
  });

  it('takes each card gloss from an analysis that names only that entry', async () => {
    // νοῦν's real shape, and the case that breaks a first-wins gloss: the FIRST
    // analysis is an unresolved νέω naming all three numbered entries at once,
    // with the gloss of only one of them. Its gloss must not be stamped on the
    // other two — a card reading "swim" that opens the entry for "spin" is
    // worse than the seventeen cards this grouping replaced.
    const p = 'imperf ind act 1st sg';
    vi.mocked(lookupWord).mockResolvedValueOnce({
      analyses: [
        { lemma: 'ne/w', gloss: 'swim', parse: p, lsj: ['ne/w1', 'ne/w2', 'ne/w3'] },
        { lemma: 'ne/w1', gloss: 'swim', parse: p, lsj: ['ne/w1'] },
        { lemma: 'ne/w2', gloss: 'spin', parse: p, lsj: ['ne/w2'] },
        { lemma: 'ne/w3', gloss: 'heap, pile up', parse: p, lsj: ['ne/w3'] },
        { lemma: 'no/os', gloss: 'mind', parse: 'masc acc sg (attic)', lsj: ['no/os'] },
      ],
      lsj: [
        { key: 'ne/w1', head: 'νέω', html: '<b class="lsj-head">νέω</b> (A), swim' },
        { key: 'ne/w2', head: 'νέω', html: '<b class="lsj-head">νέω</b> (B), spin' },
        { key: 'ne/w3', head: 'νέω', html: '<b class="lsj-head">νέω</b> (C), heap' },
        { key: 'no/os', head: 'νόος', html: '<b class="lsj-head">νόος</b>, mind' },
      ],
    });
    const { container } = render(WordPopup, { props: { ...baseProps, onClose: vi.fn() } });
    await screen.findByText('mind');

    const glosses = [...container.querySelectorAll('.analysis-card .gloss')]
      .map(e => e.textContent);
    expect(glosses).toEqual(['swim', 'spin', 'heap, pile up', 'mind']);
  });

  it('prefers a real gloss over an empty one from the same entry', async () => {
    // οἰκοδόμου: two analyses of oi)kodo/mos, the first glossed "". Marking the
    // card exact on that first one froze it blank and ignored the real gloss
    // behind it — 92 tokens in the corpus. Order must not decide this.
    vi.mocked(lookupWord).mockResolvedValueOnce({
      analyses: [
        { lemma: 'oi)ko/domos', gloss: '', parse: 'masc gen sg', lsj: ['oi)kodo/mos'] },
        { lemma: 'oi)kodo/mos', gloss: 'builder, architect', parse: 'masc gen sg', lsj: ['oi)kodo/mos'] },
      ],
      lsj: [{ key: 'oi)kodo/mos', head: 'οἰκοδόμος', html: '<b class="lsj-head">οἰκοδόμος</b>' }],
    });
    const { container } = render(WordPopup, { props: { ...baseProps, onClose: vi.fn() } });
    await screen.findByText('builder, architect');
    expect(container.querySelectorAll('.analysis-card').length).toBe(1);
  });

  it('does not let a fanned-out gloss stand in for an entry with none', async () => {
    // δύσει: du/w1 "two" fans out onto du/w2, whose own analysis has no gloss.
    // Blank is honest; "two" is a different verb's meaning wearing this card.
    vi.mocked(lookupWord).mockResolvedValueOnce({
      analyses: [
        { lemma: 'du/w', gloss: 'two', parse: 'fut ind act 3rd sg', lsj: ['du/w1', 'du/w2'] },
        { lemma: 'du/w2', gloss: '', parse: 'fut ind act 3rd sg', lsj: ['du/w2'] },
      ],
      lsj: [
        { key: 'du/w1', head: 'δύω', html: '<b class="lsj-head">δύω</b> (A), two' },
        { key: 'du/w2', head: 'δύω', html: '<b class="lsj-head">δύω</b> (B), plunge' },
      ],
    });
    const { container } = render(WordPopup, { props: { ...baseProps, onClose: vi.fn() } });
    await screen.findByText('two');
    const glosses = [...container.querySelectorAll('.analysis-card .gloss')].map(e => e.textContent);
    expect(glosses).toEqual(['two', '']);
  });

  // The three gloss rules (HANDOFF-LSJ §4), each proved in BOTH orders: a
  // non-empty exact gloss wins; an empty exact clears a fanned-out gloss but
  // never a real one; a fan-out only fills a hole.
  // Cards keyed by LSJ key: the heads manifest is mocked to spell each key as
  // itself, so two homographs (νέω A / νέω B) can be told apart in the DOM.
  const glossesFor = async (analyses: { lemma: string; gloss: string; lsj: string[] }[]) => {
    const keys = [...new Set(analyses.flatMap((a) => a.lsj))];
    vi.mocked(fetchLsjHeads).mockResolvedValue(Object.fromEntries(keys.map((k) => [k, { head: k }])));
    vi.mocked(lookupWord).mockResolvedValueOnce({
      analyses: analyses.map((a) => ({ ...a, parse: `parse of ${a.lemma}` })),
      lsj: [],
    });
    const { container, unmount } = render(WordPopup, { props: { ...baseProps, onClose: vi.fn() } });
    await screen.findAllByText(/parse of/);
    // The manifest lands a tick after the analyses; wait for the heads.
    await vi.waitFor(() => {
      for (const k of keys) expect(screen.getByText(k)).toBeTruthy();
    });
    const out = [...container.querySelectorAll('.analysis-card')]
      .map((c) => [c.querySelector('.lemma')!.textContent, c.querySelector('.gloss')!.textContent]);
    unmount();
    return Object.fromEntries(out);
  };
  const bothOrders = async (analyses: { lemma: string; gloss: string; lsj: string[] }[]) => {
    const forward = await glossesFor(analyses);
    const reversed = await glossesFor([...analyses].reverse());
    expect(reversed).toEqual(forward);
    return forward;
  };

  it('lets a non-empty exact gloss win over a fan-out, in either order', async () => {
    const out = await bothOrders([
      { lemma: 'ne/w', gloss: 'swim', lsj: ['ne/w1', 'ne/w2'] },
      { lemma: 'ne/w2', gloss: 'spin', lsj: ['ne/w2'] },
    ]);
    // ne/w1 has only the fan-out: it fills the hole. ne/w2's own gloss wins.
    expect(out).toEqual({ 'ne/w1': 'swim', 'ne/w2': 'spin' });
  });

  it('lets an empty exact clear a fanned-out gloss, in either order', async () => {
    const out = await bothOrders([
      { lemma: 'du/w', gloss: 'two', lsj: ['du/w1', 'du/w2'] },
      { lemma: 'du/w2', gloss: '', lsj: ['du/w2'] },
    ]);
    expect(out).toEqual({ 'du/w1': 'two', 'du/w2': '' });
  });

  it('never lets an empty exact clear a real exact gloss, in either order', async () => {
    const out = await bothOrders([
      { lemma: 'oi)kodo/mos', gloss: '', lsj: ['oi)kodo/mos'] },
      { lemma: 'oi)kodo/mos', gloss: 'builder, architect', lsj: ['oi)kodo/mos'] },
    ]);
    expect(out).toEqual({ 'oi)kodo/mos': 'builder, architect' });
  });

  it('lets a fan-out fill a hole but never overwrite, in either order', async () => {
    // Two fan-outs and no exact: the card keeps the first gloss it was given,
    // and a later fan-out never replaces it. The corpus has no such token
    // (order-independence was proved over all 122,540), so only the
    // "never overwrite" half is a rule; the tie is pinned as first-wins.
    const single = await glossesFor([
      { lemma: 'x', gloss: 'first', lsj: ['x1', 'x2'] },
      { lemma: 'x', gloss: 'second', lsj: ['x1', 'x3'] },
    ]);
    expect(single).toEqual({ x1: 'first', x2: 'first', x3: 'second' });
    // With an exact empty on x1 as well, the fan-out cannot fill it back.
    const cleared = await bothOrders([
      { lemma: 'x1', gloss: '', lsj: ['x1'] },
      { lemma: 'x', gloss: 'first', lsj: ['x1', 'x2'] },
    ]);
    expect(cleared).toEqual({ x1: '', x2: 'first' });
  });

  it('hands grammata the LSJ key, never the surface form', async () => {
    // grammata re-analyses a surface form from scratch and discards this
    // reader's disambiguation (εἰσὶ came back ἵημι-first). With a key the word
    // argument is ignored, so it is passed empty; only an analysis with no
    // entry at all sends the Unicode LEMMA (never token.t).
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const lookup = grammataLookup;
    vi.mocked(lookupWord).mockResolvedValueOnce({
      analyses: [
        { lemma: 'ei)mi/', gloss: 'to be', parse: 'pres ind act 3rd pl', lsj: ['ei)mi/'] },
        { lemma: 'ei)=mi', gloss: 'to go', parse: 'pres ind act 3rd pl', lsj: [] },
      ],
      lsj: [],
    });
    const { container } = render(WordPopup, {
      props: { ...baseProps, token: { t: 'εἰσὶ', k: 'eisi' }, onClose: vi.fn() },
    });
    await screen.findByText('to be');
    const faces = container.querySelectorAll<HTMLButtonElement>('.card-face');
    faces[0].click();
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    expect(lookup).toHaveBeenLastCalledWith('', expect.any(HTMLElement), { lang: 'grc', key: 'ei)mi/' });
    faces[1].click();
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    const [word, , opts] = lookup.mock.calls[1] as unknown as [string, HTMLElement, { key?: string }];
    expect(word).toBe('εἶμι');
    expect(word).not.toBe('εἰσὶ');
    expect(opts).toEqual({ lang: 'grc' });
  });

  it('prints a dialect only where the form has no Attic reading', async () => {
    // Aristotle is Attic, so "(attic epic ionic)" says nothing a reader needs.
    // "(doric)" says the reading is not available in Aristotle's own dialect.
    vi.mocked(lookupWord).mockResolvedValueOnce({
      analyses: [
        { lemma: 'o(/moios', gloss: 'like', parse: 'masc acc pl (attic epic ionic)', lsj: ['o(/moios'] },
        { lemma: 'o(/moios', gloss: 'like', parse: 'masc/fem acc pl (doric)', lsj: ['o(/moios'] },
        { lemma: 'o(/moios', gloss: 'like', parse: 'fem dat sg (epic ionic)', lsj: ['o(/moios'] },
      ],
      lsj: [{ key: 'o(/moios', head: 'ὅμοιος', html: '<b class="lsj-head">ὅμοιος</b>, like' }],
    });
    const { container } = render(WordPopup, { props: { ...baseProps, onClose: vi.fn() } });
    await screen.findByText('like');

    expect(container.querySelectorAll('.analysis-card').length).toBe(1);
    const dd = [...container.querySelectorAll('.parse-rows dd')].map(e => e.textContent);
    expect(dd[0]).toBe('');            // has attic — silent
    expect(dd[1]).toBe('doric only');  // one dialect, no attic
    expect(dd[2]).toBe('epic ionic');  // two dialects, still no attic
    // The dialect is stripped from the parse text itself, not left doubled.
    expect(container.querySelector('.parse-rows dt')!.textContent).toBe('masc acc pl');
  });
});
