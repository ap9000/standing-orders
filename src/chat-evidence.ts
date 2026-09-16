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
import { createHash } from "node:crypto";
import { readVerifiedArtifact, scanForSecrets, SCREENSHOT_BYTE_CAP, validateScreenshotBytes } from "./evidence.js";
import type { Artifact, Run, Store } from "./store.js";
import type { VerifiedApprover } from "./principal.js";

/** How many images one turn may select for delivery; more is a flood, not an answer. The rest are one more ask away, by offset or by id. */
export const RESULT_IMAGES_PER_TURN_CAP = 8;

/** Which of a result's images one ask selects: a page from an offset, or exact image ids from an earlier listing. Absent: the first page. */
export type ResultImagePick = { offset?: number; images?: readonly number[] };

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
  /** The task as a caption or file name shows it: the id when it is plain, a stable opaque label when it is credential-shaped. */
  label: string;
  root: string;
  currentExecution: string;
  run: number;
  role: Run["role"];
  title: string;
  /** Every deliverable image of the result, in evidence order, each with its position. */
  images: ResultImage[];
  /** The images THIS ask selects for delivery: at most the per-turn cap, in evidence order. */
  selected: ResultImage[];
  /** Where the next page starts when the selection stopped short of the last image; null when nothing remains after it. */
  nextOffset: number | null;
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

/** The longest task label a caption or file name carries. A task id is at most 64 characters at every tool boundary. */
const RESULT_TASK_LABEL_MAX_CHARS = 64;

/** A bot token's shape, the one credential the secret scanner does not know. */
const BOT_TOKEN_SHAPE = /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/;

/**
 * Is this text safe to show a third-party transport as identity? Nothing
 * credential-shaped, nothing that steers a terminal or a renderer, nothing
 * longer than an id may be. A caption or file name shows only what passes.
 */
export function displayIdentityProblem(text: string): string | null {
  if (text.length === 0 || text.length > RESULT_TASK_LABEL_MAX_CHARS) return "too long";
  if (scanForSecrets(text).length > 0 || BOT_TOKEN_SHAPE.test(text)) return "credential-shaped";
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\s]/.test(text)) return "control or space characters";
  return null;
}

/**
 * The task as a caption or file name may show it. A plain id is itself,
 * with any character a file name cannot hold replaced. A credential-shaped
 * id (a task filed under a token-like name, on purpose or by accident) is
 * never repeated to Telegram: it shows as a stable opaque label instead,
 * while the exact id stays in the typed part, the bindings and the link.
 */
export function resultTaskLabel(taskId: string): string {
  if (displayIdentityProblem(taskId) !== null) return `task-${createHash("sha256").update(taskId).digest("hex").slice(0, 12)}`;
  return taskId.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** The caption: the task's display label, the exact result and the position — identity a person can read, nothing a person or a model typed. */
export function resultImageCaption(task: string, run: number, ordinal: number, total: number, current: boolean): string {
  return `${resultTaskLabel(task)} · result #${run} · screenshot ${ordinal} of ${total}${current ? "" : " · older version"}`.slice(0, RESULT_IMAGE_CAPTION_MAX_CHARS);
}

/** The upload name: task label, result and artifact identity — derivable from the typed part alone, never a path. */
export function resultImageFileName(task: string, run: number, artifact: number, format: "png" | "jpeg"): string {
  return `${resultTaskLabel(task)}-result-${run}-${artifact}.${format === "png" ? "png" : "jpg"}`;
}

/**
 * A persisted caption, checked again at send and retry time: a row planned
 * before this rule, or one edited by hand, may carry the raw task id. A
 * caption that would show a credential, a control character or more than
 * Telegram's ceiling is rebuilt from the part's typed identity instead —
 * the exact task and run stay bound; only the words on the wire change.
 */
export function safeResultImageCaption(text: string, taskId: string, run: number): string {
  const safe = text.length > 0 && text.length <= RESULT_IMAGE_CAPTION_MAX_CHARS
    && scanForSecrets(text).length === 0 && !BOT_TOKEN_SHAPE.test(text)
    && !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/.test(text);
  return safe ? text : `${resultTaskLabel(taskId)} · result #${run} · screenshot`;
}

/** The page or the exact ids one ask selects from a result's images; a refusal names what to choose instead. */
export function pickResultImages(images: readonly ResultImage[], pick: ResultImagePick | undefined, cap: number): { ok: true; selected: ResultImage[]; nextOffset: number | null } | Problem {
  if (pick?.images !== undefined) {
    if (pick.offset !== undefined) return { ok: false, message: "Choose image ids or an offset, not both." };
    if (pick.images.length === 0) return { ok: false, message: "Choose at least one image id from this result's list." };
    if (pick.images.length > cap) return { ok: false, message: `Choose at most ${cap} images per request.` };
    const wanted = new Set(pick.images);
    if (wanted.size !== pick.images.length) return { ok: false, message: "Each image id once." };
    const known = new Set(images.map(one => one.artifact));
    if ([...wanted].some(id => !known.has(id))) return { ok: false, message: "Choose image ids from this result's list of deliverable images." };
    return { ok: true, selected: images.filter(one => wanted.has(one.artifact)), nextOffset: null };
  }
  const offset = pick?.offset ?? 0;
  if (offset > 0 && offset >= images.length) return { ok: false, message: images.length === 0 ? "This result has no deliverable images." : `Choose an image offset below ${images.length}.` };
  const selected = images.slice(offset, offset + cap);
  return { ok: true, selected, nextOffset: offset + selected.length < images.length ? offset + selected.length : null };
}

/**
 * Select the images of precisely the result named. With no run, the latest
 * finished result of THAT execution — and only while it is the current
 * version: a newer revision is said, never switched to. A run must belong
 * to the task and have finished; a role that delivers no images (a
 * reviewer, a planner) is not a result at all. Every deliverable image is
 * listed with its position; `selected` is the page (or the exact ids) this
 * ask delivers, at most the per-turn cap, and `nextOffset` says where the
 * rest begins so the remaining images are one more ask away, never lost.
 */
export function selectResultImages(store: Store, who: VerifiedApprover, evidenceRoot: string | undefined, task: string, run?: number, pick?: ResultImagePick):
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
  const picked = pickResultImages(images, pick, RESULT_IMAGES_PER_TURN_CAP);
  if (!picked.ok) return picked;
  return { ok: true, selection: {
    task, label: resultTaskLabel(task), root: family.root.id, currentExecution: family.current.id, run: found.id, role: found.role,
    title: store.getTask(task)?.title ?? task, images, selected: picked.selected, nextOffset: picked.nextOffset, unavailable, report: artifacts.some(one => one.kind === "report"),
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
