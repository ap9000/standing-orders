/**
 * The first run: three plain steps to a first result, and three first tasks
 * to try. Everything here is derived from live facts on each render; the
 * list retires permanently with the first Ready result (the
 * 'first-success-at' installation fact). A suggestion only drafts words in
 * the composer: nothing is filed until the person sends it and confirms.
 */
import { run } from "./exec.js";
import type { Runner } from "./backend.js";
import { githubIssues } from "./issues.js";

export const SIGN_IN_COMMAND = "claude auth login";
export const SANDBOX_COMMAND = "npx toolroll demo";

export type FirstRunAction = { kind: "link"; label: string; href: string } | { kind: "command"; command: string };
/** `checking`: the answer is not in yet, so the step is shown neither done nor to do. */
export type FirstRunStep = { key: "agent" | "project" | "task"; title: string; done: boolean; action: FirstRunAction | null; checking?: true };
/** agentSignedIn is null until this machine's first sign-in check has answered. */
export type FirstRunFacts = { agentSignedIn: boolean | null; projects: number; hasTask: boolean; firstResultAt: string | null };

/** The three steps, each done or with the one action that does it; null once the first result has arrived. */
export function firstRunSteps(facts: FirstRunFacts): FirstRunStep[] | null {
  if (facts.firstResultAt !== null) return null;
  const project = facts.projects > 0;
  return [
    facts.agentSignedIn === null ? { key: "agent", title: "Agent signed in", done: false, action: null, checking: true }
      : { key: "agent", title: "Agent signed in", done: facts.agentSignedIn, action: facts.agentSignedIn ? null : { kind: "command", command: SIGN_IN_COMMAND } },
    { key: "project", title: "Project added", done: project, action: project ? null : { kind: "link", label: "Add a project", href: "/projects" } },
    { key: "task", title: "Your first task", done: facts.hasTask, action: facts.hasTask ? null : { kind: "link", label: "New task", href: "/tasks/new" } },
  ];
}

export type OpenIssue = { number: number; title: string };
export type TodoComment = { file: string; line: number; text: string };
export type FirstTaskSuggestion = { source: "issue" | "todo" | "generic"; label: string; draft: string };

export const GENERIC_FIRST_TASKS: readonly FirstTaskSuggestion[] = [
  { source: "generic", label: "Add a test for an untested function", draft: "Find one function without a test and add a focused test for it." },
  { source: "generic", label: "Fix a lint warning", draft: "Fix one lint warning without changing behaviour." },
  { source: "generic", label: "Improve the README's setup section", draft: "Improve the setup section of the README so a newcomer can install and run the project." },
];

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** Issue titles and TODO text are written by anyone: keep only what a person can see, so the draft they send is the
 * draft the lead reads (no control, format, zero-width, bidi, tag or variation-selector characters). */
export const visibleText = (text: string) =>
  text.replace(/[\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu, "").replace(/[\p{Cc}\s]+/gu, " ").trim();

/** Three first tasks: open GitHub issues first, then TODO or FIXME comments, then safe generic ones. */
export function firstTaskSuggestions(found: { issues: readonly OpenIssue[]; todos: readonly TodoComment[] }): FirstTaskSuggestion[] {
  const fromIssues = found.issues.map(({ number, title: raw }): FirstTaskSuggestion => {
    const title = visibleText(raw);
    return { source: "issue", label: clip(`#${number} ${title}`, 80), draft: `Fix GitHub issue #${number}: ${title}` };
  });
  const fromTodos = found.todos.map(({ file: rawFile, line, text: rawText }) => ({ file: visibleText(rawFile), line, text: visibleText(rawText) })).map((todo): FirstTaskSuggestion => ({
    source: "todo", label: clip(todo.text === "" ? `The note in ${todo.file}` : todo.text.charAt(0).toUpperCase() + todo.text.slice(1), 80),
    draft: `Resolve the note in ${todo.file} line ${todo.line}${todo.text === "" ? "" : `: ${todo.text}`}`,
  }));
  return [...fromIssues, ...fromTodos, ...GENERIC_FIRST_TASKS].slice(0, 3);
}

const SKIPPED = /(^|\/)(node_modules|dist|build|vendor|third_party|\.git)\//;

/** `git grep -z -n` records ("file\0line\0text\n") to TODO or FIXME notes, one per file. NUL-separated so a
 * file name with a colon or a newline in it is still one file name. */
export function parseTodoLines(stdout: string, limit = 3): TodoComment[] {
  const found: TodoComment[] = [];
  const seen = new Set<string>();
  for (const match of stdout.matchAll(/([^\0]*)\0(\d+)\0([^\n]*)(?:\n|$)/g)) {
    const file = match[1]!;
    if (file === "" || SKIPPED.test(file) || seen.has(file)) continue;
    const note = /\b(?:TODO|FIXME)\b(?:\([^)]*\))?[:\s-]*(.*)$/.exec(match[3]!);
    if (note === null) continue;
    seen.add(file);
    found.push({ file, line: Number(match[2]), text: clip(note[1]!.replace(/\s*(\*\/|-->)\s*$/, "").trim(), 120) });
    if (found.length === limit) break;
  }
  return found;
}

/** The TODO search: no colour and no column whatever the person's git config says, NUL after each file name. */
export const TODO_GREP_ARGS: readonly string[] = ["-c", "grep.column=false", "grep", "--no-color", "-z", "-n", "-I", "-w", "--max-count=1", "-E", "TODO|FIXME"];

/** Read the project's own sources for suggestions: its open issues through the `gh` login, then its TODO comments. Failures fall through quietly. */
export async function findFirstTasks(repo: string, runner: Runner = run): Promise<FirstTaskSuggestion[]> {
  let issues: OpenIssue[] = [];
  try {
    const listed = await githubIssues({ repo, runner, limit: 3, timeoutMs: 5_000 }).listReady();
    if (listed.ok) issues = listed.value.slice(0, 3).map(one => ({ number: Number(one.id), title: one.title })).filter(one => Number.isSafeInteger(one.number));
  } catch { issues = []; }
  let todos: TodoComment[] = [];
  if (issues.length < 3) {
    try {
      const result = await runner("git", [...TODO_GREP_ARGS], { cwd: repo, timeoutMs: 5_000 });
      if (result.code === 0 || result.stdout !== "") todos = parseTodoLines(result.stdout);
    } catch { todos = []; }
  }
  return firstTaskSuggestions({ issues, todos });
}

/** "First result in 7 min": how long after the installation began its first Ready result arrived. */
export function firstResultWords(since: string, at: string): string | null {
  const minutes = Math.round((Date.parse(at) - Date.parse(since)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes < 1) return "First result in under a minute";
  if (minutes < 60) return `First result in ${minutes} min`;
  if (minutes < 48 * 60) { const hours = Math.floor(minutes / 60), rest = minutes % 60; return `First result in ${hours} h${rest === 0 ? "" : ` ${rest} min`}`; }
  return `First result in ${Math.round(minutes / (24 * 60))} days`;
}
