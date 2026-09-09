# Workbench Tauri backend — security review, 2026-09-07

A read-only review of `workbench/src-tauri` (Rust, `tauri.conf.json`,
`capabilities/default.json`) against the trust boundary the capability file's
own `description` field states at length. Nothing here was run under cargo —
this container has no Rust toolchain — so every claim below is from reading the
code, with the file and line that decides it.

Two things were fixed on `claude/weekly-usage-catchup-h8go43`; everything else
is recorded here for John, not acted on.

## The finding that matters

**`assist_run` and `run_program` together are an unrestricted local-exec
primitive, and the capability description's mitigation is the wrong one.**

Rust checks two things about the executable: that the path is absolute and that
it is an executable file (`assist.rs:183-187`, `411-415`). That is all. There is
no allow-list, and no record that the path came from a native picker. The
description says "the binaries actually invoked come from the fixed built-in
tool registry (Claude Code / Codex / Gemini) plus the user's explicit custom
command config" — that is a **frontend convention**, not a backend guarantee.

The consequence is that the carefully scoped `shell:allow-execute` validators in
the same capability file (`^\d{4}$` on the Diogenes author number, three pinned
absolute pandoc paths) are decorative: `run_program` is a strictly more powerful
sibling with no validation at all, and the disc importer already goes through it
(`src/lib/import/discImport.ts`) rather than the validated shell scope — whose
`diogenes-export` entry is now referenced only by a dead constant in
`src/lib/data/onboarding.ts`.

So the boundary really reduces to **the webview must never execute
attacker-controlled JavaScript**, which makes the CSP the load-bearing control
rather than the argv and path checks. The CSP is sound (below), so this is not
exploitable today. But the security argument in the description rests on a
control that is not doing the work.

Two ways out, neither taken here because both are John's call:

1. Have Rust hold the set of picker-approved binaries — record the path when
   the native dialog returns it, refuse anything not in that set. This is the
   real fix and makes the description true.
2. Or state plainly in the description that the CSP is what stands between
   remote-fetched content and code execution, and treat it accordingly.

## What was fixed here

- **CSP gained `base-uri 'self'`, `form-action 'self'` and `object-src 'none'`**
  (`tauri.conf.json`). None of the three fall under `default-src`, so injected
  markup could previously carry a `<base href>` or a `<form action>` to a remote
  origin. Script injection was already blocked — there is no `script-src`, so
  scripts fall back to `default-src 'self'` with no `unsafe-inline` and no
  `unsafe-eval` — which is exactly why the `{@html}` sinks below are markup
  injection rather than code execution.
- **The disc exporter stopped pinning `PATH`.** `buildDiscExportCommand` set
  `PATH=/usr/bin:/bin` "so the run does not depend on the developer's shell",
  and `run_program` dropped it as outside `ALLOWED_ENV` and then set `PATH`
  itself from `augmented_path()`. Two layers each believed they were hardening
  `PATH`; the Rust one won every time. The frontend now says nothing about it,
  so the ownership is legible: change `augmented_path()` to change it.

## Recorded, not fixed

Rust changes are not made in a container that cannot compile them.

- **A hostile lexicon pack can inject markup.** `packs.rs` is careful — its
  header says "the user picked it is not evidence we built it" and it validates
  the manifest accordingly — but the shard *contents* are rendered raw
  (`LexiconDrawer.svelte`, `{@html entry.html}`, fed from pack shard JSON via
  `lexicon/provider.ts`). Bounded to markup by the CSP. The fix is to sanitize
  at the provider boundary; the workbench has no sanitizer of its own and is
  deliberately isolated from `shared/`, so this needs a decision about which.
- **`run_with_timeout` can hang forever.** `child.kill()` kills the direct child
  only, then the function blocks joining the stdout/stderr reader threads, which
  return at pipe EOF. A CLI that forks a surviving grandchild holding the
  inherited pipe leaves both readers blocked, the `spawn_blocking` task never
  returns, and its pool thread is gone for the session. "Rust owns the timeout"
  is true of the child and not of the call. Wants a process-group kill or a
  read deadline.
