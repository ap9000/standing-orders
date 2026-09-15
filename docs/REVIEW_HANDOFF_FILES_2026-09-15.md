# Keep large review evidence available

## User request and reproduced problem

Remove the handoff size limits that keep blocking honest reviews. Do not just
increase a constant until the next file hits it. Keep a small prompt and let
reviewers read the complete relevant evidence in pieces, with immutable
identity and without repository, shell, network or credential access.

Telegram revision run 1627, candidate
`3102879d2c38d6ef925f26c3e5c9e30110aaf3b8`, passed 3,084 tests and a focused
root reproduction of three delivery cases. Independent review 1628 upheld
c1/c2/c4 but could not assess c3: restart and rate-limit tests were outside the
revision patch, and the inherited test file was omitted for size. The source
files are ~62 KB (`telegram.test.ts`), ~51 KB (`telegram.ts`), and ~1.1 MB
(`store.ts`). The current limits are 48 KB per item, 192 KB combined content,
24 items, and 1 MB inline reviewer input. JSON escaping can add more overhead.
This is missing evidence, not a failing test. Do not waive the criterion.

## Starting point

Start from deployed c29b6a9, schema 60, not the unaccepted Telegram change.
This is a separate harness fix so it can safely repair review without deploying
the feature that review still cannot establish. This brief is committed before
first dispatch. Do not edit the live database or installed runtime.

## Intended change

- Separate evidence storage/availability from prompt size. Remove the small
  per-file and aggregate prompt caps as reasons to omit ordinary source/test
  files from review. Retain full relevant UTF-8 text as machine-sealed evidence
  addressed by exact candidate, literal path, Git blob and content hash. Keep
  a compact manifest with criterion associations and explicit real gaps.
- Reuse current evidence storage, review scratch and provider session. Materialize
  individual sealed files where the reviewer already has a read-only file tool;
  the prompt points to them and supports bounded reads by line/range. For inline
  providers, use a narrow machine-mediated request for a declared evidence item
  and range in the existing session, not general shell/repository/file access.
  A model's context window still exists; never inline unlimited text or silently
  send less evidence to one provider than another can access.
- Keep the implementation small. No vector database, retrieval service, new
  scheduler, agent framework, paid fallback or unrelated file refactor. An explicit
  generous resource ceiling against pathological input is okay; distinguish it
  from prompt delivery size, disclose it honestly, and handle it without truncation.
  The concrete 62 KB test file and 1.1 MB source file must both be available.
- Preserve literal-path restrictions, no-follow reads, UTF-8/binary handling,
  secret redaction, ancestry and exact-head bindings, tamper checks before/after
  review, citation validation and stale-evidence refusal. Do not mark partial or
  redacted evidence complete, copy an earlier verdict, widen provider permissions,
  enable shell/network, rewrite old evidence, or bypass approval/custody.
- Read legacy schema-1/2 contexts as before. New evidence format must be
  explicitly versioned and truthful; prefer no database schema migration.
- Support an explicit evidence-only re-review for a finished unchanged candidate
  through the existing review-request path if feasible within these files. Append
  fresh context/review receipts; never mutate the old sealed inputs or judgement.
  Prove the head and original passing gate still match. Do not rerun a builder or
  the full gate just to read omitted unchanged evidence. If that needs a separate
  authority change, document the exact smallest follow-up instead of bypassing it.

## Verification and handoff

Use existing review-context/reviewer/provider tests. Reproduce both above-old-cap
files, combined context above 192 KB, evidence beyond the initial prompt, complete
range access, and honest missing/secret/tampered/stale cases. Exercise the actual
Claude file-reading path and inline-provider request path with isolated fixtures.
No live provider or Telegram calls in builder tests. No new overlapping suite.

Typecheck and focused tests while coding. Leave the unchanged approved full
verification command to the native final gate once. Bind proof to precise relevant
files and test commands; avoid citing every source file for one check criterion.
Provide concise before/after evidence, compatibility notes, actual remaining
ceilings and a safe replay plan for run 1627. Do not claim deployed or live re-review.
