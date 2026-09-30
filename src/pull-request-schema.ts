/** A pull request opened by "Complete and open a pull request" is followed until it merges: how many CI
 * revisions it has filed (counted across the revisions of one task, at most two), the failing head each
 * answered, when a person was asked instead, the green head announced as ready, and the merge itself. One row
 * per publication; the publication row stays the record of the push and the PR. */
export const PULL_REQUEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS pull_request_follow (
  publication   INTEGER PRIMARY KEY REFERENCES publication(id) ON DELETE CASCADE,
  revisions     INTEGER NOT NULL DEFAULT 0 CHECK (revisions >= 0),
  red_head      TEXT,
  revision_task TEXT,
  asked_head    TEXT,
  ready_head    TEXT,
  merge_commit  TEXT,
  merge_method  TEXT CHECK (merge_method IS NULL OR merge_method IN ('squash','merge','rebase')),
  merged_by     TEXT,
  merged_at     TEXT,
  merge_error   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
`;
