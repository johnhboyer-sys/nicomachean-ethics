// The corpus registry — the single source of truth for which works the site
// carries. Adding a work is one entry here (plus its pipeline data under
// build/dist/<id>/). Everything else — routing, the home index, the reader's
// work switcher, unified search — is driven off this list.
//
// `id` is the URL slug AND the data directory name; it uses the standard
// scholarly abbreviation (EN = Ethica Nicomachea, DA = De Anima).
//
// `translations[].slot` says which emitted segment field the reader renders for
// that translation: 'english' is the primary parallel chunk (Rackham / Smith),
// 'secondary' the chapter-anchored overlay (Wallace / Owen / Taylor), 'third' an
// optional third overlay (e.g. Ackrill), and 'overlay' any further overlay
// (4th onward) read from seg.overlays[id] — so a work can carry any number of
// translations. The picker lists them in registry order.

export interface TranslationRef {
  id: string;
  name: string;     // full citation, for the picker + attribution
  short: string;    // chip label
  slot: 'english' | 'secondary' | 'third' | 'overlay';
  // Carries inline `[^N]` footnote markers + a footnotes.json popup map (e.g.
  // the Isagoge's Owen). Independent of slot — the reader renders the markers
  // for whichever translation sets this.
  footnotes?: boolean;
  // Copyright-encumbered translations carried only in the local/full build.
  // They are in the registry only when PUBLIC_SHOW_PRIVATE=1 (see SHOW_PRIVATE
  // below); the public deploy forces it off (and is built from the work's
  // -public manifest, so their text is absent too).
  private?: boolean;
}

// A gap in a work's book sequence worth annotating in the reader. The Eudemian
// Ethics is numbered I–VIII, but Books IV–VI are the "common books" — they ARE
// Nicomachean Ethics V–VII and are not reprinted in the Eudemian text. We carry
// the five Eudemian-proper books as contiguous indices 1..5 (labels I/II/III/
// VII/VIII) and show this note where the missing books would fall, linking to
// the other work.
export interface MissingBooks {
  after: number;      // render the note after this (contiguous) book index
  label: string;      // the missing books' labels, e.g. 'IV–VI'
  note: string;       // one line explaining the gap
  linkWork: string;   // id of the work that carries the text (e.g. 'EN')
  linkBook: number;   // book to jump to in that work
  linkLabel: string;  // link text, e.g. 'Nicomachean Ethics V–VII'
}

export interface Work {
  id: string;       // slug + data dir, e.g. 'EN'
  title: string;
  greekTitle?: string;  // polytonic Greek title, shown in the print masthead
  abbr: string;     // display abbreviation (may differ from id styling)
  author: string;
  books: number;
  bookLabels: string[];   // per-book display labels (Roman for EN, Arabic for DA)
  missingBooks?: MissingBooks;  // annotate a gap in the book sequence (EE)
  greekEdition: string;
  // The print edition the TLG text was digitised from, in two lengths: `short`
  // for the reader's bilingual strip, `full` for the Greek-only strip and the
  // Texts & Licences page (both driven off this one field so they can't drift).
  greekSource: { short: string; full: string };
  translations: TranslationRef[];
  // Which translation the reader shows by default (a translations[].id). When
  // omitted the reader falls back to the primary 'english'-slot translation.
  // Used to surface a preferred overlay (e.g. NE → Ostwald) on first load.
  defaultTranslation?: string;
  blurb: string;    // one line for the home index
  // Most works are cited by Bekker (column:line). A non-Bekker treatise (e.g.
  // Porphyry's Isagoge) sets scheme:'busse' so the reader drops the per-page
  // reference and the per-line Greek numbers; its section headings come from
  // chapter-titles.json. Default (omitted) = bekker.
  citation?: { scheme: 'bekker' | 'busse'; hideLineNumbers?: boolean };
  // Cross-links to closely related works (e.g. the Isagoge ↔ the Categories it
  // introduces), shown on the landing page. Each `id` must be a built work.
  related?: { id: string; label: string }[];
  // Ancient commentaries/introductions hosted on the site that comment on THIS
  // work (ids of built works), surfaced in a "Commentary" section on the
  // landing page. The Categories carries Porphyry's Isagoge.
  commentaries?: string[];
  /** Authorship status. Absent ⇒ genuine. Drives the homepage/landing badge. */
  authenticity?: 'genuine' | 'dubious' | 'spurious';
}

export const AUTHENTICITY_LABEL: Record<'dubious' | 'spurious', string> = {
  dubious: 'Dubious',
  spurious: 'Spurious',
};

const ROMAN = ['I','II','III','IV','V','VI','VII','VIII','IX','X'];

// Copyright-encumbered translations are carried ONLY when a build explicitly
// opts in via PUBLIC_SHOW_PRIVATE=1 — the `npm run dev` script sets it, so they
// show locally. Every production build (plain `npm run build` AND the public
// deploy, which forces it off) leaves it unset, so private entries — and their
// citations — are dropped from the bundle. This is fail-SAFE: a forgotten flag
// hides private content rather than leaking text we can't host.
// (It's a compile-time constant — Vite inlines import.meta.env.PUBLIC_* — so the
// minifier drops the gated entries entirely, not just at runtime.)
const SHOW_PRIVATE = import.meta.env.PUBLIC_SHOW_PRIVATE === '1';
const ACKRILL: TranslationRef[] = SHOW_PRIVATE ? [
  { id: 'ackrill', name: 'J. L. Ackrill (Oxford, 1963)', short: 'Ackrill', slot: 'third', private: true },
] : [];
// Rackham's Loeb (1935) Eudemian Ethics is US-copyright until ~2031; carried as
// the secondary overlay in the local build, gated out of the public deploy.
const EE_RACKHAM: TranslationRef[] = SHOW_PRIVATE ? [
  { id: 'rackham', name: 'H. Rackham (Loeb, 1935)', short: 'Rackham', slot: 'secondary', private: true },
] : [];

