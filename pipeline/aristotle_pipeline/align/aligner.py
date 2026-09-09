"""Chapter-scoped translation aligner (option 2: Rackham as reference).

Per chapter, embed the Rackham reference segments (each a real Bekker anchor)
and the Ross target sentences, run a monotonic DP over the similarity matrix to
map each anchor to a Ross sentence offset, then interpolate single lines by
Greek word-count. Confidence is the cosine margin (best minus second-best).
Output offsets are into each chapter's Ross prose — the unit the reader and
stage1_ross already store.
"""

from __future__ import annotations

import json
import re
import statistics
from dataclasses import asdict, dataclass, field

from ..config import BUILD_DIR
from . import similarity
from .reference import ChapterRef, load_chapters

MARGIN_OK = 0.05            # cosine margin below this -> review queue
RATIO_SD = 1.5             # length-ratio outlier threshold (SDs)
_PROPER = re.compile(r"(?<!^)(?<![.!?]\s)\b[A-Z][a-z]{2,}\b")


@dataclass
class Anchor:
    citation: str
    offset: int
    tier: str
    confidence: str
    score: float = 0.0
    flags: list = field(default_factory=list)


# ---- offset-preserving sentence split -------------------------------------
def split_sentences(text: str, start: int = 0) -> list[tuple[int, str]]:
    out = [(start + m.start(), m.group().strip())
           for m in re.finditer(r'[^.!?]*[.!?]+(?:["\')\]]+)?\s*', text) if m.group().strip()]
    return out or [(start, text)]


# ---- monotonic DP: each ref segment -> a sentence, non-decreasing ----------
def monotonic_align(S: list[list[float]]) -> list[tuple[int, int, float, float]]:
    G, E = len(S), len(S[0])
    NEG = -1e9
    dp = [[NEG] * E for _ in range(G)]
    bk = [[-1] * E for _ in range(G)]
    dp[0] = S[0][:]
    for i in range(1, G):
        best, arg = NEG, 0
        for j in range(E):
            if dp[i - 1][j] > best:
                best, arg = dp[i - 1][j], j
            dp[i][j] = S[i][j] + best
            bk[i][j] = arg
    j = max(range(E), key=lambda j: dp[G - 1][j])
    path = []
    for i in range(G - 1, -1, -1):
        row = sorted(S[i], reverse=True)
        margin = float(row[0] - (row[1] if len(row) > 1 else 0.0))
        path.append((i, j, float(S[i][j]), margin))
        j = bk[i][j] if i > 0 else j
    return list(reversed(path))


# ---- single-line interpolation by Greek word-count ------------------------
def interpolate(ch: ChapterRef, anchors: list[Anchor]) -> list[Anchor]:
    cum = {g.citation: g.cum_words for g in ch.greek_lines}
    order = [g.citation for g in ch.greek_lines]
    pos = {c: i for i, c in enumerate(order)}
    placed = {a.citation for a in anchors}
    out: list[Anchor] = []
    anchored = [a for a in sorted(anchors, key=lambda a: a.offset) if a.citation in cum]
    for a, b in zip(anchored, anchored[1:]):
        ca, cb = cum[a.citation], cum[b.citation]
        span_w, span_o = cb - ca, b.offset - a.offset
        if span_w <= 0 or span_o <= 0:
            continue
        for c in order[pos[a.citation] + 1: pos[b.citation]]:
            if c in placed:
                continue
            off = a.offset + round((cum[c] - ca) / span_w * span_o)
            off = _snap_word(ch.ross_text, off)
            out.append(Anchor(c, off, "line", "interpolated"))
    return out


def _snap_word(text: str, off: int) -> int:
    off = max(0, min(off, len(text)))
    if 0 < off < len(text) and text[off] != " ":
        left, right = text.rfind(" ", 0, off), text.find(" ", off)
        cands = [c + 1 for c in (left, right) if c != -1]
        if cands:
            return min(cands, key=lambda c: abs(c - off))
    return off


# ---- per-chapter alignment ------------------------------------------------
def align_chapter(ch: ChapterRef, backend: str, overrides: dict | None = None) -> list[Anchor]:
    refs = ch.ref_incipits()
    sents = split_sentences(ch.ross_text)
    S = similarity.cos_matrix(refs, [s for _, s in sents], backend)
    anchors: list[Anchor] = []
    for i, j, score, margin in monotonic_align(S):
        ra = ch.ref_anchors[i]
        off = 0 if ra.tier == "chapter" else sents[j][0]
        conf = "certain" if ra.tier == "chapter" else ("reliable" if margin > MARGIN_OK else "uncertain")
        a = Anchor(ra.citation, off, ra.tier, conf, round(score, 4))
        if ra.tier != "chapter" and margin <= MARGIN_OK:
            a.flags.append(f"low_margin:{margin:.3f}")
        anchors.append(a)
    _flag_ratio_outliers(ch, anchors, refs, sents)
    _flag_proper_names(ch, anchors, refs)
    # Apply verifier overrides (offsets re-placed by direct reading) before
    # de-dup + interpolation so single lines re-interpolate around the fix.
    if overrides:
        for a in anchors:
            if a.citation in overrides:
                a.offset = max(0, min(overrides[a.citation], len(ch.ross_text)))
                a.confidence = "confirmed"
                a.flags = [f for f in a.flags if not f.startswith("low_margin")]
                a.flags.append("verified")
    # de-dup offsets keeping the most confident; keep monotonic non-decreasing
    anchors = _dedup_monotonic(anchors)
    anchors += interpolate(ch, anchors)
    return sorted(anchors, key=lambda a: (a.offset, a.citation))


