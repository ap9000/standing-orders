/**
 * Shared, authorized evidence selection for the chat engine: the saved
 * screenshots of one EXACT finished result, for every chat surface.
 *
 * The one road a chat tool takes to a result's images. It proves the same
 * things `readChatResult` proves — the task is in the approver's projects,
 * the run belongs to that task and finished — but it does not require the
 * revision snapshot's terminal diff: a scout's report, a read-only or a
 * no-image result is answered honestly as "no images here" rather than
 * refused or silently swapped for a builder's result. Every image it names
 * was read through `readVerifiedArtifact` and passed `validateScreenshotBytes`
 * this instant; a failed, shortened or redacted capture is named as
 * unavailable, in plain words that carry no path, digest or credential.
 *
 * Nothing here is authority for a send: a channel that delivers files
 * re-proves access and re-reads the bytes with `verifyResultImage`
 * immediately before every upload, including retries.
 */
import { readVerifiedArtifact, SCREENSHOT_BYTE_CAP, validateScreenshotBytes } from "./evidence.js";
import type { Artifact, Run, Store } from "./store.js";
import type { VerifiedApprover } from "./principal.js";

/** How many images one turn may select for delivery; more is a flood, not an answer. */
export const RESULT_IMAGES_PER_TURN_CAP = 8;

export type ResultImage = {
  artifact: number;
  sha256: string;
  format: "png" | "jpeg";
  bytes: number;
  /** 1-based position among the result's deliverable images, and their count. */
  ordinal: number;
  total: number;
  /** The short caption a channel sends with the file: task, result, position. No title, path or prose. */
  caption: string;
  /** The file name a channel uploads under: task and result identity, never a path. */
  fileName: string;
};

export type ResultImageSelection = {
  task: string;
  root: string;
  currentExecution: string;
  run: number;
  role: Run["role"];
  title: string;
  images: ResultImage[];
  /** Screenshot records that exist but cannot be delivered, each with its plain reason. */
  unavailable: { artifact: number; problem: string }[];
  /** The run delivered a report (a scout): images are not the point of this result. */
  report: boolean;
};

type Problem = { ok: false; message: string };

/** The plain words for a screenshot record that must not travel. Null means the record itself is fine. */
export function screenshotRecordProblem(artifact: Artifact): string | null {
  if (artifact.kind !== "screenshot") return "the saved file is not a screenshot";
  if (artifact.captureStatus === "failed") return "the capture failed";
  if (artifact.truncated) return "the saved file was shortened";
  if (artifact.redacted) return "sensitive text was hidden from the saved file";
  if (artifact.bytesStored === 0) return "the saved file is empty";
  if (artifact.bytesStored > SCREENSHOT_BYTE_CAP) return "the saved file is too large to send";
  return null;
}

/** The record, then the bytes: verified against the row read now, and proved to be a bounded PNG or JPEG. */
function readScreenshot(evidenceRoot: string, artifact: Artifact): { ok: true; bytes: Buffer; format: "png" | "jpeg" } | { ok: false; problem: string } {
  const problem = screenshotRecordProblem(artifact);
  if (problem !== null) return { ok: false, problem };
  const proven = readVerifiedArtifact(evidenceRoot, artifact);
  if (!proven.ok) return { ok: false, problem: "the saved file is missing or changed" };
  const checked = validateScreenshotBytes(proven.content);
  if (!checked.ok) return { ok: false, problem: proven.content.length > SCREENSHOT_BYTE_CAP ? "the saved file is too large to send" : "the saved file is not a PNG or JPEG" };
  return { ok: true, bytes: proven.content, format: checked.kind };
}

/** Telegram's own caption ceiling for a document (Bot API sendDocument, checked 2026-09-16). Ours are far shorter by construction. */
export const RESULT_IMAGE_CAPTION_MAX_CHARS = 1_024;

/** The caption: the task, the exact result and the position — identity a person can read, nothing a person or a model typed. */
export function resultImageCaption(task: string, run: number, ordinal: number, total: number, current: boolean): string {
  return `${task} · result #${run} · screenshot ${ordinal} of ${total}${current ? "" : " · older version"}`.slice(0, RESULT_IMAGE_CAPTION_MAX_CHARS);
}

