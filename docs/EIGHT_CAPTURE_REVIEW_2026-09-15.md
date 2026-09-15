# Finish the phone review evidence

Preserve candidate 78573019, including deployed 8efa954 and the existing phone
fix. This is an evidence-only follow-up, not another UI redesign.

Review 1621 upheld c1 and c4, but could not establish c2 and c3 from the sealed
images. The root cause is concrete: `PROOF_LIMITS.screenshots` is eight. The
journey produces eleven images, and the previous selection omitted required
states. Adding every image to the proof would be invalid. Do not raise the cap.

## Deliver exactly eight useful screenshots

Extend the existing journey only where a capture point is missing. Run the
journey and put these eight real viewport PNGs into `proof.screenshots`:

1. Desktop empty chat.
2. Desktop confirmed stop, showing its task identity, Stopping and saved draft.
3. Separate task-detail page for that SAME task while Stopping. Capture it
   before changing its state; do not label a chat header as task detail.
4. Phone stale-card refusal with the draft intact.
5. Desktop result Changes tab with readable diff.
6. Phone result Changes tab with readable diff.
7. Desktop revision receipt in the same task family.
8. Phone revision receipt while typing, showing the action above the composer.

Use accurate captions and criterion references. The long title, empty state,
refusal and typing states must remain visible at the real 1440px/390px
viewports. No long full-page images or collages. This is synthetic browser
evidence, not a physical-phone or live-provider claim.

Update the existing assessment to distinguish the eight sealed images from
other optional captures. Label the manifest's revision `captureSourceHead`:
it identifies the product source when images were captured, not the later
commit that stores those images. Preserve checksums and provenance honestly.

## Verification and limits

Run typecheck and affected checks only. Leave the unchanged approved full
verification command to the native final gate once. Do not add another test
suite, change the verifier, erase historical reviews, or modify approval,
evidence or product behavior. A saved builder journey log is not the machine
gate's log; label it accordingly. Use the actual sealed screenshots, inherited
control source and existing focused behavior tests to support the criteria.
Do not claim missing proof passes. Record any remaining gap specifically.

Allowed work is the existing journey script, its evidence PNGs/manifest/log,
the existing assessment and this brief. Keep this revision in the same family.