// Display order follows the traditional arrangement of the corpus: the Organon
// (Categories, De Interpretatione, …) first, then De Anima, Metaphysics, the
// Ethics, Politics, Rhetoric, and Poetics. Everything else keys off `id`, so
// this array's order only controls the home index, search, and work switcher.
export const WORKS: Work[] = [
  {
    id: 'Cat',
    title: 'Categories',
    greekTitle: 'Κατηγορίαι',
    abbr: 'Cat.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'Minio-Paluello, Aristotelis Categoriae (OCT, 1949)',
    greekSource: {
      short: 'Minio-Paluello (OCT, 1949)',
      full: 'L. Minio-Paluello, ed. Aristotelis categoriae et liber de interpretatione. Oxford: Clarendon Press, 1949.',
    },
    // Edghill (1928) + Taylor (1812) are public domain and ship publicly. Ackrill
    // (1963) is US-copyright: carried in Cat.yaml for the local build and gated
    // out of the public deploy (private flag + Cat-public.yaml). All three are
    // keyed to Bekker via Ackrill's per-paragraph stamps.
    translations: [
      { id: 'edghill', name: 'E. M. Edghill (Oxford, 1928)', short: 'Edghill', slot: 'english' },
      { id: 'taylor', name: 'Thomas Taylor (London, 1812)', short: 'Taylor', slot: 'secondary' },
      ...ACKRILL,   // present only when PUBLIC_SHOW_PRIVATE=1 (see SHOW_PRIVATE above)
      { id: 'owen', name: 'O. F. Owen (Bohn, 1853)', short: 'Owen', slot: 'overlay' },
    ],
    commentaries: ['Isa'],
    blurb: 'Aristotle on the ten kinds of predication — the opening work of the Organon.',
  },
  {
    id: 'Int',
    title: 'De Interpretatione',
    greekTitle: 'Περὶ ἑρμηνείας',
    abbr: 'Int.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'Minio-Paluello, Aristotelis De Interpretatione (OCT, 1949)',
    greekSource: {
      short: 'Minio-Paluello (OCT, 1949)',
      full: 'L. Minio-Paluello, ed. Aristotelis categoriae et liber de interpretatione. Oxford: Clarendon Press, 1949.',
    },
    // Edghill (1928) + Taylor (1812) public domain; Ackrill (1963) US-copyright,
    // local build only (same gating as Categories). Taylor ch14 reconstructed
    // from the 1812 Organon scan (CLAA's ch14 page was a broken duplicate).
    translations: [
      { id: 'edghill', name: 'E. M. Edghill (Oxford, 1928)', short: 'Edghill', slot: 'english' },
      { id: 'taylor', name: 'Thomas Taylor (London, 1812)', short: 'Taylor', slot: 'secondary' },
      ...ACKRILL,   // present only when PUBLIC_SHOW_PRIVATE=1 (see SHOW_PRIVATE above)
      { id: 'owen', name: 'O. F. Owen (Bohn, 1853)', short: 'Owen', slot: 'overlay' },
    ],
    blurb: 'Aristotle on statements, truth, negation, and future contingents — the second work of the Organon.',
  },
  {
    id: 'Isa',
    title: 'Isagoge',
    greekTitle: 'Εἰσαγωγή',
    abbr: 'Isag.',
    author: 'Porphyry',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'Busse, Porphyrii Isagoge (CAG IV.1, 1887)',
    greekSource: {
      short: 'Busse (CAG IV.1, 1887)',
      full: 'A. Busse, ed. Porphyrii Isagoge et in Aristotelis Categorias commentarium. Commentaria in Aristotelem Graeca IV.1. Berlin: Reimer, 1887.',
    },
    // Porphyry's introduction to Aristotle's Categories; cited by Busse page,
    // not Bekker. Owen (1853) is public domain and translated from the Greek.
    translations: [
      { id: 'owen', name: 'O. F. Owen (Bohn, 1853)', short: 'Owen', slot: 'english', footnotes: true },
    ],
    citation: { scheme: 'busse', hideLineNumbers: true },
    related: [{ id: 'Cat', label: 'Aristotle’s Categories — the work it introduces' }],
    blurb: 'Porphyry’s introduction to the five predicables — the standard late-antique gateway to the Categories and the whole Organon.',
  },
  {
    id: 'Phys',
    title: 'Physics',
    greekTitle: 'Φυσικὴ ἀκρόασις',
    abbr: 'Phys.',
    author: 'Aristotle',
    books: 8,
    bookLabels: ROMAN.slice(0, 8),
    greekEdition: 'Ross, Aristotelis Physica (OCT, 1950)',
    greekSource: {
      short: 'Ross (OCT, 1950)',
      full: 'W. D. Ross, ed. Aristotelis Physica. Oxford: Clarendon Press (Oxford Classical Texts), 1950.',
    },
    translations: [
      { id: 'hardie', name: 'R. P. Hardie and R. K. Gaye (Oxford, 1930)', short: 'Hardie & Gaye', slot: 'english' },
    ],
    blurb: 'Aristotle on nature, change, place, time, and the prime mover, in eight books.',
  },
  {
    id: 'Cael',
    title: 'On the Heavens',
    greekTitle: 'Περὶ οὐρανοῦ',
    abbr: 'Cael.',
    author: 'Aristotle',
    books: 4,
    bookLabels: ROMAN.slice(0, 4),
    greekEdition: 'Moraux, Aristote: Du ciel (Budé, 1965)',
    greekSource: {
      short: 'Moraux (Budé, 1965)',
      full: 'P. Moraux, ed. Aristote: Du ciel. Paris: Les Belles Lettres (Budé), 1965.',
    },
    translations: [
      { id: 'stocks', name: 'J. L. Stocks (Oxford, 1922)', short: 'Stocks', slot: 'english' },
    ],
    blurb: 'Aristotle on the cosmos, the elements, and the eternity of the heavens, in four books.',
  },
  {
    id: 'GC',
    title: 'On Generation and Corruption',
    greekTitle: 'Περὶ γενέσεως καὶ φθορᾶς',
    abbr: 'GC',
    author: 'Aristotle',
    books: 2,
    bookLabels: ROMAN.slice(0, 2),
    greekEdition: 'Joachim, Aristotelis De Generatione et Corruptione (Oxford, 1922)',
    greekSource: {
      short: 'Joachim (Oxford, 1922)',
      full: 'H. H. Joachim, ed. Aristotle on Coming-to-be and Passing-away (De Generatione et Corruptione). Oxford: Clarendon Press, 1922.',
    },
    translations: [
      { id: 'joachim', name: 'H. H. Joachim (Oxford, 1922)', short: 'Joachim', slot: 'english' },
    ],
    blurb: 'Aristotle on coming-to-be, passing-away, mixture, and the elements, in two books.',
  },
  {
    id: 'Mete',
    title: 'Meteorology',
    greekTitle: 'Μετεωρολογικά',
    abbr: 'Mete.',
    author: 'Aristotle',
    books: 4,
    bookLabels: ROMAN.slice(0, 4),
    greekEdition: 'Fobes, Aristotelis Meteorologicorum libri quattuor (1919)',
    greekSource: {
      short: 'Fobes (1919)',
      full: 'F. H. Fobes, ed. Aristotelis meteorologicorum libri quattuor. Cambridge, Mass.: Harvard University Press, 1919; repr. 1967.',
    },
    translations: [
      { id: 'webster', name: 'E. W. Webster (Oxford, 1923)', short: 'Webster', slot: 'english' },
    ],
    blurb: 'Aristotle on the phenomena of the upper air and the earth — weather, comets, rivers, and the sea, in four books.',
  },
  {
    id: 'DA',
    title: 'De Anima',
    greekTitle: 'Περὶ ψυχῆς',
    abbr: 'DA',
    author: 'Aristotle',
    books: 3,
    bookLabels: ['I', 'II', 'III'],
    greekEdition: 'Ross, Aristotelis De Anima (OCT, 1956)',
    greekSource: {
      short: 'Ross (OCT, 1956)',
      full: 'W. D. Ross, ed. Aristotle, De Anima. Oxford: Clarendon Press (Oxford Classical Texts), 1956.',
    },
    // Wallace (Cambridge, 1882) is public domain and a Tier 0 secondary: chapter
    // divisions match the Greek spine exactly (5/12/13), no anchors file.
    translations: [
      { id: 'smith', name: 'J. A. Smith (Oxford, 1931)', short: 'Smith', slot: 'english' },
      { id: 'wallace', name: 'Edwin Wallace (Cambridge, 1882)', short: 'Wallace', slot: 'secondary' },
    ],
    blurb: 'Aristotle on the soul, perception, and intellect, in three books.',
  },
  // The Parva Naturalia — Aristotle's short treatises on psycho-physical
  // topics. All single-book (bookless) works whose TLG Greek comes from Ross's
  // OCT Parva Naturalia (1955); the Oxford translations (Beare / G. R. T. Ross,
  // 1908) are public domain. "On Youth…" (Juv) splices the TLG's De juventute
  // and De respiratione into one continuous treatise (see manifests/Juv.yaml).
  {
    id: 'Sens',
    title: 'Sense and Sensibilia',
    greekTitle: 'Περὶ αἰσθήσεως καὶ αἰσθητῶν',
    abbr: 'Sens.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'Ross, Aristotle: Parva Naturalia (OCT, 1955)',
    greekSource: {
      short: 'Ross (OCT, 1955)',
      full: 'W. D. Ross, ed. Aristotle: Parva Naturalia. Oxford: Clarendon Press, 1955; repr. 1970.',
    },
    translations: [
      { id: 'beare', name: 'J. I. Beare (Oxford, 1908)', short: 'Beare', slot: 'english' },
    ],
    blurb: 'Aristotle on perception and its objects — colour, sound, flavour, and smell.',
  },
  {
    id: 'Mem',
    title: 'On Memory',
    greekTitle: 'Περὶ μνήμης καὶ ἀναμνήσεως',
    abbr: 'Mem.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'Ross, Aristotle: Parva Naturalia (OCT, 1955)',
    greekSource: {
      short: 'Ross (OCT, 1955)',
      full: 'W. D. Ross, ed. Aristotle: Parva Naturalia. Oxford: Clarendon Press, 1955; repr. 1970.',
    },
    translations: [
      { id: 'beare', name: 'J. I. Beare (Oxford, 1908)', short: 'Beare', slot: 'english' },
    ],
    blurb: 'Aristotle on memory and recollection.',
  },
  {
    id: 'Somn',
    title: 'On Sleep',
    greekTitle: 'Περὶ ὕπνου καὶ ἐγρηγόρσεως',
    abbr: 'Somn.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'Ross, Aristotle: Parva Naturalia (OCT, 1955)',
    greekSource: {
      short: 'Ross (OCT, 1955)',
      full: 'W. D. Ross, ed. Aristotle: Parva Naturalia. Oxford: Clarendon Press, 1955; repr. 1970.',
    },
    translations: [
      { id: 'beare', name: 'J. I. Beare (Oxford, 1908)', short: 'Beare', slot: 'english' },
    ],
    blurb: 'Aristotle on sleep and waking.',
  },
  {
    id: 'Insomn',
    title: 'On Dreams',
    greekTitle: 'Περὶ ἐνυπνίων',
    abbr: 'Insom.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'Ross, Aristotle: Parva Naturalia (OCT, 1955)',
    greekSource: {
      short: 'Ross (OCT, 1955)',
      full: 'W. D. Ross, ed. Aristotle: Parva Naturalia. Oxford: Clarendon Press, 1955; repr. 1970.',
    },
    translations: [
      { id: 'beare', name: 'J. I. Beare (Oxford, 1908)', short: 'Beare', slot: 'english' },
    ],
    blurb: 'Aristotle on dreams and their causes.',
  },
  {
    id: 'DivSomn',
    title: 'On Divination in Sleep',
    greekTitle: 'Περὶ τῆς καθ᾽ ὕπνον μαντικῆς',
    abbr: 'Div. Somn.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'Ross, Aristotle: Parva Naturalia (OCT, 1955)',
    greekSource: {
      short: 'Ross (OCT, 1955)',
      full: 'W. D. Ross, ed. Aristotle: Parva Naturalia. Oxford: Clarendon Press, 1955; repr. 1970.',
    },
    translations: [
      { id: 'beare', name: 'J. I. Beare (Oxford, 1908)', short: 'Beare', slot: 'english' },
    ],
    blurb: 'Aristotle on prophecy and divination through dreams.',
  },
  {
    id: 'Long',
    title: 'On Length and Shortness of Life',
    greekTitle: 'Περὶ μακροβιότητος καὶ βραχυβιότητος',
    abbr: 'Long.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'Ross, Aristotle: Parva Naturalia (OCT, 1955)',
    greekSource: {
      short: 'Ross (OCT, 1955)',
      full: 'W. D. Ross, ed. Aristotle: Parva Naturalia. Oxford: Clarendon Press, 1955; repr. 1970.',
    },
    translations: [
      { id: 'ross', name: 'G. R. T. Ross (Oxford, 1908)', short: 'Ross', slot: 'english' },
    ],
    blurb: 'Aristotle on why some living things are long-lived and others short-lived.',
  },
  {
    id: 'Juv',
    title: 'On Youth, Old Age, Life and Death, and Respiration',
    greekTitle: 'Περὶ νεότητος καὶ γήρως καὶ ζωῆς καὶ θανάτου καὶ περὶ ἀναπνοῆς',
    abbr: 'Juv.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'Ross, Aristotle: Parva Naturalia (OCT, 1955)',
    greekSource: {
      short: 'Ross (OCT, 1955)',
      full: 'W. D. Ross, ed. Aristotle: Parva Naturalia. Oxford: Clarendon Press, 1955; repr. 1970.',
    },
    translations: [
      { id: 'ross', name: 'G. R. T. Ross (Oxford, 1908)', short: 'Ross', slot: 'english' },
    ],
    blurb: 'Aristotle on youth and old age, life and death, and the role of respiration.',
  },
  {
    id: 'HA',
    title: 'History of Animals',
    greekTitle: 'Περὶ τὰ ζῷα ἱστορίαι',
    abbr: 'HA',
    author: 'Aristotle',
    // The TLG/Bekker text carries ten books, but Book X (on the causes of
    // sterility) is spurious and untranslated; like modern editions we present
    // the genuine Books I–IX.
    books: 9,
    bookLabels: ROMAN.slice(0, 9),
    greekEdition: 'Louis, Aristote: Histoire des animaux (Budé, 1964–69)',
    greekSource: {
      short: 'Louis (Budé, 1964–69)',
      full: 'P. Louis, ed. Aristote: Histoire des animaux. 3 vols. Paris: Les Belles Lettres (Budé), 1964–69.',
    },
    translations: [
      { id: 'thompson', name: 'D’Arcy Wentworth Thompson (Oxford, 1910)', short: 'Thompson', slot: 'english' },
    ],
    blurb: 'Aristotle’s great survey of animal life — anatomy, reproduction, habits, and behaviour — in nine books.',
  },
  {
    id: 'PA',
    title: 'Parts of Animals',
    greekTitle: 'Περὶ ζῴων μορίων',
    abbr: 'PA',
    author: 'Aristotle',
    books: 4,
    bookLabels: ROMAN.slice(0, 4),
    greekEdition: 'Louis, Aristote: Les parties des animaux (Budé, 1956)',
    greekSource: {
      short: 'Louis (Budé, 1956)',
      full: 'P. Louis, ed. Aristote: Les parties des animaux. Paris: Les Belles Lettres (Budé), 1956.',
    },
    translations: [
      { id: 'ogle', name: 'William Ogle (Oxford, 1912)', short: 'Ogle', slot: 'english' },
    ],
    blurb: 'Aristotle’s study of the causes and functions of animal parts — the foundational work of his biology — in four books.',
  },
  {
    id: 'MA',
    title: 'Movement of Animals',
    greekTitle: 'Περὶ ζῴων κινήσεως',
    abbr: 'MA',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'Jaeger, Aristotelis De animalium motione (Teubner, 1913)',
    greekSource: {
      short: 'Jaeger (Teubner, 1913)',
      full: 'W. Jaeger, ed. Aristotelis de animalium motione et de animalium incessu. Leipzig: Teubner, 1913.',
    },
    translations: [
      { id: 'farquharson', name: 'A. S. L. Farquharson (Oxford, 1912)', short: 'Farquharson', slot: 'english' },
    ],
    blurb: 'Aristotle on the common cause of all animal locomotion — what moves the moving animal.',
  },
  {
    id: 'IA',
    title: 'Progression of Animals',
    greekTitle: 'Περὶ πορείας ζῴων',
    abbr: 'IA',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'Jaeger, Aristotelis De animalium incessu (Teubner, 1913)',
    greekSource: {
      short: 'Jaeger (Teubner, 1913)',
      full: 'W. Jaeger, ed. Aristotelis de animalium motione et de animalium incessu. Leipzig: Teubner, 1913.',
    },
    translations: [
      { id: 'farquharson', name: 'A. S. L. Farquharson (Oxford, 1912)', short: 'Farquharson', slot: 'english' },
    ],
    blurb: 'Aristotle on the parts animals use to move — why they have the number and kind of limbs they do.',
  },
  {
    id: 'GA',
    title: 'Generation of Animals',
    greekTitle: 'Περὶ ζῴων γενέσεως',
    abbr: 'GA',
    author: 'Aristotle',
    books: 5,
    bookLabels: ROMAN.slice(0, 5),
    greekEdition: 'Drossaart Lulofs, Aristotelis De Generatione Animalium (OCT, 1965)',
    greekSource: {
      short: 'Drossaart Lulofs (OCT, 1965)',
      full: 'H. J. Drossaart Lulofs, ed. Aristotelis de generatione animalium. Oxford: Clarendon Press (Oxford Classical Texts), 1965; repr. 1972.',
    },
    translations: [
      { id: 'platt', name: 'Arthur Platt (Oxford, 1910)', short: 'Platt', slot: 'english' },
    ],
    blurb: 'Aristotle on animal reproduction — the sexes, semen, heredity, and the formation of the embryo — in five books.',
  },
  {
    id: 'Meta',
    title: 'Metaphysics',
    greekTitle: 'Τὰ μετὰ τὰ φυσικά',
    abbr: 'Met.',
    author: 'Aristotle',
    books: 14,
    // Scholarly convention labels the books by Greek letter; Book 2 is the
    // "lesser alpha" (α elatton), distinct from Book 1 (Α).
    bookLabels: ['Α','α','Β','Γ','Δ','Ε','Ζ','Η','Θ','Ι','Κ','Λ','Μ','Ν'],
    greekEdition: 'Ross, Aristotle’s Metaphysics (OCT, 1924)',
    greekSource: {
      short: 'Ross (OCT, 1953)',
      full: 'W. D. Ross, ed. Aristotle’s Metaphysics. 2 vols. Oxford: Clarendon Press, 1953.',
    },
    // Public build ships the public-domain Ross (1924) only. The copyrighted
    // Tredennick (Loeb 1933) primary + aligned-Ross overlay live in Meta.yaml
    // for the local/private build and are NOT deployed (see publish-plan).
    translations: [
      { id: 'ross', name: 'W. D. Ross (Oxford, 1924)', short: 'Ross', slot: 'english' },
    ],
    blurb: 'Aristotle’s inquiry into being, substance, and the unmoved mover, in fourteen books.',
  },
  {
    id: 'APr',
    title: 'Prior Analytics',
    greekTitle: 'Ἀναλυτικὰ πρότερα',
    abbr: 'APr.',
    author: 'Aristotle',
    books: 2,
    bookLabels: ROMAN.slice(0, 2),
    greekEdition: 'Ross, Aristotelis Analytica Priora et Posteriora (OCT, 1964)',
    greekSource: {
      short: 'Ross (OCT, 1964)',
      full: 'W. D. Ross, ed. Aristotelis analytica priora et posteriora. Oxford: Clarendon Press, 1964.',
    },
    translations: [
      { id: 'jenkinson', name: 'A. J. Jenkinson (Oxford, 1928)', short: 'Jenkinson', slot: 'english' },
      { id: 'owen', name: 'O. F. Owen (Bohn, 1853)', short: 'Owen', slot: 'secondary' },
    ],
    blurb: 'Aristotle’s theory of the syllogism and deductive inference, in two books.',
  },
  {
    id: 'APo',
    title: 'Posterior Analytics',
    greekTitle: 'Ἀναλυτικὰ ὕστερα',
    abbr: 'APo.',
    author: 'Aristotle',
    books: 2,
    bookLabels: ROMAN.slice(0, 2),
    greekEdition: 'Ross, Aristotelis Analytica Priora et Posteriora (OCT, 1964)',
    greekSource: {
      short: 'Ross (OCT, 1964)',
      full: 'W. D. Ross, ed. Aristotelis analytica priora et posteriora. Oxford: Clarendon Press, 1964.',
    },
    // Mure (Oxford, 1928) primary + Bouchier (Blackwell, 1901) overlay — both PD.
    // Bouchier is a Tier 0 secondary: "Part" divisions match the 34/19 Bekker
    // chapters, pinned to the Greek spine; gutter interpolated (no anchors.yaml).
    translations: [
      { id: 'mure', name: 'G. R. G. Mure (Oxford, 1928)', short: 'Mure', slot: 'english' },
      { id: 'bouchier', name: 'E. S. Bouchier (Blackwell, 1901)', short: 'Bouchier', slot: 'secondary' },
      { id: 'owen', name: 'O. F. Owen (Bohn, 1853)', short: 'Owen', slot: 'third' },
    ],
    blurb: 'Aristotle on demonstration, scientific knowledge, and first principles, in two books.',
  },
  {
    id: 'Top',
    title: 'Topics',
    greekTitle: 'Τοπικά',
    abbr: 'Top.',
    author: 'Aristotle',
    books: 8,
    bookLabels: ROMAN.slice(0, 8),
    greekEdition: 'Ross, Aristotelis Topica et Sophistici Elenchi (OCT, 1958)',
    greekSource: {
      short: 'Ross (OCT, 1958)',
      full: 'W. D. Ross, ed. Aristotelis topica et sophistici elenchi. Oxford: Clarendon Press, 1958.',
    },
    translations: [
      { id: 'pickard', name: 'W. A. Pickard-Cambridge (Oxford, 1928)', short: 'Pickard-Cambridge', slot: 'english' },
      { id: 'owen', name: 'O. F. Owen (Bohn, 1853)', short: 'Owen', slot: 'secondary' },
    ],
    blurb: 'Aristotle’s manual of dialectical argument and the topoi, in eight books.',
  },
  {
    id: 'SE',
    title: 'Sophistical Refutations',
    greekTitle: 'Περὶ σοφιστικῶν ἐλέγχων',
    abbr: 'SE',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'Ross, Aristotelis Topica et Sophistici Elenchi (OCT, 1958)',
    greekSource: {
      short: 'Ross (OCT, 1958)',
      full: 'W. D. Ross, ed. Aristotelis topica et sophistici elenchi. Oxford: Clarendon Press, 1958.',
    },
    translations: [
      { id: 'pickard', name: 'W. A. Pickard-Cambridge (Oxford, 1928)', short: 'Pickard-Cambridge', slot: 'english' },
      { id: 'owen', name: 'O. F. Owen (Bohn, 1853)', short: 'Owen', slot: 'secondary' },
    ],
    blurb: 'Aristotle on fallacies and sophistical argument — the closing work of the Organon, in thirty-four chapters.',
  },
  {
    id: 'EN',
    title: 'Nicomachean Ethics',
    greekTitle: 'Ἠθικὰ Νικομάχεια',
    abbr: 'EN',
    author: 'Aristotle',
    books: 10,
    bookLabels: ROMAN.slice(0, 10),
    greekEdition: 'Bywater, Aristotelis Ethica Nicomachea (OCT, 1894)',
    greekSource: {
      short: 'Bywater (OCT, 1894)',
      full: 'Ingram Bywater, ed. Aristotelis Ethica Nicomachea. Oxford: Clarendon Press (Oxford Classical Texts), 1894; repr. 1962.',
    },
    translations: [
      { id: 'rackham', name: 'H. Rackham (Loeb, 1926)', short: 'Rackham', slot: 'english' },
      { id: 'ross', name: 'W. D. Ross (Oxford, 1908)', short: 'Ross', slot: 'secondary' },
      // Public domain (Bobbs-Merrill 1962, copyright not renewed — verified), so
      // it ships in the public build. Bekker-keyed from its inline apparatus and
      // carries Ostwald's 505 footnotes (shown as popups in the reader).
      { id: 'ostwald', name: 'Martin Ostwald (Bobbs-Merrill, 1962)', short: 'Ostwald', slot: 'third' },
      // Fourth translation: F. H. Peters (1881), public domain. Tier 0 overlay:
      // chapter divisions match the Greek spine exactly (13/9/12/9/11/13/14/14/12/9).
      { id: 'peters', name: 'F. H. Peters (Kegan Paul, 1881)', short: 'Peters', slot: 'overlay' },
    ],
    // The modern, Bekker-keyed Ostwald is the default English on first load.
    defaultTranslation: 'ostwald',
    blurb: 'Aristotle’s central work of moral philosophy, in ten books.',
  },
  {
    id: 'EE',
    title: 'Eudemian Ethics',
    greekTitle: 'Ἠθικὰ Εὐδήμεια',
    abbr: 'EE',
    author: 'Aristotle',
    // The treatise has eight books, but IV–VI are the "common books" — they ARE
    // Nicomachean Ethics V–VII and are not reprinted in the Eudemian text. We
    // carry the five Eudemian-proper books as contiguous indices, labelled by
    // their traditional Roman numerals (I, II, III, VII, VIII).
    books: 5,
    bookLabels: ['I', 'II', 'III', 'VII', 'VIII'],
    missingBooks: {
      after: 3,
      label: 'IV–VI',
      note: 'The “common books”, shared with the Nicomachean Ethics and not reprinted here.',
      linkWork: 'EN',
      linkBook: 5,
      linkLabel: 'Nicomachean Ethics V–VII',
    },
    greekEdition: 'Susemihl, Aristotelis Ethica Eudemia (Teubner, 1884)',
    greekSource: {
      short: 'Susemihl (Teubner, 1884)',
      full: 'F. Susemihl, ed. Aristotelis ethica Eudemia. Leipzig: Teubner, 1884.',
    },
    // Public build ships the public-domain Solomon (1915) only. The copyrighted
    // Rackham (Loeb 1935) overlay lives in EE.yaml for the local/private build
    // and is gated out of the public deploy (private flag + EE-public.yaml).
    translations: [
      { id: 'solomon', name: 'J. Solomon (Oxford, 1915)', short: 'Solomon', slot: 'english' },
      ...EE_RACKHAM,   // present only when PUBLIC_SHOW_PRIVATE=1 (see SHOW_PRIVATE above)
    ],
    blurb: 'Aristotle’s other ethical treatise, closely related to the Nicomachean Ethics.',
  },
  {
    id: 'Pol',
    title: 'Politics',
    greekTitle: 'Πολιτικά',
    abbr: 'Pol.',
    author: 'Aristotle',
    books: 8,
    bookLabels: ROMAN.slice(0, 8),
    greekEdition: 'Ross, Aristotelis Politica (OCT, 1957)',
    greekSource: {
      short: 'Ross (OCT, 1957)',
      full: 'W. D. Ross, ed. Aristotelis politica. Oxford: Clarendon Press, 1957.',
    },
    // Public build ships the public-domain Jowett (1885) + Ellis (1776/1912)
    // only. The copyrighted Rackham (Loeb 1932) primary + aligned-Jowett
    // overlay live in Pol.yaml for the local/private build and are NOT
    // deployed (see publish-plan). Ellis is a Tier 0 secondary: chapter
    // divisions match the Greek spine exactly (13/12/18/16/12/8/17/7).
    translations: [
      { id: 'jowett', name: 'Benjamin Jowett (Oxford, 1885)', short: 'Jowett', slot: 'english' },
      { id: 'ellis', name: 'William Ellis (1776; rev. 1912)', short: 'Ellis', slot: 'secondary' },
    ],
    blurb: 'Aristotle on the city, citizenship, constitutions, and the best life, in eight books.',
  },
  {
    id: 'Oec',
    title: 'Oeconomica',
    greekTitle: 'Οἰκονομικά',
    abbr: 'Oec.',
    author: 'Aristotle',
    books: 2,
    bookLabels: ROMAN.slice(0, 2),
    greekEdition: 'Susemihl, Aristotelis quae feruntur Oeconomica (Teubner, 1887)',
    greekSource: {
      short: 'Susemihl (Teubner, 1887)',
      full: 'F. Susemihl, ed. Aristotelis quae feruntur Oeconomica. Leipzig: Teubner, 1887.',
    },
    authenticity: 'spurious',
    // Spurious/post-Aristotelian: Book I is possibly by a pupil, Book II by a
    // later Peripatetic. The Greek transmits only Books I–II; the traditional
    // Book III survives solely in medieval Latin and is omitted. Forster
    // (Oxford, 1920, PD) is the sole translation; Bekker gutter interpolated.
    translations: [
      { id: 'forster', name: 'E. S. Forster (Oxford, 1920)', short: 'Forster', slot: 'english' },
    ],
    blurb: 'A short treatise on household and civic economy — transmitted with Aristotle but not by him.',
  },
  {
    id: 'VV',
    title: 'De Virtutibus et Vitiis',
    greekTitle: 'Περὶ ἀρετῶν καὶ κακιῶν',
    abbr: 'VV',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'I. Bekker, Aristotelis Opera (Berlin, 1831)',
    greekSource: {
      short: 'Bekker (Berlin, 1831)',
      full: 'I. Bekker, ed. Aristotelis opera. Berlin: Georg Reimer, 1831.',
    },
    authenticity: 'spurious',
    translations: [
      { id: 'solomon', name: 'J. Solomon (Oxford, 1915)', short: 'Solomon', slot: 'english' },
    ],
    blurb: 'A short ethical treatise transmitted with Aristotle but not by him.',
  },
  {
    id: 'DM',
    title: 'De Mundo',
    greekTitle: 'Περὶ κόσμου',
    abbr: 'Mund.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'I. Bekker, Aristotelis Opera (Berlin, 1831)',
    greekSource: {
      short: 'Bekker (Berlin, 1831)',
      full: 'I. Bekker, ed. Aristotelis opera. Berlin: Georg Reimer, 1831.',
    },
    authenticity: 'spurious',
    translations: [
      { id: 'forster', name: 'E. S. Forster (Oxford, 1914)', short: 'Forster', slot: 'english' },
    ],
    blurb: 'A spurious cosmological treatise addressed to Alexander.',
  },
  {
    id: 'Mech',
    title: 'Mechanica',
    greekTitle: 'Μηχανικά',
    abbr: 'Mech.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'I. Bekker, Aristotelis Opera (Berlin, 1831)',
    greekSource: {
      short: 'Bekker (Berlin, 1831)',
      full: 'I. Bekker, ed. Aristotelis opera. Berlin: Georg Reimer, 1831.',
    },
    authenticity: 'spurious',
    translations: [
      { id: 'forster', name: 'E. S. Forster (Oxford, 1913)', short: 'Forster', slot: 'english' },
    ],
    blurb: 'The earliest surviving treatise on mechanics — a preface and thirty-five problems — is spurious.',
  },
  {
    id: 'Col',
    title: 'De Coloribus',
    greekTitle: 'Περὶ χρωμάτων',
    abbr: 'Col.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'I. Bekker, Aristotelis Opera (Berlin, 1831)',
    greekSource: {
      short: 'Bekker (Berlin, 1831)',
      full: 'I. Bekker, ed. Aristotelis opera. Berlin: Georg Reimer, 1831.',
    },
    authenticity: 'spurious',
    translations: [
      { id: 'loveday_forster', name: 'T. Loveday and E. S. Forster (Oxford, 1913)', short: 'Loveday & Forster', slot: 'english' },
    ],
    blurb: 'A short spurious work on colours and their causes.',
  },
  {
    id: 'Phgn',
    title: 'Physiognomonica',
    greekTitle: 'Φυσιογνωμονικά',
    abbr: 'Phgn.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'I. Bekker, Aristotelis Opera (Berlin, 1831)',
    greekSource: {
      short: 'Bekker (Berlin, 1831)',
      full: 'I. Bekker, ed. Aristotelis opera. Berlin: Georg Reimer, 1831.',
    },
    authenticity: 'spurious',
    translations: [
      { id: 'loveday_forster', name: 'T. Loveday and E. S. Forster (Oxford, 1913)', short: 'Loveday & Forster', slot: 'english' },
    ],
    blurb: 'A short spurious work on inferring character from the body.',
  },
  {
    id: 'MXG',
    title: 'De Melisso Xenophane Gorgia',
    greekTitle: 'Περὶ Μελίσσου Ξενοφάνους Γοργίου',
    abbr: 'MXG',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'I. Bekker, Aristotelis Opera (Berlin, 1831)',
    greekSource: {
      short: 'Bekker (Berlin, 1831)',
      full: 'I. Bekker, ed. Aristotelis opera. Berlin: Georg Reimer, 1831.',
    },
    authenticity: 'spurious',
    translations: [
      { id: 'loveday_forster', name: 'T. Loveday and E. S. Forster (Oxford, 1913)', short: 'Loveday & Forster', slot: 'english' },
    ],
    blurb: 'A short spurious work on the Eleatic philosophers Melissus and Xenophanes, and Gorgias.',
  },
  {
    id: 'Aud',
    title: 'De Audibilibus',
    greekTitle: 'Περὶ ἀκουστῶν',
    abbr: 'Aud.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'I. Bekker, Aristotelis Opera (Berlin, 1831)',
    greekSource: {
      short: 'Bekker (Berlin, 1831)',
      full: 'I. Bekker, ed. Aristotelis opera. Berlin: Georg Reimer, 1831.',
    },
    authenticity: 'spurious',
    translations: [
      { id: 'loveday_forster', name: 'T. Loveday and E. S. Forster (Oxford, 1913)', short: 'Loveday & Forster', slot: 'english' },
    ],
    blurb: 'A short spurious work on sound and hearing.',
  },
  {
    id: 'Lin',
    title: 'De Lineis Insecabilibus',
    greekTitle: 'Περὶ ἀτόμων γραμμῶν',
    abbr: 'Lin.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'I. Bekker, Aristotelis Opera (Berlin, 1831)',
    greekSource: {
      short: 'Bekker (Berlin, 1831)',
      full: 'I. Bekker, ed. Aristotelis opera. Berlin: Georg Reimer, 1831.',
    },
    authenticity: 'spurious',
    translations: [
      { id: 'joachim', name: 'H. H. Joachim (Oxford, 1908)', short: 'Joachim', slot: 'english' },
    ],
    blurb: 'A short spurious work arguing about indivisible lines.',
  },
  {
    id: 'Vent',
    title: 'Ventorum Situs',
    greekTitle: 'Ἀνέμων θέσεις καὶ προσηγορίαι',
    abbr: 'Vent.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'I. Bekker, Aristotelis Opera (Berlin, 1831)',
    greekSource: {
      short: 'Bekker (Berlin, 1831)',
      full: 'I. Bekker, ed. Aristotelis opera. Berlin: Georg Reimer, 1831.',
    },
    authenticity: 'spurious',
    translations: [
      { id: 'forster', name: 'E. S. Forster (Oxford, 1913)', short: 'Forster', slot: 'english' },
    ],
    blurb: 'A short spurious work on the names and positions of the winds.',
  },
  {
    id: 'Mirab',
    title: 'De Mirabilibus Auscultationibus',
    greekTitle: 'Περὶ θαυμασίων ἀκουσμάτων',
    abbr: 'Mir.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'I. Bekker, Aristotelis Opera (Berlin, 1831)',
    greekSource: {
      short: 'Bekker (Berlin, 1831)',
      full: 'I. Bekker, ed. Aristotelis opera. Berlin: Georg Reimer, 1831.',
    },
    authenticity: 'spurious',
    translations: [
      { id: 'dowdall', name: 'L. D. Dowdall (Oxford, 1909)', short: 'Dowdall', slot: 'english' },
    ],
    blurb: 'A short spurious collection of about 178 reported marvels.',
  },
  {
    id: 'Rhet',
    title: 'Rhetoric',
    greekTitle: 'Τέχνη ῥητορική',
    abbr: 'Rhet.',
    author: 'Aristotle',
    books: 3,
    bookLabels: ROMAN.slice(0, 3),
    greekEdition: 'Ross, Aristotelis Ars Rhetorica (OCT, 1959)',
    greekSource: {
      short: 'Ross (OCT, 1959)',
      full: 'W. D. Ross, ed. Aristotelis ars rhetorica. Oxford: Clarendon Press, 1959.',
    },
    // Freese (Loeb, 1926) primary + Roberts (Oxford, 1924) overlay — both PD.
    // Roberts is a Tier 0 secondary: "Part" divisions match the 15/26/19 Bekker
    // chapters, pinned to the Greek spine; gutter interpolated (no anchors.yaml).
    translations: [
      { id: 'freese', name: 'J. H. Freese (Loeb, 1926)', short: 'Freese', slot: 'english' },
      { id: 'roberts', name: 'W. Rhys Roberts (Oxford, 1924)', short: 'Roberts', slot: 'secondary' },
    ],
    blurb: 'Aristotle on persuasion — ēthos, pathos, logos, and the art of the orator, in three books.',
  },
  {
    id: 'Poet',
    title: 'Poetics',
    greekTitle: 'Περὶ ποιητικῆς',
    abbr: 'Poet.',
    author: 'Aristotle',
    books: 1,
    bookLabels: ['1'],
    greekEdition: 'Kassel, Aristotelis De Arte Poetica (OCT, 1965)',
    greekSource: {
      short: 'Kassel (OCT, 1966)',
      full: 'R. Kassel, ed. Aristotelis de arte poetica liber. Oxford: Clarendon Press, 1965; repr. 1968 [of 1966 corr. edn.].',
    },
    // Fyfe (Loeb, 1932) primary + Butcher (Macmillan, 1895) overlay — both PD.
    // Butcher is a Tier 0 secondary: chapters pinned to the Greek spine, gutter
    // interpolated (no anchors.yaml).
    translations: [
      { id: 'fyfe', name: 'W. H. Fyfe (Loeb, 1932)', short: 'Fyfe', slot: 'english' },
      { id: 'butcher', name: 'S. H. Butcher (Macmillan, 1895)', short: 'Butcher', slot: 'secondary' },
    ],
    blurb: 'Aristotle on poetry and tragedy — the founding work of literary theory.',
  },
];

