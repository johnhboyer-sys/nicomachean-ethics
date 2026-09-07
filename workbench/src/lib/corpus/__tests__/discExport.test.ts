// Command construction for the Diogenes exporter. The macOS command here is
// the one that was actually run against a real disc (it exported all 41 works
// of Plato); the Windows expectations are inferred and marked as such, so a
// trip to a Windows machine has a written list of what to check.
import { describe, expect, it } from 'vitest';
import {
  buildDiscExportCommand,
  exportedWorkPath,
  perlCandidates,
  diogenesServerCandidates,
  platformFrom,
} from '../discExport';

const base = {
  corpus: 'tlg' as const,
  authorNumber: '0059',
  discDir: '/Users/x/TLG',
  diogenesServer: '/Applications/Diogenes.app/Contents/server',
  exportDir: '/tmp/out',
  platform: 'macos' as const,
};

describe('buildDiscExportCommand', () => {
  it('builds the command that really exports from a TLG disc', () => {
    const cmd = buildDiscExportCommand(base);
    expect(cmd.args).toEqual(['xml-export.pl', '-c', 'tlg', '-n', '0059', '-o', '/tmp/out']);
    expect(cmd.cwd).toBe('/Applications/Diogenes.app/Contents/server');
    expect(cmd.env.TLG_DIR).toBe('/Users/x/TLG');
  });

  it('points the PHI disc at PHI_DIR, not TLG_DIR', () => {
    // Diogenes reads a different variable per corpus; crossing them silently
    // exports nothing.
    const cmd = buildDiscExportCommand({ ...base, corpus: 'phi', authorNumber: '0474' });
    expect(cmd.env.PHI_DIR).toBe('/Users/x/TLG');
    expect(cmd.env.TLG_DIR).toBeUndefined();
    expect(cmd.args).toContain('phi');
  });

  it('passes no line switch by default, leaving Diogenes’ own judgment in charge', () => {
    const cmd = buildDiscExportCommand(base);
    expect(cmd.args).not.toContain('-y');
    expect(cmd.args).not.toContain('-Y');
  });

  it('forces verse with -y when lines are canonical', () => {
    expect(buildDiscExportCommand({ ...base, lineMode: 'lines' }).args).toContain('-y');
  });

  it('forces prose with -Y', () => {
    expect(buildDiscExportCommand({ ...base, lineMode: 'prose' }).args).toContain('-Y');
  });

  it('sets no PATH on any platform — Rust owns it', () => {
    // This used to pin /usr/bin:/bin on macOS "so the run does not depend on
    // the developer's shell". It never reached the child: run_program's
    // ALLOWED_ENV whitelist (src-tauri/src/assist.rs) keeps only TLG_DIR,
    // PHI_DIR and DDP_DIR and sets PATH itself from augmented_path(). Two
    // layers each believed they were hardening PATH; the Rust one won every
    // time. The env this builds now carries the disc variable and nothing else.
    for (const platform of ['macos', 'windows', 'linux'] as const) {
      const env = buildDiscExportCommand({ ...base, platform }).env;
      expect(env.PATH).toBeUndefined();
      expect(Object.keys(env)).toEqual(['TLG_DIR']);
    }
  });

  it('uses a configured perl over any platform guess', () => {
    const cmd = buildDiscExportCommand({ ...base, perlPath: '/opt/homebrew/bin/perl' });
    expect(cmd.program).toBe('/opt/homebrew/bin/perl');
  });
});

describe('exportedWorkPath', () => {
  it('names the file the way Diogenes really names it', () => {
    // Verified against real output: tlg0059030.xml is Respublica.
    expect(exportedWorkPath('/tmp/out', 'tlg', '0059', '030')).toBe(
      '/tmp/out/Diogenes-Resources/xml/tlg/tlg0059030.xml',
    );
  });

  it('tolerates a trailing slash on the export dir', () => {
    expect(exportedWorkPath('/tmp/out/', 'tlg', '0086', '001')).toBe(
      '/tmp/out/Diogenes-Resources/xml/tlg/tlg0086001.xml',
    );
  });
});

describe('perlCandidates', () => {
  it('uses the system perl on macOS, as Diogenes itself does there', () => {
    expect(perlCandidates('macos', base.diogenesServer)[0]).toBe('/usr/bin/perl');
  });

  it('offers bundled locations first on Windows, then PATH', () => {
    // INFERRED, not verified — these are the paths to check on a Windows box.
    const candidates = perlCandidates('windows', 'C:/Program Files/Diogenes/resources/app/server');
    expect(candidates.some((c) => c.endsWith('perl.exe'))).toBe(true);
    expect(candidates[candidates.length - 1]).toBe('perl');
  });

  it('always ends with a bare perl, so a machine with one on PATH still works', () => {
    for (const p of ['macos', 'windows', 'linux'] as const) {
      expect(perlCandidates(p, '/x/server')).toContain('perl');
    }
  });
});

describe('platform detection', () => {
  it('maps the OS names Tauri reports', () => {
    expect(platformFrom('Darwin')).toBe('macos');
    expect(platformFrom('macos')).toBe('macos');
    expect(platformFrom('windows_nt')).toBe('windows');
    expect(platformFrom('linux')).toBe('linux');
  });

  it('treats an unknown OS as linux rather than failing', () => {
    expect(platformFrom('freebsd')).toBe('linux');
  });

  it('reads the platform out of a webview user agent', () => {
    // How the app actually detects it — no OS plugin dependency.
    expect(platformFrom('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macos');
    expect(platformFrom('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(platformFrom('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });

  it('offers an install location for every platform', () => {
    for (const p of ['macos', 'windows', 'linux'] as const) {
      expect(diogenesServerCandidates(p).length).toBeGreaterThan(0);
    }
  });
});