- **`timeout_ms` is an unclamped `u64` from the frontend.** On macOS `Instant`
  is nanosecond-backed, so a large value overflows and panics *after* the child
  is spawned, orphaning it; the panic surfaces as a bland failure. Wants a clamp.
- **`extract_all` caps neither entry count nor uncompressed size** — a crafted
  pack is a disk filler. Real packs are 127–225 MB, so a generous cap is free.
- **The absolute-path check is lexical**: not canonicalized, and symlinks are
  followed. No containment is claimed, and an attacker who can name
  `/tmp/evil` via a symlink could name it directly, so this is a documentation
  nuance rather than a hole — but "ABSOLUTE executable" invites a reader to
  infer a containment that is not there.

## Verified sound

Each of these was checked against the code rather than assumed.

- **No shell ever parses a prompt or an argv element.** The only shell
  invocation is `assist.rs:114`, and only with a validated identifier; the two
  exec paths use an argv array under `execve`.
- **`is_safe_bin_name` is unbypassable by anchoring tricks.** It is a byte-wise
  `all()` over the whole string (`assist.rs:89-94`), which cannot have the
  forgotten-anchor or multiline-`$` bug a regex can, and it rejects the empty
  string. It is applied on the sole path to the shell, before interpolation, and
  nothing else reaches that string.
- **`argv[0]` cannot be spoofed** — `arg0()` is never called.
- **`ALLOWED_ENV` is a real whitelist, really applied** (`assist.rs:394`,
  `420-426`), pinned by its own tests. The one overstatement is that there is no
  `env_clear()`, so the child still inherits the *parent's* environment; the
  frontend cannot set that, so it is hardening rather than a hole, and for a
  Finder-launched `.app` the parent environment is launchd's minimal one anyway.
- **The cwd fallback holds**: a non-directory falls through to a neutral temp
  dir, pinned by a test.
- **Zip extraction is traversal- and symlink-safe**: `enclosed_name()` plus a
  second lexical containment check, and the loop only ever creates directories
  and regular files — it never reconstructs a symlink entry and never applies
  the archive's unix mode, so nothing extracted carries the execute bit. The
  code never calls `ZipArchive::extract()`, the API implicated in the zip 2.x
  advisories.
- **`remove_lexicon_pack` validates before joining** — `language` is checked
  against a two-element list before it reaches `root.join`.
- **Model output is escape-first** (`assist/markdown.ts`) and its link hrefs are
  scheme-checked.
- **No remote content is loaded as a document**, and the capability has no
  `remote` field, so no remote origin is ever granted IPC. The three LLM hosts
  and `raw.githubusercontent.com` appear only in `connect-src`.
- **`assist_run`'s stderr redaction holds**: full stderr goes to the log, the
  frontend gets only a kind. `run_program` returning stderr is the documented,
  deliberate difference for diagnosing pandoc.

## Drift between the capability description and the code

The description is long and predates some of the code. Worth a pass when the
above is settled:

1. The "binaries come from the fixed registry" clause describes the frontend.
2. "PATH, PERL5LIB, DYLD_* are dropped" is true of frontend-supplied values only.
3. It is silent on three of the six registered commands —
   `install_lexicon_pack`, `list_lexicon_packs`, `remove_lexicon_pack` — which
   parse an untrusted archive and recursively delete under app data.
4. It is silent on `opener:allow-open-path`, an application-launch primitive
   granted unscoped; the frontend only uses `revealItemInDir` today.
5. "The `fs:allow-exists` scope covers onboarding's existence checks only" —
   the grant's scope is `/**`, which makes the Diogenes entry beside it
   redundant. The sentence describes intent, not scope.
6. The `diogenes-export` shell scope is dead (see above).
7. The bare `perl` / `perl.exe` fallbacks in `perlCandidates` can never spawn
   through `run_program`, which rejects a non-absolute path.