/** The upload name: task, result and artifact identity — derivable from the typed part alone, never a path. */
export function resultImageFileName(task: string, run: number, artifact: number, format: "png" | "jpeg"): string {
  return `${task}-result-${run}-${artifact}.${format === "png" ? "png" : "jpg"}`;
}

/**
 * Select the images of precisely the result named. With no run, the latest
 * finished result of THAT execution — and only while it is the current
 * version: a newer revision is said, never switched to. A run must belong
 * to the task and have finished; a role that delivers no images (a
 * reviewer, a planner) is not a result at all.
 */
export function selectResultImages(store: Store, who: VerifiedApprover, evidenceRoot: string | undefined, task: string, run?: number):
  { ok: true; selection: ResultImageSelection } | Problem {
  const ref = store.lookupRef(task);
  if (ref?.repo == null || !who.repos.includes(ref.repo)) return { ok: false, message: "That task is not in your projects." };
  const family = store.taskFamilyOf(task, who.repos, false);
  if (family === null || family.problem !== null) return { ok: false, message: "This task's revision history needs repair." };
  const current = family.current.id === task;
  if (run === undefined && !current) return { ok: false, message: "A newer revision of this task is current. Say which result you mean before images are selected: this version or the newer one." };
  const found = run === undefined
    ? store.runsFor(ref.id).find(one => one.outcome !== null && (one.role === "builder" || one.role === "repair" || one.role === "scout"))
    : store.getRun(run);
  if (found == null || found.taskRef !== ref.id || found.outcome === null || (found.role !== "builder" && found.role !== "repair" && found.role !== "scout")) {
    return { ok: false, message: "There is no finished result for that version yet." };
  }
  if (evidenceRoot === undefined) return { ok: false, message: "Saved images cannot be read from here." };
  const artifacts = store.artifactsFor(found.id);
  const shots = artifacts.filter(one => one.kind === "screenshot");
  const images: ResultImage[] = [];
  const unavailable: ResultImageSelection["unavailable"] = [];
  const readable: { artifact: Artifact; bytes: number; format: "png" | "jpeg" }[] = [];
  for (const artifact of shots) {
    const read = readScreenshot(evidenceRoot, artifact);
    if (read.ok) readable.push({ artifact, bytes: read.bytes.length, format: read.format });
    else unavailable.push({ artifact: artifact.id, problem: read.problem });
  }
  readable.forEach((one, index) => {
    const ordinal = index + 1;
    images.push({
      artifact: one.artifact.id, sha256: one.artifact.sha256, format: one.format, bytes: one.bytes, ordinal, total: readable.length,
      caption: resultImageCaption(task, found.id, ordinal, readable.length, current),
      fileName: resultImageFileName(task, found.id, one.artifact.id, one.format),
    });
  });
  return { ok: true, selection: {
    task, root: family.root.id, currentExecution: family.current.id, run: found.id, role: found.role,
    title: store.getTask(task)?.title ?? task, images, unavailable, report: artifacts.some(one => one.kind === "report"),
  } };
}

/**
 * The send-time proof, run immediately before EVERY upload including
 * retries: the task is still in the projects this channel may reach now,
 * the run still belongs to it and finished, the artifact row is still the
 * one the part was planned from (same run, same recorded hash — a changed
 * record is a changed provenance, refused), and the bytes read now still
 * verify and are still a bounded PNG or JPEG. Returns the original bytes;
 * nothing is transformed.
 */
export function verifyResultImage(
  store: Store,
  evidenceRoot: string,
  repos: readonly string[],
  part: { taskId: string; run: number; artifact: number; sha256: string },
): { ok: true; bytes: Buffer; format: "png" | "jpeg"; artifact: Artifact } | { ok: false; problem: string } {
  const ref = store.lookupRef(part.taskId);
  if (ref?.repo == null || !repos.includes(ref.repo)) return { ok: false, problem: "the result is outside your connected projects now" };
  const run = store.getRun(part.run);
  if (run === null || run.taskRef !== ref.id || run.outcome === null) return { ok: false, problem: "the result is no longer recorded" };
  const artifact = store.artifactForRun(part.run, part.artifact);
  if (artifact === null || artifact.kind !== "screenshot" || artifact.sha256 !== part.sha256) return { ok: false, problem: "the saved file's record changed" };
  const read = readScreenshot(evidenceRoot, artifact);
  if (!read.ok) return read;
  return { ok: true, bytes: read.bytes, format: read.format, artifact };
}
