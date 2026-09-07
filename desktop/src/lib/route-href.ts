// Pure href → action map for the desktop shell.
//
// Reused site components emit real <a href> links (word popup, search hits,
// the command palette, the phrase browser). In a desktop window those would
// navigate the webview away; this parser is the single decision for "stay in
// app / open the system browser / leave the click alone".

export type RouteAction =
  | { kind: 'passthrough' }
  | { kind: 'swallow' }
  | { kind: 'lemma'; slug: string }
  | {
      kind: 'reader';
      work: string;
      book: number;
      params: { loc?: string; hlg?: string; hle?: string; hash?: string };
    }
  | { kind: 'search'; query: string }
  | { kind: 'external'; url: string };

const LIVE_SITE = 'https://johnhboyer-sys.github.io/aristotle-reader';

// decodeURIComponent throws on a malformed escape. The click interceptor
// runs this parser BEFORE preventDefault, so a throw here would let the
// webview follow the raw href and leave the app — keep the text as-is instead.
function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function parseRouteHref(href: string): RouteAction {
  const raw = href.trim();
  if (!raw) return { kind: 'swallow' };
  if (raw.startsWith('#')) return { kind: 'passthrough' };
  if (/^(blob|data):/i.test(raw)) return { kind: 'passthrough' };
  if (/^https?:/i.test(raw)) return { kind: 'external', url: raw };
  // Other schemes (mailto:, asset:, tauri:) are not site routes.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return { kind: 'passthrough' };

  let url: URL;
  try {
    url = new URL(raw, 'https://desktop.invalid/');
  } catch {
    return { kind: 'swallow' };
  }

  const path = url.pathname.replace(/\/+$/, '') || '/';

  const lemma = path.match(/^\/lemma\/([^/]+)$/);
  if (lemma) return { kind: 'lemma', slug: safeDecode(lemma[1]) };

  const reader = path.match(/^\/([A-Za-z]+)\/book\/(\d+)$/);
  if (reader) {
    const q = url.searchParams;
    const loc = q.get('loc') ?? undefined;
    const hlg = q.get('hlg') ?? undefined;
    const hle = q.get('hle') ?? undefined;
    const hash = url.hash ? safeDecode(url.hash.slice(1)) : undefined;
    return {
      kind: 'reader',
      work: reader[1],
      book: Number(reader[2]),
      params: {
        ...(loc ? { loc } : {}),
        ...(hlg ? { hlg } : {}),
        ...(hle ? { hle } : {}),
        ...(hash ? { hash } : {}),
      },
    };
  }

  if (path === '/search') {
    return { kind: 'search', query: url.search.startsWith('?') ? url.search.slice(1) : '' };
  }

  // Guide pages live on the website, not in the app. Hash is the only
  // fragment the live URL template carries (the phrases "What is this?"
  // link is /advanced#phrases).
  if (path === '/advanced') {
    return { kind: 'external', url: `${LIVE_SITE}/advanced${url.hash}` };
  }

  return { kind: 'swallow' };
}
