# Send result screenshots in Telegram

Starting point: accepted and deployed `66d0c115e8b006868d0c4a837efb837ce9866ec6`.
Lifecycle updates, reliable conversation parts, phone links and exact-result
revisions already exist. Do not rebuild them. This slice closes one gap:
asking the assistant for a result's screenshots should deliver the saved image
files directly to the authorized Telegram conversation.

## The experience

An operator asks, "Show me the screenshots from that result." The shared chat
engine selects saved evidence for that exact task and result. Telegram sends
each verified original image as a downloadable document, with a short caption
identifying its task and result. No private file paths, invented screenshots,
extra mandatory preview messages or paragraphs of delivery instructions.

The image message binds to that same task and run. Replying "Fix the spacing"
uses the existing confirmed revision flow. A later result must not silently
replace the image's identity. Existing stale-result protections still apply:
when a newer revision exists, say so and ask which result to use.

This slice covers **on-demand conversation evidence**, not automatic screenshot
fan-out with every lifecycle notification. Automatic updates retain their
existing exact-result links. No Slack, Discord or Teams changes in this task.

## Grounded implementation

1. Add one shared authorized evidence lookup/selection path for the chat tools,
   reused by Telegram instead of a separate task system. Prefer a focused
   structured addition to the existing result read or one evidence read tool.
   Return only trusted artifact/task/run identities and safe short metadata.
   Never parse assistant prose, an arbitrary path or a URL as authorization.
   Keep the selection durably bound to the completed chat turn so a crash after
   the model completes can recover it without another model call. Do not send
   evidence selected by a failed/revoked turn.
2. `readChatResult` in chat-review.ts currently requires a terminal diff for
   its revision snapshot. Do not weaken that contract just to expose images.
   An evidence reader must handle valid finished report/read-only/no-image
   results honestly as well, without silently substituting a builder result.
   Use project access, exact run/task ownership and artifactForRun; a hash or
   descriptor alone proves neither access nor ownership.
3. Before every upload, including retries, read through readVerifiedArtifact,
   reject failed/truncated/redacted captures, enforce the existing 5 MiB local
   screenshot bound, and validate actual PNG/JPEG bytes with
   validateScreenshotBytes. Preserve the original verified bytes; do not
   transform evidence. Missing, tampered, unsupported or oversized artifacts
   need a short visible explanation and the exact result control when a trusted
   remote origin is available. Never claim that an image was delivered.
4. createTransport in telegram.ts currently serializes every call as JSON.
   Add an explicit typed multipart path for sendDocument using FormData/Blob;
   let fetch set the boundary. Keep ordinary JSON calls unchanged, as well as
   abort behavior, token scrubbing, retry_after and uncertain acknowledgements.
   No URL fetch by Telegram, arbitrary filesystem upload or paid broadcasting.
   Official reference: https://core.telegram.org/bots/api#senddocument (checked
   September 16: multipart documents up to 50 MB, captions up to 1024 chars).
   The stricter existing local image limit remains unchanged.
5. Extend the existing durable conversation-part mechanism minimally. It only
   permits reply/card today. A small explicit versioned schema extension for
   media identity is allowed in this task if needed; preserve every existing
   row/receipt, claims, order and uncertain counts. Use typed descriptors, not
   hidden JSON inside text or keyboards, and do not store image bytes in SQLite.
   A confirmed part never resends. A lost acknowledgement is honestly uncertain
   and may duplicate; do not promise exactly-once Telegram delivery.
6. Recheck current pairing, approver generation, project/channel access, claim
   ownership and selected artifact provenance after awaits and immediately
   before uploading. Access revoked while awaiting must prevent the send. Read
   bytes again on retry. Respect the existing shared bot-wide rate limit. Bind
   each confirmed image message into the existing exact task/run reply routing.

Use the existing engine and structured tool contract for every supported chat
provider. The change must not depend on model-specific text formatting, a
particular subscription provider, a branch-only workflow, or this repository's
current task. Web and CLI should expose the same authorized evidence selection
and result identity; do not claim they displayed or downloaded files merely
because metadata was returned. Telegram capability descriptions must state
what is directly supported and what remains a link or real-device gap.

## Lean acceptance evidence

Add small regressions to the existing affected suites where possible:

- Drive the actual HTTP adapter with mocked fetch and inspect multipart method,
  boundary handling, file name/type, original byte content and short caption.
  Test the real JSON path too; a scripted transport alone misses serialization.
- Real shared chat/evidence reads: two authorized projects, one excluded,
  exact older result versus a newer current result, and a report/no-image case.
  Fabricated/wrong-run artifact IDs must never select another task's image.
- Missing/tampered/wrong-kind/oversized/failed/shortened/redacted evidence,
  changed artifact provenance and access revoked across an awaited registry
  read. No excluded-project details or credential/path text in captions/errors.
- Persist and reopen mid-reply: confirmed text/image parts do not resend;
  remaining media resumes from durable identity without rerunning the model.
  Test explicit rejection, retry_after, malformed/lost acknowledgement and
  uncertain counts, using the existing retry mechanisms.
- Reply to a confirmed image and use existing confirmed feedback/revision
  actions. Assert exact task/run/history in both chat and ordinary UI-facing
  state, including a stale-result refusal; do not bypass scope approval.
- If the schema changes, test forward migration preserving existing v63
  conversation-part rows/receipts, restart and fail-closed old-runtime behavior.
  No migration of the live installation in this build.

During implementation run typecheck and affected tests only. Reuse prior valid
unchanged evidence; do not re-audit lifecycle producers. The native final gate
runs the unchanged approved full command once for the finished candidate:
`npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build`.
Do not remove tests, add skips or weaken verification to reduce runtime.

Update this document with a concise fixture transcript, exact checks, schema
choice and remaining gaps. Real bot token/pairing, private Tailscale HTTPS and
physical-phone rendering are unavailable here. Do not fabricate screenshots,
claim an actual Telegram send, alter live settings or publish/deploy in the
builder. Keep UI wording plain, short and nonredundant; important failures,
exact result identity and approvals must remain visible.
