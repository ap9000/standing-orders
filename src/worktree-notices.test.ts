import { expect, test } from "vitest";
import { worktreeAdoptionNotice } from "./worktree-notices.js";

const NOW = new Date("2026-09-21T01:00:00Z"), REPO = "/projects/customer app";

test("empty adoption is silent; a large inventory produces one bounded truthful notice", () => {
  expect(worktreeAdoptionNotice(REPO, [], NOW)).toBeNull();
  const paths = Array.from({ length: 231 }, (_, n) => `/pool/retained-result-${n}`), before = [...paths];
  const notice = worktreeAdoptionNotice(REPO, paths, NOW)!;
  expect(notice).toMatchObject({ source: { project: REPO }, kind: "worktree-adopted", subject: "231 worktrees need review",
    body: "231 existing worktrees were added to the inventory as released and unverified. Review before reusing or deleting them.",
    link: "/system?project=%2Fprojects%2Fcustomer%20app" });
  expect(JSON.stringify(notice).length).toBeLessThan(500);
  expect(JSON.stringify(notice)).not.toContain(paths[0]);
  expect(paths).toEqual(before);
});

test("one unique path uses singular wording and duplicate surveys share an exact batch identity", () => {
  const first = worktreeAdoptionNotice(REPO, ["/pool/a"], NOW)!;
  expect(first.subject).toBe("1 worktree needs review");
  expect(first.body).toContain("Review before reusing or deleting it.");
  expect(worktreeAdoptionNotice(REPO, ["/pool/a", "/pool/a"], NOW)).toEqual(first);
  expect(worktreeAdoptionNotice(REPO, ["/pool/b", "/pool/a"], NOW)).toEqual(worktreeAdoptionNotice(REPO, ["/pool/a", "/pool/b"], NOW));
  expect(worktreeAdoptionNotice("/other", ["/pool/a"], NOW)?.dedupeKey).not.toBe(first.dedupeKey);
  expect(worktreeAdoptionNotice(REPO, ["/pool/a"], new Date(NOW.getTime() + 1))?.dedupeKey).not.toBe(first.dedupeKey);
});