const BY_ID = new Map(WORKS.map((w) => [w.id, w]));

export function getWork(id: string): Work | undefined {
  return BY_ID.get(id);
}

export function bookLabel(work: Work, n: number): string {
  return work.bookLabels[n - 1] ?? String(n);
}

// A single-book work (Categories, Poetics) is a single treatise divided only
// into chapters — it has no book level, so it lives at /<work> with no
// /book/<n> subfolder, and the reader hides all book-level navigation.
export function isBookless(work: Work): boolean {
  return work.books === 1;
}

// The base-relative path to a work's READER (caller prepends BASE_URL). Every
// work — bookless or not — reads at /<work>/book/<n>; bookless works only ever
// have book 1. The bare /<work> slug is the work's landing page (workLanding).
// The single source of truth for reader URLs — used by the home index, work
// switcher, Bekker jump, search jumps, and cross-book outline links.
export function workPath(workId: string, book = 1): string {
  // Clamp to the work's real book range so a stale/overflow value (e.g. a
  // remembered book number for a work that is now bookless) can't 404.
  const w = BY_ID.get(workId);
  const max = w ? w.books : book;
  const b = Math.min(Math.max(1, book || 1), max);
  return `/${workId}/book/${b}`;
}

// The base-relative path to a work's LANDING page (caller prepends BASE_URL):
// the bare /<work> slug, an overview of the work that funnels into the reader.
export function workLanding(workId: string): string {
  return `/${workId}`;
}

