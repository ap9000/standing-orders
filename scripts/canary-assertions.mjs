/** Certification requires actual independent support, not just a completed review run. */
export function assertReviewedCriteria(matrix, signedIds, provider, model) {
  const expected = new Set(signedIds);
  if (expected.size === 0 || expected.size !== signedIds.length || !Array.isArray(matrix) || matrix.length !== expected.size) {
    throw new Error("independent review did not cover the exact signed rubric");
  }
  const seen = new Set();
  for (const row of matrix) {
    if (!expected.has(row?.id) || seen.has(row.id)) throw new Error("independent review changed or duplicated the signed rubric");
    seen.add(row.id);
    const author = row.review?.author;
    if (row.review?.judgement !== "upholds" || ![`reviewer:${provider}`, `reviewer:${provider}·${model}`].includes(author)) {
      throw new Error(`criterion ${row.id} was not independently upheld by ${provider}: ${JSON.stringify(row.review ?? null)}`);
    }
  }
}
