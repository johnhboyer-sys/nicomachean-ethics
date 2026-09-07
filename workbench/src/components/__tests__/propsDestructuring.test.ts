// Every prop a component DECLARES must also be DESTRUCTURED.
//
// This is the failure the workbench handoff records as "a green suite does not
// mean the app starts": a prop added to a component's `$props()` TYPE but not
// to the `let { … }` beside it is, to the Svelte compiler, a free identifier.
// It compiles, `tsc --noEmit` stays clean (tsc doesn't read .svelte files) and
// every source-scan test still passes — and then the template's first
// reference to it throws `ReferenceError: <name> is not defined` the moment
// that branch renders.
//
// Found again 2026-09-07 in AddWorkDialog: `onImportSource` was declared and
// used, never destructured, so opening "Add work…" with every corpus work
// already on the Mac (`candidates.length === 0`) threw instead of offering
// "Import a text…". A mechanical sweep of all of them costs nothing and is
// the only cheap guard against the whole class.
import { beforeAll, describe, expect, it } from 'vitest';

interface Component {
  path: string;
  source: string;
}

let components: Component[] = [];

beforeAll(async () => {
  const fs = (await import(/* @vite-ignore */ 'node' + ':fs')) as unknown as {
    readFileSync(path: string, encoding: 'utf-8'): string;
    readdirSync(path: string, opts: { withFileTypes: true }): {
      name: string;
      isDirectory(): boolean;
    }[];
  };
  const nodeUrl = (await import(/* @vite-ignore */ 'node' + ':url')) as unknown as {
    fileURLToPath(url: URL): string;
  };
  const root = nodeUrl.fileURLToPath(new URL('../..', import.meta.url)); // src/
  const found: Component[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path, relPath);
      else if (entry.name.endsWith('.svelte')) {
        found.push({ path: relPath, source: fs.readFileSync(path, 'utf-8') });
      }
    }
  };
  walk(root, '');
  components = found;
});

/** Split `let { A }: { B } = $props()` into its two halves, or null. */
function propsBlock(source: string): { destructured: string; declared: string } | null {
  const end = source.indexOf('= $props()');
  if (end < 0) return null;
  const start = source.lastIndexOf('let {', end);
  if (start < 0) return null;
  const block = source.slice(start + 'let {'.length, end);
  // The destructuring ends at the `}` that the type annotation's `:` follows.
  let depth = 0;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === ']' || ch === ')') depth -= 1;
    else if (ch === '}') {
      if (depth === 0) return { destructured: block.slice(0, i), declared: block.slice(i + 1) };
      depth -= 1;
    }
  }
  return null;
}

/** Top-level member names of the props TYPE (nested object members skipped). */
function declaredProps(declared: string): string[] {
  const open = declared.indexOf('{');
  if (open < 0) return [];
  const names: string[] = [];
  let depth = 0;
  let atMemberStart = false;
  for (let i = open; i < declared.length; i++) {
    const ch = declared[i];
    // NB: never `<`/`>` — a prop type is full of `=>`, and counting that
    // as a bracket walks the depth straight past every member below it.
    if (ch === '{' || ch === '(' || ch === '[') {
      depth += 1;
      atMemberStart = depth === 1;
      continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      continue;
    }
    if (depth !== 1) continue;
    if (ch === ';' || ch === ',') {
      atMemberStart = true;
      continue;
    }
    if (!atMemberStart) continue;
    if (/\s/.test(ch)) continue;
    if (ch === '/') {
      // A comment between members: skip to its end, still at a member start.
      const isLine = declared[i + 1] === '/';
      const close = isLine ? declared.indexOf('\n', i) : declared.indexOf('*/', i);
      i = close < 0 ? declared.length : close + (isLine ? 0 : 1);
      continue;
    }
    const rest = declared.slice(i);
    const m = /^([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(rest);
    if (m) names.push(m[1]);
    // Whether or not it matched, this member is being read now.
    atMemberStart = false;
  }
  return names;
}

/** Names bound by the destructuring (`a`, `b = 1`, `...rest`). */
function destructuredNames(destructured: string): Set<string> {
  const names = new Set<string>();
  let depth = 0;
  let atStart = true;
  for (let i = 0; i < destructured.length; i++) {
    const ch = destructured[i];
    if (ch === '{' || ch === '(' || ch === '[') {
      depth += 1;
      continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      continue;
    }
    if (depth === 0 && ch === ',') {
      atStart = true;
      continue;
    }
    if (depth !== 0 || !atStart || /\s/.test(ch)) continue;
    const m = /^\.{0,3}([A-Za-z_$][\w$]*)/.exec(destructured.slice(i));
    if (m) names.add(m[1]);
    atStart = false;
  }
  return names;
}

describe('$props(): declared and destructured cannot drift apart', () => {
  it('finds every component (the sweep is worthless if the walk is)', () => {
    expect(components.length).toBeGreaterThan(25);
    expect(components.map((c) => c.path)).toContain('components/AddWorkDialog.svelte');
    expect(components.map((c) => c.path)).toContain('lib/editor/ChapterEditor.svelte');
  });

  it('the parser reads a known component correctly (guards the guard)', () => {
    const rail = components.find((c) => c.path === 'components/LibraryRail.svelte');
    const block = propsBlock(rail!.source)!;
    expect(destructuredNames(block.destructured).has('railWorks')).toBe(true);
    const declared = declaredProps(block.declared);
    expect(declared).toContain('railWorks');
    expect(declared).toContain('onWorkRemove');
    // A nested type's own members are not props.
    expect(declared).not.toContain('navRole');
  });

  it('every declared prop is destructured', () => {
    const offenders: string[] = [];
    for (const component of components) {
      const block = propsBlock(component.source);
      if (!block) continue; // no $props() at all
      const bound = destructuredNames(block.destructured);
      for (const name of declaredProps(block.declared)) {
        if (!bound.has(name)) offenders.push(`${component.path}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