// Translations visible in the current build. Private (copyright-encumbered)
// entries are already dropped from WORKS at compile time unless the build opted
// in (see SHOW_PRIVATE / ACKRILL above); this filter is a runtime backstop.
// A non-Astro host (the desktop app) can append runtime-registered
// translations — user imports, loaded from local files — via
// globalThis.__ARISTOTLE_EXTRA_TRANSLATIONS__ ({workId: TranslationRef[]});
// the site never sets it, so the static registry is unchanged there.
export function visibleTranslations(work: Work): TranslationRef[] {
  const extra = (globalThis as {
    __ARISTOTLE_EXTRA_TRANSLATIONS__?: Record<string, TranslationRef[]>;
  }).__ARISTOTLE_EXTRA_TRANSLATIONS__?.[work.id] ?? [];
  return work.translations.filter(t => !t.private || SHOW_PRIVATE).concat(extra);
}

// ---------------------------------------------------------------------------
// "In print" — copyright-encumbered modern translations and commentaries we
// can't host but want to point readers to, shown on each work's landing page.
// This is curated, additive metadata: a work with no entry simply omits the
// section. Each item is a citation plus an optional direct `url`; when `url` is
// absent the landing renders a Google Books search for the citation, so a link
// always resolves and we never fabricate a product page. John can fill in exact
// publisher/retailer URLs over time.

