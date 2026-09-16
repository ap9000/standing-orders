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

## Implementation record (2026-09-16, builder)

Built on `66d0c11` as the accepted baseline. Fixture evidence only: a
scripted Bot API and a scripted membership harness. No bot token, pairing,
private HTTPS, live database or phone was touched, and no screenshot below
is claimed to have reached a Telegram client.

### What exists now

- **Shared selection** — `src/chat-evidence.ts`. `selectResultImages`
  proves the same access `readChatResult` proves (project in the approver's
  ceiling, run belongs to that task and finished), then reads every
  `screenshot` artifact of that run through `readVerifiedArtifact` and
  `validateScreenshotBytes`. Failed, shortened, redacted, oversized,
  wrong-kind, tampered or missing records come back as `unavailable` with
  a plain reason; a scout's report or a result with no images is answered
  with an empty list and `report: true/false`, never a substituted builder
  result. `readChatResult` is untouched and still requires the terminal
  diff. Without a run, only the current version is selected; a newer
  revision is refused in words, never switched to. With a run, the exact
  older result is selected and captioned `· older version`.
- **One structured tool** — `get_result_images` in `src/mate-tools.ts`,
  shared by every chat provider (direct API and subscription harness, web,
  CLI and Telegram alike). It returns trusted identities and short
  metadata only (task, root, currentExecution, run, artifact ids, format,
  bytes, caption, unavailable reasons) plus one `delivery` line the model
  repeats: on Telegram "N image file(s) will be sent … say they follow";
  elsewhere "This surface does not send image files". The mate contract
  (v12) tells the model to say the files follow, never that they were
  delivered, and to ask which result when a newer revision is current.
- **Durable selection under the turn** — `mate_turn_evidence` (v64). The
  tool records each selected artifact under the running turn (cap 8 per
  turn, deduplicated). A failed, revoked or swept turn deletes its rows
  with its drafts. Telegram plans image parts only from a turn whose state
  is `answered`, so a crash after the model finished recovers the exact
  selection from the row without another model call.
- **Typed media identity on the durable parts** — `telegram_conversation_part`
  admits `kind = 'image'` with `task_id`, `source_run`, `artifact` and
  `sha256` columns (CHECK-enforced: an image has all four, nothing else has
  any). The caption is the part's text. No bytes in SQLite, no JSON inside
  text or keyboards. A confirmed image message joins
  `telegramMessageBindings`, so replying to it pins the exact task and run
  through the existing `replyContextFor` road and the existing
  `get_result` → `propose_review` revision flow.
- **Multipart transport** — `createTransport` accepts an optional typed
  `TelegramUpload` (field `document`, file name, `image/png|jpeg`, verified
  bytes). With it the call is `FormData` with one `Blob`; fetch mints the
  boundary and content type. Without it every call is the JSON request it
  was, byte for byte. Token scrubbing, retry_after, abort and the uncertain
  acknowledgement rules apply to both roads. There is no `file_id`, URL or
  path form: Telegram never fetches anything and nothing is uploaded by name.
- **Send-time proof** — before every upload, including retries, the bridge
  re-reads the registry, re-proves pairing, approver generation and ceiling
  (`telegramChannelProblem`), holds the claim, then `verifyResultImage`
  re-checks the task is still in the phone's projects, the run still its
  own, the artifact row unchanged (same run, same recorded hash), reads the
  bytes again and re-validates PNG/JPEG under the 5 MiB bound. A refusal
  drops the part with its reason and sends one plain notice with a
  **Review result** button under a trusted origin. A revoked ceiling fails
  the whole row exactly as a text reply does. Telegram's own refusal,
  retry_after and a lost or id-less acknowledgement use the existing part
  retry schedule and uncertain count; a confirmed part is never resent.

### Schema choice

v63 → v64: exact-recognizer copy/rename of `telegram_conversation_part`
(`rebuildTelegramConversationPartForV64`) carrying every v63 row, message
id, attempt and uncertain count; one new table `mate_turn_evidence`. A v63
reader refuses a v64 file by the version gate; a v64 open fails closed when
the new table or columns are missing. The wind-back (rebuild the parts
table to the v63 DDL over the same rows, drop `mate_turn_evidence`, stamp
63) is proven in `src/migration-v64-telegram-images.test.ts`. No live
database was migrated in this build.

### Fixture transcript (telegram-mate.test.ts, "result screenshots on demand")

1. Operator: "Show me the screenshots from that result." Model calls
   `get_result_images {task: payout, run: N}`; tool answers 2 images, "2
   image file(s) will be sent … say they follow". Reply text goes out as
   `sendMessage`; then two `sendDocument` multipart calls with the original
   PNG and JPEG bytes, names `payout-result-N-<artifact>.png|jpg`, captions
   `payout · result #N · screenshot 1 of 2` / `2 of 2`. Parts row: reply
   sent, image sent, image sent. One turn, two harness requests.
2. Operator replies to the first image: "Fix the spacing on the form."
   The turn is pinned to result #N of payout; `get_result` then
   `propose_review revise`; Confirm creates the same-family revision
   (audited `via: telegram`), the card links **Review & start** for the
   exact revision.
3. Operator replies to the same image: "Show me the screenshots" with no
   run → tool refuses "A newer revision of this task is current…"; nothing
   is sent. With the exact run → both images go out captioned
   `· older version`; a revise against the older result is refused by the
   existing stale rule; still one revision.
4. Lost answer on the first document → part pending, uncertain 1; the
   file is altered on disk; restart; retry reads the bytes again, drops
   the part ("the saved file is missing or changed"), sends the notice with
   **Review result**, sends the second image; the reply is not resent; no
   model call.
5. Telegram refuses a document ("file is too big") → retried on the part
   schedule; `retry_after: 7` pauses the bot; an ok without `message_id`
   stays pending and uncertain; the fourth attempt confirms. No model call.
6. Registry read after the await shows the project unenrolled → the row
   fails "unsent: the connected projects changed", nothing uploaded. The
   task's recorded project changed under an unchanged ceiling → the upload
   itself is refused ("outside your connected projects now"), no link to
   the foreign project.
7. A turn that selected images and then failed → `mate_turn_evidence`
   empty, no parts, nothing sent. Unusable records (failed, shortened,
   redacted, oversized, wrong kind) are named to the model; only the
   verified image travels.

### Exact checks run by the builder

- `npm run typecheck` — exit 0.
- `npx vitest run src/chat-evidence.test.ts src/migration-v64-telegram-images.test.ts src/telegram.test.ts src/telegram-mate.test.ts src/telegram-status.test.ts --reporter=dot` — all pass.
- Affected existing suites (mate, mate-doors, the migration suites whose
  version pins moved from 63 to 64) — all pass. The unchanged full gate
  `npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build`
  is left to the final machine gate, once, as the plan requires.

### Remaining gaps

- No real bot, pairing, private Tailscale HTTPS or physical-phone
  rendering: the multipart body was inspected as fetch would send it, not
  received by Telegram.
- Web and CLI expose the same selection and result identity through the
  tool, and say so; they do not download files. The console's result panel
  remains the place to view images there.
- Automatic lifecycle screenshot fan-out stays out of scope; lifecycle
  updates keep their existing exact-result links.
- A dropped image's notice is best-effort (like every other channel
  notice); the dropped part and its reason are durable in the row.
