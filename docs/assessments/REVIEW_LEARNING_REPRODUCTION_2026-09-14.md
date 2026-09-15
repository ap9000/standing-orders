# Does review learning add anything?

Result: the real change passed, but review learning added **no lesson**. This used the reviewed `c9da48d` runtime. No Standing Orders runtime change, installed migration, or learning-related quality gain is claimed.

## The experiment

An intentionally seeded date-only bug in the disposable project turns `2026-01-01` into `Dec 31, 2025` in Los Angeles. This is a controlled example, not a discovered Standing Orders production defect.

1. Astra fixes the bug under an approved two-file scope; Opus reviews the actual diff and checks.
2. If the review proposes a supported lesson, save it and enable reuse through Settings → Learning.
3. Run a separate schedule-export task without repeating the timezone warning. Inspect its immutable context and test its output independently.

The first task explicitly asks the normal reviewer to **consider** a reusable lesson, while allowing zero. This tests prompted learning capture, not spontaneous discovery. A successful later task does not alone prove the lesson caused its success; it may already know the rule or discover it in the code.

## Reproduction facts

- Isolated repository: `/private/tmp/standing-orders-learning-pilot-0xgXFi/repo`; separate v58 database and evidence, no production data. Native one-off runner: `learning-reproduction`.
- Seed commit: `09c5306411124cc299d4d37ac37961f8854f6873`.
- Native task `learning-date-fix`, scope digest `6b7f46ec17dee9fb0342773262bb3088`, Astra builder run **5**. Goal: preserve English month/day/year for valid ISO calendar dates in UTC, Los Angeles and Kiritimati; test year boundaries and leap day.
- Baseline check: `TZ=America/Los_Angeles` plus `dateLabel('2026-01-01')` returned **Dec 31, 2025**, expected **Jan 1, 2026**.
- The controller uses this small project's existing `npm test` final gate. No Standing Orders full-suite rerun or new provider role is needed for this demonstration.

## Result

- Astra builder **5** committed `79660d727a7641aae01c58b77285501aa870f38d`: one-line `timeZone: 'UTC'` fix and three timezone regression tests, each covering four dates. The native `npm test` gate passed **12 tests, zero skips**. Root independently confirmed Los Angeles now returns **Jan 1, 2026**.
- Subscription-authenticated Opus reviewer **6** verified the criterion: four comments, one judgment. Its sealed final response explicitly contains **`"learning":[]`**. The reviewer recognized the UTC rule in an informational comment but did not propose reusable learning. This is not evidence of a dropped response or a capture/storage failure.
- Settings → Learning remained empty, with run-context history present. No lesson was saved, reuse stayed off, and no follow-up build was run without a lesson merely to claim learning success. The one-off runner was retired after completion.
- The useful lasting improvement here is **code plus regression tests**. A separate UTC lesson would largely duplicate that protection. This result neither proves memory is useful nor proves it is broken. The next meaningful experiment should use a project-specific convention or repeated cross-file correction not already enforced by a shared helper, and compare otherwise matched work with/without the lesson. Do not force a nonempty array just to improve a demo metric.

## Reproduce this exact before/after

The faulty seed is preserved in `before-date`; the fixed candidate is preserved in its native worktree. (The disposable main checkout subsequently advanced for the assessment follow-up.) These commands are read-only:

```sh
TZ=America/Los_Angeles node --input-type=module -e 'import {dateLabel} from "/private/tmp/standing-orders-learning-pilot-0xgXFi/before-date/src/date-label.mjs"; console.log(dateLabel("2026-01-01"));'
# Dec 31, 2025

TZ=America/Los_Angeles node --input-type=module -e 'import {dateLabel} from "/private/tmp/standing-orders-learning-pilot-0xgXFi/worktrees/repo/standing-orders-learning-date-fix-534b052b/src/date-label.mjs"; console.log(dateLabel("2026-01-01"));'
# Jan 1, 2026
```

Evidence remains under `/private/tmp/standing-orders-learning-pilot-0xgXFi/evidence`: `5/check-log.txt` and `6/reviewer-response-1.txt`. The latter shows the exact empty learning array. [Phone ledger screenshot](../../output/playwright/learning-date-empty-ledger-phone.png) shows the actual empty state, not seeded lesson data.

To repeat through the product, use a fresh disposable project and task ID: file the date-label repair described above, review the result, then open **Settings → Learning**. Review proposals are optional; the same model may make a different choice on a fresh run. Only if a useful, supported lesson appears should you **Save lesson**, **Enable reuse**, and run the separate schedule-export task. Inspect **Changes → Run context saved → Details → Exact context** to establish what that later run received; compare its output independently before claiming benefit.