export interface FurtherReadingItem {
  // 'translation'/'commentary' = modern, copyright-protected works we can't host.
  // 'collection' = an in-print physical edition that CONTAINS the translation we
  // do host (a Loeb volume, or an anthology like the Basic/Complete Works) — for
  // readers who want a paper copy of what they're reading here.
  kind: 'translation' | 'commentary' | 'collection';
  cite: string;     // full citation, e.g. "Roger Crisp (Cambridge, 2000)"
  url?: string;     // optional direct purchase/publisher link; else Books search
}

// Citations may use <em>…</em> around the work's title (rendered as italics on
// the landing; stripped for the Google Books search link in inPrintHref).
const FURTHER_READING: Record<string, FurtherReadingItem[]> = {
  EN: [
    { kind: 'translation', cite: 'Roger Crisp, <em>Nicomachean Ethics</em> (Cambridge University Press, rev. ed. 2014)' },
    { kind: 'translation', cite: 'Terence Irwin, <em>Nicomachean Ethics</em> (Hackett, 3rd ed. 2019)' },
    { kind: 'translation', cite: 'Hippocrates G. Apostle, <em>Aristotle’s Nicomachean Ethics</em> (The Peripatetic Press, 1975)' },
    { kind: 'commentary', cite: 'Sarah Broadie & Christopher Rowe, <em>Nicomachean Ethics: Translation, Introduction, and Commentary</em> (Oxford University Press, 2002)' },
  ],
  EE: [
    { kind: 'translation', cite: 'Brad Inwood & Raphael Woolf, <em>Eudemian Ethics</em> (Cambridge University Press, 2013)' },
    { kind: 'commentary', cite: 'Anthony Kenny, <em>The Eudemian Ethics</em> (Oxford World’s Classics, 2011)' },
  ],
  Meta: [
    { kind: 'translation', cite: 'C. D. C. Reeve, <em>Metaphysics</em> (Hackett, 2016)' },
    { kind: 'translation', cite: 'Hippocrates G. Apostle, <em>Aristotle’s Metaphysics</em> (Indiana University Press, 1966)' },
    { kind: 'commentary', cite: 'W. D. Ross, <em>Aristotle’s Metaphysics: A Revised Text with Introduction and Commentary</em>, 2 vols. (Oxford University Press, 1924)' },
  ],
  Pol: [
    { kind: 'translation', cite: 'C. D. C. Reeve, <em>Politics</em> (Hackett, 2017)' },
    { kind: 'translation', cite: 'Carnes Lord, <em>The Politics</em> (University of Chicago Press, 2nd ed. 2013)' },
    { kind: 'translation', cite: 'Hippocrates G. Apostle & Lloyd P. Gerson, <em>Aristotle’s Politics</em> (The Peripatetic Press, 1986)' },
  ],
  Phys: [
    { kind: 'translation', cite: 'Robin Waterfield, <em>Physics</em> (Oxford World’s Classics, 1996)' },
    { kind: 'translation', cite: 'Hippocrates G. Apostle, <em>Aristotle’s Physics</em> (Indiana University Press, 1969)' },
    { kind: 'commentary', cite: 'W. D. Ross, <em>Aristotle’s Physics: A Revised Text with Introduction and Commentary</em> (Oxford University Press, 1936)' },
  ],
  DA: [
    { kind: 'translation', cite: 'Christopher Shields, <em>De Anima</em> (Clarendon Aristotle Series, Oxford University Press, 2016)' },
    { kind: 'translation', cite: 'Hugh Lawson-Tancred, <em>De Anima (On the Soul)</em> (Penguin Classics, 1986)' },
    { kind: 'translation', cite: 'Hippocrates G. Apostle, <em>Aristotle’s On the Soul</em> (The Peripatetic Press, 1981)' },
  ],
  Rhet: [
    { kind: 'translation', cite: 'George A. Kennedy, <em>On Rhetoric: A Theory of Civic Discourse</em> (Oxford University Press, 2nd ed. 2007)' },
  ],
  Poet: [
    { kind: 'translation', cite: 'Anthony Kenny, <em>Poetics</em> (Oxford World’s Classics, 2013)' },
    { kind: 'translation', cite: 'Hippocrates G. Apostle, Elizabeth A. Dobbs & Morris A. Parslow, <em>Aristotle’s Poetics</em> (The Peripatetic Press, 1990)' },
    { kind: 'commentary', cite: 'Stephen Halliwell, <em>The Poetics of Aristotle: Translation and Commentary</em> (University of North Carolina Press, 1987)' },
  ],
  Cat: [
    { kind: 'translation', cite: 'Hippocrates G. Apostle, <em>Aristotle’s Categories and Propositions (De Interpretatione)</em> (The Peripatetic Press, 1980)' },
    { kind: 'commentary', cite: 'J. L. Ackrill, <em>Categories and De Interpretatione</em> (Clarendon Aristotle Series, Oxford University Press, 1963)' },
  ],
  Int: [
    { kind: 'translation', cite: 'Hippocrates G. Apostle, <em>Aristotle’s Categories and Propositions (De Interpretatione)</em> (The Peripatetic Press, 1980)' },
    { kind: 'commentary', cite: 'J. L. Ackrill, <em>Categories and De Interpretatione</em> (Clarendon Aristotle Series, Oxford University Press, 1963)' },
  ],
  APo: [
    { kind: 'translation', cite: 'Hippocrates G. Apostle, <em>Aristotle’s Posterior Analytics</em> (The Peripatetic Press, 1981)' },
    { kind: 'commentary', cite: 'Jonathan Barnes, <em>Posterior Analytics</em> (Clarendon Aristotle Series, Oxford University Press, 2nd ed. 1994)' },
  ],
  Isa: [
    { kind: 'translation', cite: 'Jonathan Barnes, <em>Porphyry: Introduction</em> (Clarendon Later Ancient Philosophers, Oxford University Press, 2003)' },
    { kind: 'translation', cite: 'Paul Vincent Spade, trans., in <em>Five Texts on the Mediaeval Problem of Universals</em> (Hackett, 1994)' },
  ],
};

