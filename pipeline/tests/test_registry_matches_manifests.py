"""The work registry and the manifests must describe the same corpus.

`shared/lib/works.ts` is what the reader shows; `manifests/<Work>.yaml` is what
the pipeline builds. Nothing joins them at build time, so they drift silently,
and the drift has bitten before: SE is tlg_work 040 in its manifest while LSJ
cites 039, Juv is 918 against LSJ's 018 (docs/spec-lsj-citations.md decision 2),
and the difference went unnoticed for as long as it did because the two
namespaces agree everywhere else.

These are read-only cross-checks over the repo's own text — no corpus data, no
network — so they run in CI beside the rest of the pipeline suite.

The registry is TypeScript, so it is read with regexes rather than parsed. Each
one is anchored to the shape `works.ts` actually uses; a test that stops finding
anything fails loudly (see `test_the_registry_is_still_shaped_the_way_this_reads_it`)
rather than passing over an empty list.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
MANIFESTS = ROOT / "manifests"
WORKS_TS = ROOT / "shared" / "lib" / "works.ts"

# One entry per work in the WORKS array: `id: 'DA',` … up to the next `id:` at
# the same depth. Entries are flat objects two levels in, so the id line's
# indentation is the reliable boundary.
_ENTRY_RE = re.compile(r"\n  \{\n    id: '([A-Za-z]+)',(.*?)(?=\n  \{\n    id: '|\n\];)", re.S)
_TRANSLATION_RE = re.compile(r"\{ id: '([a-z0-9-]+)',[^}]*?\}")
_SLOTTED_RE = re.compile(r"\{ id: '([a-z0-9-]+)',[^}]*?slot: '(\w+)'[^}]*?\}")
_PRIVATE_RE = re.compile(r"\{ id: '([a-z0-9-]+)',[^}]*?private: true[^}]*?\}")


def _registry() -> dict[str, dict]:
    source = WORKS_TS.read_text(encoding="utf-8")
    works: dict[str, dict] = {}
    for work_id, body in _ENTRY_RE.findall(source):
        translations = _TRANSLATION_RE.findall(body)
        works[work_id] = {
            "body": body,
            "translations": translations,
            "slots": dict(_SLOTTED_RE.findall(body)),
            "private": _PRIVATE_RE.findall(body),
            # `...ACKRILL` and friends: a spread names a const declared above,
            # which is how a gated translation is kept out of a public bundle.
            "spreads": re.findall(r"\.\.\.([A-Z_]+),", body),
            "authenticity": (re.search(r"authenticity: '(\w+)'", body) or [None, None])[1],
        }
    return works


def _gated_consts() -> dict[str, list[str]]:
    """The `const X: TranslationRef[] = SHOW_PRIVATE ? [...] : []` declarations."""
    source = WORKS_TS.read_text(encoding="utf-8")
    out: dict[str, list[str]] = {}
    for name, body in re.findall(
        r"const ([A-Z_]+): TranslationRef\[\] = SHOW_PRIVATE \? \[(.*?)\] : \[\];", source, re.S
    ):
        out[name] = _TRANSLATION_RE.findall(body)
    return out


def _manifest(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _manifest_translation_ids(manifest: dict) -> list[str]:
    english = manifest.get("english") or {}
    ids: list[str] = []
    for slot in ("primary", "secondary", "third"):
        entry = english.get(slot)
        if entry and entry.get("id"):
            ids.append(entry["id"])
    for extra in english.get("overlays") or []:
        if extra.get("id"):
            ids.append(extra["id"])
    return ids


REGISTRY = _registry()
GATED = _gated_consts()
FULL_MANIFESTS = sorted(p for p in MANIFESTS.glob("*.yaml") if not p.stem.endswith("-public"))
PUBLIC_MANIFESTS = sorted(MANIFESTS.glob("*-public.yaml"))


def test_the_registry_is_still_shaped_the_way_this_reads_it():
    """The regexes above are the fragile part. If works.ts is restructured they
    stop matching, and every other test here would then pass over nothing."""
    assert len(REGISTRY) >= 40, f"read only {len(REGISTRY)} works from works.ts — the entry regex has gone stale"
    assert REGISTRY["Cat"]["translations"][:2] == ["edghill", "taylor"]
    assert REGISTRY["Cat"]["spreads"] == ["ACKRILL"]
    assert REGISTRY["Cat"]["slots"]["edghill"] == "english"
    assert GATED["ACKRILL"] == ["ackrill"]
    assert REGISTRY["VV"]["authenticity"] == "spurious"


@pytest.mark.parametrize("path", FULL_MANIFESTS, ids=lambda p: p.stem)
def test_every_manifest_has_a_registered_work(path):
    """A work the pipeline can build but the registry does not carry is a work
    nobody can reach: it is emitted into build/dist and no page links to it."""
    manifest = _manifest(path)
    work_id = manifest["work"]["id"]
    assert work_id == path.stem, f"{path.name} declares work.id {work_id!r}"
    assert work_id in REGISTRY, f"{work_id} has a manifest but no entry in shared/lib/works.ts"


def test_every_registered_work_has_a_manifest():
    """The other direction: a registry entry with no manifest renders a page
    whose data was never built."""
    have = {p.stem for p in FULL_MANIFESTS}
    missing = sorted(set(REGISTRY) - have)
    assert not missing, f"registered with no manifest: {', '.join(missing)}"


@pytest.mark.parametrize("path", FULL_MANIFESTS, ids=lambda p: p.stem)
def test_every_registered_translation_is_built_by_some_manifest(path):
    """A translation id in the registry that no manifest builds gives the
    reader a picker entry whose text is not in the data.

    Two shapes are legitimately un-nameable and are excluded, not waived:

    - A **Perseus-path primary** has no `english.primary` block at all (its
      prose comes from the milestoned eng2 TEI via `config.perseus_eng`), so
      its id exists only in the registry: EN's Rackham, Rhet's Freese.
    - The registry describes the **public** build, so a work with a
      `-public.yaml` may register a translation only that manifest builds —
      Politics offers Jowett + Ellis while `Pol.yaml` builds the gated Rackham
      primary that is never deployed.
    """
    manifest = _manifest(path)
    work_id = manifest["work"]["id"]
    entry = REGISTRY.get(work_id)
    if entry is None:
        pytest.skip("covered by test_every_manifest_has_a_registered_work")

    built = set(_manifest_translation_ids(manifest))
    public_path = MANIFESTS / f"{work_id}-public.yaml"
    if public_path.exists():
        built |= set(_manifest_translation_ids(_manifest(public_path)))

    registered = set(entry["translations"]) | {
        t for name in entry["spreads"] for t in GATED.get(name, [])
    }
    if not (manifest.get("english") or {}).get("primary"):
        registered -= {t for t, slot in entry["slots"].items() if slot == "english"}
    if not built:
        pytest.skip(f"{work_id}: no manifest names an english id (perseus path throughout)")

    unbuilt = sorted(registered - built)
    assert not unbuilt, f"{work_id}: registry offers {unbuilt} which no manifest for this work builds"


@pytest.mark.parametrize("path", PUBLIC_MANIFESTS, ids=lambda p: p.stem)
def test_a_public_manifest_drops_exactly_the_gated_translations(path):
    """The two halves of the gate have to agree: a translation the public
    manifest still builds but the registry hides is text on the server that no
    page cites, and one the registry still offers but the public manifest drops
    is a picker entry that 404s. Both are how a leak or a dead link starts."""
    work_id = path.stem[: -len("-public")]
    full = _manifest(MANIFESTS / f"{work_id}.yaml")
    public = _manifest(path)
    entry = REGISTRY[work_id]

    dropped = set(_manifest_translation_ids(full)) - set(_manifest_translation_ids(public))
    gated = {t for name in entry["spreads"] for t in GATED.get(name, [])} | set(entry["private"])
    assert dropped == gated, (
        f"{work_id}: {path.name} drops {sorted(dropped)}, "
        f"the registry gates {sorted(gated)} — the two halves of the gate disagree"
    )


def test_no_gated_translation_is_registered_unconditionally():
    """A private translation must reach the registry only through a
    SHOW_PRIVATE spread. Written inline it ships in every build."""
    for work_id, entry in REGISTRY.items():
        for translation in entry["private"]:
            assert False, (
                f"{work_id}: translation {translation!r} is marked private but is written "
                "inline in the entry, so it is in the bundle whatever the flag says"
            )


@pytest.mark.parametrize("path", FULL_MANIFESTS, ids=lambda p: p.stem)
def test_authenticity_agrees(path):
    """`work.authenticity` flows through stage 7 into manifest.json, and the
    registry drives the badge on the card. They are two copies of one fact."""
    manifest = _manifest(path)
    work_id = manifest["work"]["id"]
    if work_id not in REGISTRY:
        pytest.skip("covered by test_every_manifest_has_a_registered_work")
    assert manifest["work"].get("authenticity") == REGISTRY[work_id]["authenticity"], (
        f"{work_id}: manifest says {manifest['work'].get('authenticity')!r}, "
        f"registry says {REGISTRY[work_id]['authenticity']!r}"
    )
