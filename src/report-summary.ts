import { readVerifiedReport } from "./evidence.js";
import type { Store } from "./store.js";

/** The report a scout delivered, for get_task: title, summary, follow-ups —
 * verified before it is read; the document itself stays on the task page. */
export function reportSummaryFor(
  store: Store,
  evidenceRoot: string | undefined,
  taskRef: number,
): { title: string; summary: string; followUps: { title: string; goal: string }[] } | { problem: string } | null {
  if (store.latestReportArtifact(taskRef) === null) return null;
  if (evidenceRoot === undefined) return { problem: "a report exists, but this surface cannot read evidence" };
  const view = readVerifiedReport(store, evidenceRoot, taskRef);
  if (view === null) return null;
  if (!view.ok) return { problem: view.problem };
  return { title: view.report.title, summary: view.report.summary, followUps: view.report.followUps };
}