// ── In-print editions that contain the (public-domain) translation we host ───
// Each entry names WHICH hosted translation a given print edition carries, so
// the granularity is per-work, not a blanket "complete works" pointer.

// The Oxford Translation translator we host for a work — the text that McKeon's
// Basic Works reprints and that Barnes's Revised Oxford Translation revises.
// Works whose hosted English is NOT from the Oxford Translation (Rhetoric/Freese
// and Poetics/Fyfe are Loeb; Eudemian Ethics) are absent here.
const OXFORD_TRANS: Record<string, string> = {
  Cat: 'E. M. Edghill', Int: 'E. M. Edghill',
  APr: 'A. J. Jenkinson', APo: 'G. R. G. Mure',
  Top: 'W. A. Pickard-Cambridge', SE: 'W. A. Pickard-Cambridge',
  Phys: 'R. P. Hardie & R. K. Gaye', Cael: 'J. L. Stocks',
  GC: 'H. H. Joachim', Mete: 'E. W. Webster', DA: 'J. A. Smith',
  Sens: 'J. I. Beare', Mem: 'J. I. Beare', Somn: 'J. I. Beare',
  Insomn: 'J. I. Beare', DivSomn: 'J. I. Beare',
  Long: 'G. R. T. Ross', Juv: 'G. R. T. Ross',
  HA: 'D’Arcy W. Thompson', PA: 'William Ogle',
  MA: 'A. S. L. Farquharson', IA: 'A. S. L. Farquharson', GA: 'Arthur Platt',
  Meta: 'W. D. Ross', EN: 'W. D. Ross', Pol: 'Benjamin Jowett',
};

