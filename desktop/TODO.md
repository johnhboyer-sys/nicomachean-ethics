# Desktop TODO

Known, reproduced defects in the desktop app that no other document owns. Not a
handoff (there is no desktop track handoff) and not a wishlist — every item here
was traced to a line of source by a review, and each says what breaks and for
whom. Delete an item when it is fixed, with the commit that fixed it.

Deploy state and site-wide history live in `DEPLOY-STATUS.md` at the root.

## Lettered Bekker lines, in the desktop only

A lettered Bekker line is its own line: `shared/lib/data.ts` spells it with
`lineRef(n, sub)` and anchors it as `L775a-11a`. Generation of Animals 775a is
the case that forces the issue — the TLG source prints `11a`, `11b`, `11c` and
no bare `11`, the only such group in the corpus (38 groups repeat a line number;
the other 37 keep an unlettered first record).

The site half was fixed on 2026-09-09 (`dc84839`, `06682ba`, `a2b1507`): the
lemma link, the printed citation, search, and the reader's snap-to-nearest all
carry the letter now. **These four are the desktop's share, and none is fixed.**
All were traced in source by Codex's review of that work; none is reproduced at
runtime, so confirm each before fixing.

1. **Annotation capture rejects a lettered line id.**
   `desktop/src/lib/annotations.ts:181` — `lineIdOf` accepts only a numeric
   line, so `captureSelection` returns null and `App.svelte:571` abandons the
   action without a message. *Effect:* you cannot highlight or note anything on
   775a11a — the control appears to do nothing. The annotation target type also
   has no field for the suffix, so fixing the parser is not enough on its own.

2. **The scroll tracker cannot turn a lettered anchor into a citation.**
   `shared/components/Reader.svelte:438` — `citeOf('L775a-11a')` returns null,
   so the hash and the saved reading position keep the last unlettered line.
   *Effect:* scroll from 775a10 onto 11a and the URL still says 775a10; desktop
   Copy Citation then cites line 10. Silent and wrong, which is the bad kind.

3. **Both copy formatters leave the anchor's hyphen in the citation.**
   `shared/components/Reader.svelte:1145` and
   `desktop/src/lib/annotations.ts:200` — an id of `L775a-11a` becomes
   `775a-11a`, so a copied citation reads `(GA 775a-11a)`. *Effect:* pasting
   that back into Bekker Jump fails to parse, because `parseBekker` expects
   `775a11a`. Two implementations of one rule; they should agree by construction
   (`lineRef` already spells it correctly).

4. **The command palette has its own citation parser, and it is stricter.**
   `shared/lib/palette.ts:14` rejects the lettered citations `BekkerJump` now
   accepts. *Effect:* typing `775a11a` into ⌘K offers a corpus search instead of
   a jump, and the desktop's `currentCitation` rejects a valid `#775a11a` hash.
   The real fix is one parser, not two: `parseBekker` in `shared/lib/data.ts`
   already handles the suffix.

**Also unchanged, deliberately:** the snap-to-nearest ignores a wrapped
continuation line, whose only id ends `-c`. It did so before the 2026-09-09 work
too, so this is a known limit rather than a regression.

## Storage and concurrency

5. **`TauriStorage.write` is truncate-and-write in the Workbench.**
   A crash mid-save leaves a file the parser refuses. The desktop's stores were
   converted to write-then-rename on the catch-up branch and its capability
   grant added; the Workbench was not, and needs `fs:allow-rename` in its
   capabilities. Carried from `HANDOFF-CATCHUP.md`; the Workbench half belongs
   to `workbench/SESSION-HANDOFF.md`, noted here because the two stores are the
   same code.

6. **Concurrent annotation changes can overwrite one another.**
   `desktop/src/lib/annotations.ts:150` — two actions can derive their
   replacement list from the same cached `entry.anns`, because the cache only
   changes after the write. *Effect:* save an edit to note A, then delete note B
   before the first write lands, and the deletion restores A's old text. The
   panel leaves both controls enabled during a save. Both writes also share one
   `.tmp` filename (`desktop/src/lib/runtime.ts:71`), so overlapping writes can
   rename each other's bytes. Atomic replacement does not serialise a
   read-modify-write; the fix is a queue or a version check, not a better
   rename. From Codex's review of PR #110.

## Provenance

Items 1–4 and 6 come from adversarial reviews run on 2026-09-08/09 against the
catch-up branch (Codex on PR #110 and on the lettered-line fix). Item 5 is from
`HANDOFF-CATCHUP.md`, whose branch is now merged. Every one is CONFIRMED by
source trace and UNVERIFIED at runtime — reproduce before fixing, and write the
failing test first.
