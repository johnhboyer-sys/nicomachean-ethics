// Library export: bundle the user's annotations and imported translations
// into one shareable JSON archive. Cheap by design — the storage model is
// already plain files, so an export is a gather, not a subsystem.
//
// The bundle is self-describing ({formatVersion, exportedAt, …}) so a future
// "import library" can restore it; nothing in it is machine-specific.

import { isTauri } from './runtime';
import { annotationsProblem, listAnnotations, type Annotation } from './annotations';
import { WORKS } from '@shared/lib/works';

export interface LibraryBundle {
  formatVersion: 1;
  kind: 'aristotle-reader-library';
  exportedAt: string;
  annotations: Record<string, Annotation[]>;
  translations: {
    work: string;
    id: string;
    /** The canonical tagged file (frontmatter + content); absent in the
     *  browser harness, which persists only alignment maps. */
    content?: string;
    map: unknown;
  }[];
  /** Stored records the export could not read; listed so the bundle never
   *  silently claims to be complete. Absent when everything was readable. */
  skipped?: { work: string; id: string; reason: string }[];
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function buildBundle(): Promise<LibraryBundle> {
  const annotations: Record<string, Annotation[]> = {};
  const skipped: NonNullable<LibraryBundle['skipped']> = [];
  for (const w of WORKS) {
    const anns = await listAnnotations(w.id);
    if (anns.length) annotations[w.id] = anns;
    const problem = annotationsProblem(w.id);
    if (problem) skipped.push({ work: w.id, id: 'annotations', reason: problem });
  }

  const translations: LibraryBundle['translations'] = [];
  if (isTauri()) {
    const { appDataDir, join } = await import('@tauri-apps/api/path');
    const fs = await import('@tauri-apps/plugin-fs');
    const root = await join(await appDataDir(), 'translations');
    if (await fs.exists(root)) {
      for (const workDir of await fs.readDir(root)) {
        if (!workDir.isDirectory) continue;
        const dir = await join(root, workDir.name);
        for (const e of await fs.readDir(dir)) {
          if (!e.name.endsWith('.map.json')) continue;
          const id = e.name.replace(/\.map\.json$/, '');
          // One unreadable record must not abort the export of every other.
          try {
            const map = JSON.parse(await fs.readTextFile(await join(dir, e.name)));
            let content: string | undefined;
            try { content = await fs.readTextFile(await join(dir, `${id}.md`)); } catch { /* map only */ }
            translations.push({ work: workDir.name, id, ...(content !== undefined ? { content } : {}), map });
          } catch (err) {
            skipped.push({ work: workDir.name, id, reason: errorText(err) });
          }
        }
      }
    }
  } else {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      const m = k.match(/^import-map:(.+)\/(.+)$/);
      if (!m) continue;
      try {
        translations.push({ work: m[1], id: m[2], map: JSON.parse(localStorage.getItem(k)!) });
      } catch (err) {
        skipped.push({ work: m[1], id: m[2], reason: errorText(err) });
      }
    }
  }

  return {
    formatVersion: 1,
    kind: 'aristotle-reader-library',
    exportedAt: new Date().toISOString(),
    annotations,
    translations,
    ...(skipped.length ? { skipped } : {}),
  };
}

/** Export the library; returns a human summary, or null if the user cancelled. */
export async function exportLibrary(): Promise<string | null> {
  const bundle = await buildBundle();
  const nAnn = Object.values(bundle.annotations).reduce((n, a) => n + a.length, 0);
  const skippedNote = bundle.skipped
    ? `; ${bundle.skipped.length} unreadable and skipped: ${bundle.skipped.map(s => `${s.work}/${s.id}`).join(', ')}`
    : '';
  const summary = `${nAnn} annotation${nAnn === 1 ? '' : 's'}, ${bundle.translations.length} imported translation${bundle.translations.length === 1 ? '' : 's'}${skippedNote}`;
  const json = JSON.stringify(bundle, null, 1);
  const filename = `aristotle-reader-library-${bundle.exportedAt.slice(0, 10)}.json`;

  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({ defaultPath: filename, filters: [{ name: 'Library bundle', extensions: ['json'] }] });
    if (!path) return null;
    await writeTextFile(path, json);
    return summary;
  }
  // Browser harness: plain download.
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  return summary;
}

// ── Report a Problem ─────────────────────────────────────────────────────────
// User-initiated only, zero backend, no telemetry: opens a pre-filled GitHub
// issue in the system browser. Environment facts are IN the visible body the
// user can edit before submitting — nothing is sent silently.

const REPO_ISSUES = 'https://github.com/johnhboyer-sys/aristotle-reader/issues/new';

/** Open a URL in the system browser (packaged) or a new tab (dev harness). */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

export async function reportProblem(appVersion: string): Promise<void> {
  const body = [
    '<!-- Describe the problem. What did you do, what happened, what did you expect? -->',
    '',
    '',
    '---',
    `App: The Aristotle Reader desktop v${appVersion}`,
    `Platform: ${navigator.platform ?? 'unknown'}`,
    `Webview: ${navigator.userAgent}`,
  ].join('\n');
  const url = `${REPO_ISSUES}?labels=desktop&body=${encodeURIComponent(body)}`;
  await openExternal(url);
}