// McKeon's Basic Works reprints the original Oxford Translation of these major
// treatises complete and in the same translator's version we host.
const MCKEON_WORKS = new Set(['Cat', 'Int', 'APo', 'Phys', 'DA', 'Meta', 'EN', 'Pol']);

// Works where Barnes's Revised Oxford Translation SUBSTITUTED a fresh translation
// (Ackrill for Categories/De Interpretatione, Barnes's own for the Posterior
// Analytics) rather than revising the one we host — so it does not contain ours.
const BARNES_SUBSTITUTED = new Set(['Cat', 'Int', 'APo']);

// Works whose hosted English IS a Loeb translation still sold in print: the
// facing-page Loeb is the paper edition of the very text shown here.
const LOEB_HOSTED: Record<string, string> = {
  EN: 'H. Rackham, <em>Nicomachean Ethics</em>, Loeb Classical Library 73 (Harvard University Press)',
  Rhet: 'J. H. Freese, <em>Art of Rhetoric</em>, Loeb Classical Library 193 (Harvard University Press; rev. Gisela Striker, 2020)',
  Poet: 'Aristotle, <em>Poetics</em>, Loeb Classical Library 199 (Harvard University Press)',
};

// Public-domain translations we host that the Prometheus Trust keeps in print in
// its Thomas Taylor Series — the specific reprint of the very text shown here.
const PROMETHEUS_HOSTED: Record<string, string> = {
  Cat: 'Thomas Taylor, trans., <em>The Organon, or Logical Treatises of Aristotle</em>, Thomas Taylor Series (Prometheus Trust)',
  Int: 'Thomas Taylor, trans., <em>The Organon, or Logical Treatises of Aristotle</em>, Thomas Taylor Series (Prometheus Trust)',
};

// C. D. C. Reeve's new complete translation (Hackett) is his OWN translation —
// it contains none of the public-domain translations we host — so it is listed
// among the modern translations, not as an edition of the text read here.
const REEVE_COMPLETE: FurtherReadingItem = {
  kind: 'translation',
  cite: 'C. D. C. Reeve, trans., in <em>Aristotle: The Complete Works</em>, 2 vols. (Hackett, 2024)',
};

function collectionsFor(workId: string): FurtherReadingItem[] {
  const out: FurtherReadingItem[] = [];
  if (LOEB_HOSTED[workId]) {
    out.push({ kind: 'collection', cite: `${LOEB_HOSTED[workId]} — the print edition of the translation read here` });
  }
  if (PROMETHEUS_HOSTED[workId]) {
    out.push({ kind: 'collection', cite: `${PROMETHEUS_HOSTED[workId]} — the in-print reprint of the translation read here` });
  }
  const ox = OXFORD_TRANS[workId];
  if (ox && MCKEON_WORKS.has(workId)) {
    out.push({ kind: 'collection', cite: `${ox}’s translation, found in Richard McKeon, ed., <em>The Basic Works of Aristotle</em> (Random House, 1941; repr. Modern Library, 2001)` });
  }
  if (ox && !BARNES_SUBSTITUTED.has(workId)) {
    out.push({ kind: 'collection', cite: `${ox}’s translation, revised, found in Jonathan Barnes, ed., <em>The Complete Works of Aristotle: The Revised Oxford Translation</em>, 2 vols. (Princeton University Press, 1984)` });
  }
  return out;
}

// In-print editions for a work's landing page: curated modern translations and
// commentaries, plus the print collections that contain the hosted translation.
// Items without a direct `url` get a Google Books search link.
// Hippocrates G. Apostle's translations (originally Peripatetic Press / Indiana
// University Press) are reprinted by Thomas More College Press; link those
// "Find in print" buttons straight to its Peripatetic Press catalog.
const PERIPATETIC_URL = 'https://press.thomasmorecollege.edu/product-category/books/the-peripatetic-press/';