def _dedup_monotonic(anchors: list[Anchor]) -> list[Anchor]:
    out: list[Anchor] = []
    last = -1
    for a in anchors:
        if a.offset < last:
            a.offset = last
            a.flags.append("nonmonotonic_clamped")
        out.append(a)
        last = a.offset
    return out


def _flag_ratio_outliers(ch, anchors, refs, sents):
    if len(anchors) < 4:
        return
    rbounds = [a.off for a in ch.ref_anchors] + [len(ch.ref_text)]
    ratios = []
    for k, a in enumerate(anchors[:-1]):
        rlen = (rbounds[k + 1] - rbounds[k]) or 1     # Rackham span length
        olen = (anchors[k + 1].offset - a.offset) or 1  # matched Ross span
        ratios.append(olen / rlen)
    if len(ratios) < 3:
        return
    mu, sd = statistics.mean(ratios), statistics.pstdev(ratios) or 1.0
    for k, r in enumerate(ratios):
        if abs(r - mu) > RATIO_SD * sd:
            anchors[k].flags.append(f"ratio_outlier:{r:.2f}")


def _flag_proper_names(ch, anchors, refs):
    for k, a in enumerate(anchors):
        if a.tier == "chapter" or k >= len(refs):
            continue
        names = set(_PROPER.findall(refs[k]))
        if not names:
            continue
        window = ch.ross_text[a.offset:a.offset + max(len(refs[k]) * 2, 200)]
        missing = [n for n in names if n not in window]
        if missing:
            a.flags.append("name?:" + ",".join(sorted(missing)[:3]))


# ---- guards + driver ------------------------------------------------------
def check_roundtrip(ch: ChapterRef, anchors: list[Anchor]):
    """Every anchor must be a usable cut point in this chapter's prose.

    Take the offsets in the order align_chapter emits them. Sorting them first
    and filtering out-of-range ones (as this did) makes the round-trip assert
    vacuous: slicing a string at ANY sorted, in-range list of points and
    re-joining always reproduces it. The two repairs were precisely the two
    corruptions worth catching — an override placed past the end of the prose
    (a map built against a different parse of the translation) and an anchor
    that regressed behind its predecessor.
    """
    n = len(ch.ross_text)
    where = f"{ch.book}:{ch.chapter}"
    bad = [(a.citation, a.offset) for a in anchors if not 0 <= a.offset <= n]
    assert not bad, f"offset outside {where} prose (0..{n}): {bad[:5]}"
    pts = [a.offset for a in anchors]
    assert pts == sorted(pts), (
        f"anchors out of order in {where}: "
        f"{[(a.citation, a.offset) for a in anchors][:8]}"
    )
    segs = [ch.ross_text[i:j] for i, j in zip([0] + pts, pts + [n])]
    assert "".join(segs) == ch.ross_text, f"round-trip failed in {where}"


def align(work_id="EN", version_id=None, target_prose=None, backend="lexical",
          books=None, provider="milestoned"):
    if target_prose is None:
        from .reference import default_target
        version_id, target_prose = default_target(work_id)
    if provider == "gloss":
        from .reference import load_gloss_chapters
        chapters = load_gloss_chapters(target_prose, work_id, books)
    else:
        chapters = load_chapters(target_prose)
        if books:
            chapters = [c for c in chapters if c.book in books]
    overrides_all = {}
    if provider == "gloss":
        ovr_path = BUILD_DIR / "align" / f"{work_id}_{version_id}_gloss_overrides.json"
        if ovr_path.exists():
            overrides_all = json.loads(ovr_path.read_text(encoding="utf-8"))

    out: dict[str, dict] = {}
    review: list[dict] = []
    for ch in chapters:
        anchors = align_chapter(ch, backend, overrides_all.get(f"{ch.book}:{ch.chapter}"))
        check_roundtrip(ch, anchors)
        key = f"{ch.book}:{ch.chapter}"
        out[key] = {"ross_len": len(ch.ross_text),
                    "anchors": [asdict(a) for a in anchors]}
        for a in anchors:
            if a.flags or a.confidence == "uncertain":
                ctx = ch.ross_text[a.offset:a.offset + 90].replace("\n", " ")
                review.append({"chapter": key, "citation": a.citation, "tier": a.tier,
                               "confidence": a.confidence, "score": a.score,
                               "flags": a.flags, "context": ctx})

    out_dir = BUILD_DIR / "align"
    out_dir.mkdir(parents=True, exist_ok=True)
    tag = version_id if provider == "milestoned" else f"{version_id}_gloss"
    (out_dir / f"{work_id}_{tag}_map.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    (out_dir / f"{work_id}_{tag}_review.json").write_text(
        json.dumps(review, ensure_ascii=False, indent=1), encoding="utf-8")

    tiers = {}
    total = 0
    for v in out.values():
        for a in v["anchors"]:
            tiers[a["tier"]] = tiers.get(a["tier"], 0) + 1
            total += 1
    return {"chapters": len(out), "anchors": total, "tiers": tiers,
            "review": len(review), "out_dir": str(out_dir)}
