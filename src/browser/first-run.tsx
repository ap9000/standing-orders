/** The first run in Chat: three plain steps to a first result, and first tasks
 * to try. A suggestion only drafts words in the composer; nothing is filed
 * until the person sends it and confirms the lead's proposal. */
import { useState } from "react";
import type { BrowserFirstRun } from "../browser-workspace.js";
import { Button } from "./ui/index.js";

function Command({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(command).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }, () => {}); };
  return <span className="so-first-run-command"><code>{command}</code>
    <Button variant="ghost" size="sm" onClick={copy} aria-label={`Copy ${command}`}>{copied ? "Copied" : "Copy"}</Button></span>;
}

/** What the composer holds after a first task is tapped: the task, added after anything the person already typed, never
 * in place of it. */
export function withSuggestion(typed: string, suggestion: string): string {
  if (typed.trim() === "") return suggestion;
  if (typed.includes(suggestion)) return typed;
  return `${typed.trimEnd()}\n${suggestion}`;
}

export function FirstRun({ firstRun, onDraft }: { firstRun: BrowserFirstRun; onDraft?: ((text: string) => void) | undefined }) {
  const suggestions = onDraft === undefined ? [] : firstRun.suggestions;
  return <section className="so-first-run" aria-labelledby="first-run-title" data-first-run>
    <h2 id="first-run-title">Get to your first result</h2>
    <ol className="so-first-run-steps">
      {firstRun.steps.map(step => <li key={step.key} data-step={step.key} data-done={step.done}>
        <span className="so-first-run-mark" aria-hidden="true">{step.done ? "✓" : ""}</span>
        <span className="so-first-run-title">{step.title}<span className="so-sr-only">{step.done ? ": done" : step.checking ? ": checking" : ": not yet"}</span></span>
        {step.checking && <span className="so-first-run-checking" aria-hidden="true">Checking…</span>}
        {step.action !== null && (step.key === "agent" && firstRun.sandbox !== null ? null
          : step.action.kind === "link" ? <Button asChild variant="secondary" size="sm"><a href={step.action.href}>{step.action.label}</a></Button>
          : <Command command={step.action.command} />)}
        {step.key === "agent" && !step.done && firstRun.sandbox !== null && step.action?.kind === "command" && <div className="so-first-run-choices" data-first-run-choices>
          <div><p className="so-first-run-choice-title">Try the sandbox</p><p className="so-first-run-choice-hint">Sample tasks, no spend.</p><Command command={firstRun.sandbox} /></div>
          <div><p className="so-first-run-choice-title">Sign in an agent</p><p className="so-first-run-choice-hint">Then it builds your project.</p><Command command={step.action.command} /></div>
        </div>}
      </li>)}
    </ol>
    {suggestions.length > 0 && <div className="so-first-tasks" data-first-tasks>
      <p className="so-first-tasks-title">Try a first task</p>
      <div className="so-suggestions">{suggestions.map(one => <button key={one.draft} type="button" className="so-suggestion" data-source={one.source}
        onClick={() => onDraft!(one.draft)}>{one.label}</button>)}</div>
    </div>}
  </section>;
}
