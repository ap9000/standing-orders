/**
 * Project scripts (v84): a library of reusable steps that run with no AI.
 * A script is a named shell script — "run-tests", "lint", "smoke-staging" —
 * made on a flow's Scripts panel or drafted by the lead in chat. Any flow in
 * the project uses it by name from a "Run a script" zone, so one script can
 * be improved once for every flow, and the insights show how each script
 * does across them. Each save is a new version; runs record which ran.
 */
import { createHash } from "node:crypto";
import { scanForSecrets } from "./evidence.js";
import { flowDefinitionOf } from "./flow-engine.js";
import { SCRIPT_NAME } from "./flows.js";
import type { FlowScriptRow, Store } from "./store.js";

export type ScriptDraft = { name: string; about: string; body: string; timeoutMinutes: number };

/** A script as it would be saved, checked in plain words. Throws. */
export function validateScript(input: { name?: unknown; about?: unknown; body?: unknown; timeoutMinutes?: unknown }): ScriptDraft {
  const name = typeof input.name === "string" ? input.name.trim().toLowerCase() : "";
  if (!SCRIPT_NAME.test(name)) throw new Error("Name the script in lowercase letters, numbers and dashes, like run-tests.");
  const about = typeof input.about === "string" ? input.about.replace(/\s+/g, " ").trim() : "";
  if (about === "" || about.length > 160) throw new Error("Say in one line what the script checks or does.");
  const body = typeof input.body === "string" ? input.body.replace(/\r\n/g, "\n").trim() : "";
  if (body === "") throw new Error("Write the script: the shell commands it runs.");
  if (body.length > 20_000) throw new Error("Keep a script under 20,000 characters.");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) throw new Error("The script has hidden characters in it.");
  if (scanForSecrets(`${about}\n${body}`).length > 0) throw new Error("That looks like a key or password. Keep secrets out of scripts; read them from the environment on this computer.");
  const minutes = typeof input.timeoutMinutes === "number" && Number.isFinite(input.timeoutMinutes) ? Math.round(input.timeoutMinutes) : typeof input.timeoutMinutes === "string" && input.timeoutMinutes.trim() !== "" ? Number(input.timeoutMinutes) : 15;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error("A script may run for 1 to 60 minutes.");
  return { name, about, body, timeoutMinutes: minutes };
}

export const scriptDigest = (draft: Pick<ScriptDraft, "body" | "timeoutMinutes">) => createHash("sha256").update(`${draft.body}\0${draft.timeoutMinutes}`).digest("hex").slice(0, 32);

export type ScriptSaved = { ok: true; said: string; version: number } | { ok: false; message: string };

/** Save a script (a new version when it exists). */
export function saveScript(store: Store, repo: string, input: Parameters<typeof validateScript>[0], actor: string, now: Date): ScriptSaved {
  let draft: ScriptDraft;
  try { draft = validateScript(input); } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "That script isn't valid." }; }
  const current = store.flowScript(repo, draft.name);
  if (current !== null && current.digest === scriptDigest(draft) && current.about === draft.about) return { ok: true, said: "No changes to save.", version: current.version };
  const version = store.saveFlowScript({ repo, ...draft, digest: scriptDigest(draft), by: actor }, now);
  return { ok: true, said: current === null ? `Saved the ${draft.name} script. Any flow in this project can run it.` : `Saved version ${version} of ${draft.name}. Every flow that runs it uses this version from now on.`, version };
}

/** The flows and zones in a project that run each script. */
export function scriptUses(store: Store, repo: string): Map<string, { flow: number; flowName: string; zone: string }[]> {
  const uses = new Map<string, { flow: number; flowName: string; zone: string }[]>();
  for (const flow of store.listFlows([repo])) for (const stage of flowDefinitionOf(flow)?.stages ?? [])
    if (stage.kind === "check" && stage.script !== null) uses.set(stage.script, [...uses.get(stage.script) ?? [], { flow: flow.id, flowName: flow.name, zone: stage.title }]);
  return uses;
}

export function scriptWords(script: FlowScriptRow): string {
  return `${script.name} (version ${script.version}, up to ${script.timeoutMinutes} min): ${script.about}`;
}