export function furtherReading(workId: string): FurtherReadingItem[] {
  const curated = (FURTHER_READING[workId] ?? []).map((r) =>
    !r.url && /Apostle/.test(r.cite) ? { ...r, url: PERIPATETIC_URL } : r,
  );
  // Reeve's complete works applies to every ARISTOTLE work, but skip it where a
  // specific Reeve volume is already listed (Metaphysics, Politics) to avoid
  // duplication — and skip it entirely for non-Aristotle works (e.g. Porphyry's
  // Isagoge), which his Complete Works of Aristotle does not contain.
  const byAristotle = getWork(workId)?.author === 'Aristotle';
  const reeve =
    !byAristotle || curated.some((r) => /Reeve/.test(r.cite)) ? [] : [REEVE_COMPLETE];
  return [...curated, ...reeve, ...collectionsFor(workId)];
}

// A link that always resolves to where the cited edition can be found/bought.
// The cite may carry <em> title markup, so strip tags before building the query.
export function inPrintHref(item: FurtherReadingItem): string {
  const plain = item.cite.replace(/<[^>]+>/g, '');
  return item.url ?? `https://www.google.com/search?tbm=bks&q=${encodeURIComponent(plain)}`;
}

// ---------------------------------------------------------------------------
// "Resources" — external study aids relevant to a specific work, shown on the
// landing page. Curated, additive metadata like FURTHER_READING: a work with
// no entry simply omits the section.

export interface ResourceItem {
  label: string;         // resource name, e.g. 'Ars Syllogistica'
  url: string;
  blurb: string;         // one line describing the resource
  authorName: string;
  authorUrl: string;
  exercises?: string;    // exercise set(s) within the resource keyed to this work
}

// Timothy Kearns's interactive Aristotelian/Scholastic logic exercise site.
// Its "Study" modules and practice exercise sets track the traditional Organon
// sequence, so each Organon work links to the set that drills its material.
const ARS_SYLLOGISTICA: Omit<ResourceItem, 'exercises'> = {
  label: 'Ars Syllogistica',
  url: 'https://gcrastinus.github.io/ars-syllogistica/',
  blurb: 'An interactive guide to learning Aristotelian logic.',
  authorName: 'Dr. Timothy Kearns',
  authorUrl: 'https://lccollege.academia.edu/TimothyKearns',
};

const RESOURCES: Record<string, ResourceItem[]> = {
  Cat: [{ ...ARS_SYLLOGISTICA, exercises: 'the “Study” and “First Act of the Mind” exercise sets' }],
  Int: [{ ...ARS_SYLLOGISTICA, exercises: 'the “Second Act of the Mind” exercise set' }],
  APr: [{ ...ARS_SYLLOGISTICA, exercises: 'the “Third Act of the Mind” exercise set' }],
  APo: [{ ...ARS_SYLLOGISTICA, exercises: 'the “Ad Demonstrandum” exercise set' }],
  Top: [{ ...ARS_SYLLOGISTICA }],
  SE: [{ ...ARS_SYLLOGISTICA }],
  Rhet: [{ ...ARS_SYLLOGISTICA, exercises: 'the “Enthymeme” exercise set' }],
};

export function resourcesFor(workId: string): ResourceItem[] {
  return RESOURCES[workId] ?? [];
}

// ---------------------------------------------------------------------------
// Home-page taxonomy. The corpus is organised into the five traditional
// divisions of the Aristotelian corpus (Logic, Natural Philosophy,
// Metaphysics, Moral & Political Philosophy, Rhetoric & Poetics), some with
// sub-divisions. A `CategoryWork` is either an existing work (`id`, resolved
// against WORKS) or a not-yet-added work shown as a "coming soon" placeholder
// (`title` only). This drives only the home index; routing/search are unchanged.

export interface CategoryWork {
  id?: string;      // an existing work (in WORKS) — clickable
  title?: string;   // a planned work — greyed-out placeholder
}

export interface SubCategory {
  ref: string;      // e.g. 'II.a'
  label: string;    // e.g. 'Major Works on Nature'
  works: CategoryWork[];
}

export interface Category {
  numeral: string;  // 'I' — empty for an appendix section (rendered without a numeral)
  title: string;    // 'Logic (Organon)'
  works?: CategoryWork[];          // direct works (no sub-division)
  subcategories?: SubCategory[];
  // An appendix sits OUTSIDE the numbered corpus divisions: the doubtful/spurious
  // works transmitted under Aristotle's name but not by him. Rendered after the
  // numbered divisions, set off by a rule, with no Roman numeral.
  appendix?: boolean;
}

export const CATEGORIES: Category[] = [
  {
    numeral: 'I',
    title: 'Logic (Organon)',
    works: [
      { id: 'Cat' },
      { id: 'Int' },
      { id: 'APr' },
      { id: 'APo' },
      { id: 'Top' },
      { id: 'SE' },
    ],
  },
  {
    numeral: 'II',
    title: 'Natural Philosophy',
    subcategories: [
      {
        ref: 'II.a',
        label: 'Major Works on Nature',
        works: [
          { id: 'Phys' },
          { id: 'Cael' },
          { id: 'GC' },
          { id: 'Mete' },
          { id: 'DA' },
        ],
      },
      {
        ref: 'II.b',
        label: 'Short Works on Nature (Parva Naturalia)',
        works: [
          { id: 'Sens' },
          { id: 'Mem' },
          { id: 'Somn' },
          { id: 'Insomn' },
          { id: 'DivSomn' },
          { id: 'Long' },
          { id: 'Juv' },
        ],
      },
      {
        ref: 'II.c',
        label: 'Biological Works',
        works: [
          { id: 'HA' },
          { id: 'PA' },
          { id: 'MA' },
          { id: 'IA' },
          { id: 'GA' },
        ],
      },
    ],
  },
  {
    numeral: 'III',
    title: 'Metaphysics',
    works: [
      { id: 'Meta' },
    ],
  },
  {
    numeral: 'IV',
    title: 'Moral and Political Philosophy',
    works: [
      { id: 'EN' },
      { id: 'EE' },
      { id: 'Pol' },
    ],
  },
  {
    numeral: 'V',
    title: 'Rhetoric and Poetics',
    works: [
      { id: 'Rhet' },
      { id: 'Poet' },
    ],
  },
  // Appendix — the doubtful/spurious works transmitted under Aristotle's name but
  // judged not to be by him. Grouped OUTSIDE the numbered divisions (no numeral);
  // each card still carries its Dubious/Spurious badge.
  {
    numeral: '',
    title: 'Spurious Works',
    appendix: true,
    works: [
      { id: 'DM' },
      { id: 'MXG' },
      { id: 'Mech' },
      { id: 'Col' },
      { id: 'Aud' },
      { id: 'Phgn' },
      { id: 'Mirab' },
      { id: 'Lin' },
      { id: 'Vent' },
      { id: 'VV' },
      { id: 'Oec' },
    ],
  },
  // Porphyry's Isagoge (id 'Isa') is intentionally NOT a home division: it's
  // surfaced as a "Commentary" card on the Categories landing page (the work it
  // introduces) instead. It remains routable at /Isa and searchable.
];

// A named group of works for the search "works to include" selector: one entry
// per home-page (sub)division, in home-page order, holding only the existing
// works (placeholders dropped). Categories with subcategories contribute one
// group per subcategory; categories without contribute a single group.
export interface WorkGroup {
  ref: string;    // 'I', 'II.a', … (the numeral or subcategory ref)
  label: string;  // the division's title/label
  ids: string[];  // existing work ids in this group, in order
}

export const WORK_GROUPS: WorkGroup[] = (() => {
  const groups: WorkGroup[] = [];
  const ids = (ws: CategoryWork[]) => ws.filter(w => w.id && BY_ID.has(w.id)).map(w => w.id!);
  for (const cat of CATEGORIES) {
    if (cat.works) {
      const g = ids(cat.works);
      if (g.length) groups.push({ ref: cat.numeral, label: cat.title, ids: g });
    }
    for (const sub of cat.subcategories ?? []) {
      const g = ids(sub.works);
      if (g.length) groups.push({ ref: sub.ref, label: sub.label, ids: g });
    }
  }
  return groups;
})();

// Cross-work ordering for search results, matching the home page's CATEGORIES
// flatten order (which differs from the raw WORKS/corpus order). Any real work
// not referenced by CATEGORIES is appended in WORKS order so every searchable
// work has a defined index.
export const WORK_ORDER: Map<string, number> = (() => {
  const order: string[] = [];
  for (const g of WORK_GROUPS) for (const id of g.ids) order.push(id);
  for (const w of WORKS) if (!order.includes(w.id)) order.push(w.id);
  return new Map(order.map((id, i) => [id, i]));
})();
