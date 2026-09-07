/**
 * Running Diogenes' exporter over a user's TLG or PHI disc.
 *
 * Command CONSTRUCTION only, as data — the same split the older
 * corpus/diogenes.ts makes, for the same reason: it stays testable without a
 * subprocess, and the Tauri side owns the actual spawn.
 *
 * WHY DIOGENES AT ALL, when the packs made lookup standalone: reading a
 * TLG/PHI disc means decoding a 1985 binary format with its own citation
 * escapes, and Diogenes has done that correctly for twenty years. Users with
 * the discs already have it. Users without the discs never touch this path —
 * they import from Perseus, which needs nothing installed.
 *
 * ── What is verified, and what is not ──────────────────────────────────────
 * The macOS path is checked against a real Diogenes 4.7.2 install and real
 * discs: the command below exports Plato from the TLG disc end to end.
 *
 * The WINDOWS paths are INFERRED and untested. macOS Diogenes bundles no perl
 * (it uses the system one), but Windows has no system perl, so the Windows
 * build must ship its own — and where it puts it is a guess here. Everything
 * Windows-specific is therefore a CANDIDATE LIST, tried in order, with the
 * settings override as the escape hatch when every guess misses. When someone
 * runs this on Windows, the fix is to add the real path to the list — not to
 * restructure anything.
 */

export type Corpus = 'tlg' | 'phi';

/** Diogenes reads the disc location from one environment variable per corpus
 * (Diogenes/Base.pm) — verified in the source, not guessed. */
const DISC_ENV_VAR: Record<Corpus, string> = {
  tlg: 'TLG_DIR',
  phi: 'PHI_DIR',
};

export type Platform = 'macos' | 'windows' | 'linux';

/**
 * How to treat line breaks, which materially changes the imported text:
 *
 *  - 'auto'  — let Diogenes decide. It carries a per-work heuristic AND a
 *              hand-curated exception list (is_work_verse in xml-export.pl),
 *              which is a better judgment than ours and matches what the user
 *              sees when they read the same text in Diogenes itself.
 *  - 'lines' — force verse: every printed line becomes a row and keeps its
 *              number. Right where the edition's line breaks are canonical,
 *              as Bekker's are for Aristotle.
 *  - 'prose' — force prose: line breaks dropped and hyphenation rejoined, so
 *              rows are sections rather than lines.
 */
export type LineMode = 'auto' | 'lines' | 'prose';

export interface DiscExportRequest {
  corpus: Corpus;
  /** Four-digit author number, e.g. "0059". */
  authorNumber: string;
  /** The disc folder the user picked (the one holding AUTHTAB.DIR). */
  discDir: string;
  /** Diogenes' server directory — the one holding xml-export.pl. */
  diogenesServer: string;
  /** Where the exporter should write. It appends Diogenes-Resources/xml/<corpus>/ itself. */
  exportDir: string;
  lineMode?: LineMode;
  /** perl to run. Omitted = the platform default (see perlCandidates). */
  perlPath?: string;
  platform: Platform;
}

export interface DiscExportCommand {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * Where the exported XML for one work lands. Diogenes names files
 * <corpus><author><work>.xml, e.g. tlg0059030.xml — verified against real
 * output.
 */
export function exportedWorkPath(exportDir: string, corpus: Corpus, authorNumber: string, workNumber: string): string {
  return `${trimSlash(exportDir)}/Diogenes-Resources/xml/${corpus}/${corpus}${authorNumber}${workNumber}.xml`;
}

/**
 * Build the export command.
 *
 * Note what is NOT here: a way to export one work. `-n` takes author numbers
 * only, so importing a single dialogue exports the whole author — 41 files for
 * Plato, and minutes of work. Callers should check `exportedWorkPath` first
 * and skip the run when the file is already there (the pipeline does the same).
 */
export function buildDiscExportCommand(req: DiscExportRequest): DiscExportCommand {
  const lineMode = req.lineMode ?? 'auto';
  const args = [
    'xml-export.pl',
    '-c', req.corpus,
    '-n', req.authorNumber,
    '-o', req.exportDir,
  ];
  // 'auto' passes neither switch, leaving Diogenes' own judgment in charge.
  if (lineMode === 'lines') args.push('-y');
  else if (lineMode === 'prose') args.push('-Y');

  return {
    program: req.perlPath ?? perlCandidates(req.platform, req.diogenesServer)[0],
    args,
    cwd: req.diogenesServer,
    env: {
      [DISC_ENV_VAR[req.corpus]]: req.discDir,
    },
  };
}

/**
 * perl interpreters to try, best first. The caller tries each until one runs;
 * a configured `perlPath` skips this entirely.
 *
 * macOS/Linux: the system perl, which is what Diogenes itself uses there.
 * Windows: VERIFIED BY NOBODY YET — Diogenes for Windows is an Electron app
 * that must ship its own perl, and these are the plausible locations relative
 * to the server directory, plus a bare `perl` for a machine that has Strawberry
 * or ActivePerl on PATH.
 */
export function perlCandidates(platform: Platform, diogenesServer: string): string[] {
  if (platform !== 'windows') return ['/usr/bin/perl', 'perl'];
  const base = trimSlash(diogenesServer);
  const parent = base.replace(/[\\/][^\\/]+$/, '');
  return [
    `${parent}/perl/perl/bin/perl.exe`,
    `${parent}/strawberry/perl/bin/perl.exe`,
    `${base}/perl/bin/perl.exe`,
    'perl.exe',
    'perl',
  ];
}

/**
 * A minimal PATH. The Aristotle pipeline pins '/usr/bin:/bin' so the run does
 * not depend on the developer's shell; the same reasoning applies here. On
 * Windows a pinned PATH would do more harm than good — the bundled perl needs
 * its own DLLs on PATH — so we pass none and let the child inherit.
 */
// PATH is deliberately NOT set here. It used to be pinned to /usr/bin:/bin
// "so the run does not depend on the developer's shell", but run_program's
// ALLOWED_ENV whitelist (src-tauri/src/assist.rs) drops every variable outside
// TLG_DIR/PHI_DIR/DDP_DIR and then sets PATH itself from augmented_path().
// So the pin never reached the child: two layers each believed they were
// hardening PATH and the child got the Rust one regardless. Saying nothing
// here is honest about who owns it — change augmented_path() to change it.

/** Default install locations, best first. macOS is verified; the others are
 * the documented install paths and should be treated as starting guesses. */
export function diogenesServerCandidates(platform: Platform): string[] {
  switch (platform) {
    case 'macos':
      return ['/Applications/Diogenes.app/Contents/server'];
    case 'windows':
      return [
        'C:/Program Files/Diogenes/resources/app/server',
        'C:/Program Files (x86)/Diogenes/resources/app/server',
      ];
    default:
      return ['/usr/share/diogenes/server', '/opt/diogenes/server'];
  }
}

/** The platform the app is running on, from Tauri's OS plugin naming. */
export function platformFrom(osType: string): Platform {
  const t = osType.toLowerCase();
  if (t.includes('darwin') || t.includes('mac')) return 'macos';
  if (t.includes('win')) return 'windows';
  return 'linux';
}

function trimSlash(path: string): string {
  return path.replace(/[\\/]+$/, '');
}
