/**
 * Chat in `toolroll demo`: the scripted lead's conversation (src/demo.ts),
 * rendered as plain server HTML with native forms. One small script keeps a
 * running build's progress live; without it the page still works by reload.
 */
import { START_COMMAND } from "./first-run.js";
import { headlineOf } from "./task-status.js";
import type { DemoExchange } from "./demo.js";

/** What a finished exchange's stored result holds, read back from its evidence. */
export type DemoResultView = {
  diff: string | null;
  checkLog: string | null;
  checks: { status: string; detail: string };
  screenshot: { href: string; caption: string } | null;
  additions: number;
  deletions: number;
  files: number;
  taskHref: string;
};

const SUGGESTIONS = ["Fix the flaky refund test", "Rewrite the empty Payouts page", "Put the new invoice view behind a flag"];

const esc = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const hidden = (csrf: string): string => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

function hint(csrf: string): string {
  return `<section class="demo-hint" aria-label="Get started">` +
    `<p class="demo-hint-title">Ask for something, like “fix the flaky refund test”</p>` +
    `<form method="post" action="/chat/demo/ask" class="demo-suggestions">${hidden(csrf)}` +
    SUGGESTIONS.map(one => `<button type="submit" name="message" value="${esc(one)}">${esc(one)}</button>`).join("") +
    `</form></section>`;
}

function planCard(exchange: DemoExchange, csrf: string): string {
  const plan = exchange.plan;
  const goal = exchange.note === null ? plan.goal : `${plan.goal} Also: ${exchange.note}`;
  const actions = exchange.state === "proposed"
    ? `<div class="demo-actions">` +
      `<form method="post" action="/chat/demo/${exchange.id}/approve" class="approve-form">${hidden(csrf)}<button type="submit">Approve</button></form>` +
      `<details class="demo-more"><summary>Change it</summary>` +
      `<form method="post" action="/chat/demo/${exchange.id}/change">${hidden(csrf)}` +
      `<label for="demo-change-${exchange.id}">What should change?</label>` +
      `<textarea id="demo-change-${exchange.id}" name="note" rows="2" maxlength="500" required></textarea>` +
      `<button type="submit">Update plan</button></form></details></div>`
    : exchange.state === "replaced"
      ? `<p class="meta">Replaced by the updated plan below.</p>`
      : `<p class="meta">Approved.</p>`;
  return `<section class="card demo-plan" aria-label="Plan">` +
    `<p class="demo-kicker">Plan · ${esc(plan.project)}</p>` +
    `<h2>${esc(plan.title)}</h2>` +
    `<p>${esc(goal)}</p>` +
    `<h3>Boundaries</h3><ul>${plan.boundaries.map(one => `<li>${esc(one)}</li>`).join("")}</ul>` +
    `<h3>Checks</h3><ul>${plan.checks.map(one => `<li>${esc(one)}</li>`).join("")}</ul>` +
    actions + `</section>`;
}

function buildCard(exchange: DemoExchange): string {
  const stages = [["planning", "Planning"], ["building", "Building"], ["checking", "Running checks"]] as const;
  const at = stages.findIndex(([key]) => key === exchange.stage);
  return `<section class="card demo-build" id="demo-${exchange.id}-work" aria-label="Build" aria-busy="true">` +
    `<p class="demo-kicker">${esc(exchange.plan.project)}</p>` +
    `<h2>${esc(stages[Math.max(0, at)]![1])}…</h2>` +
    `<ol class="demo-steps">${stages.map(([, label], index) =>
      `<li class="${index < at ? "done" : index === at ? "now" : ""}"${index === at ? ` aria-current="step"` : ""}>${esc(label)}</li>`).join("")}</ol>` +
    (exchange.progress === null ? "" : `<p class="meta demo-progress">${esc(exchange.progress)}</p>`) +
    `</section>`;
}

function diffHtml(diff: string): string {
  return diff.replace(/\n$/, "").split("\n").map(line => {
    const kind = line.startsWith("diff --git") || line.startsWith("new file") ? "file"
      : line.startsWith("+++") || line.startsWith("---") ? "meta"
      : line.startsWith("@@") ? "hunk"
      : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    return `<span class="demo-diff-${kind}">${esc(line) || " "}</span>`;
  }).join("");
}

function resultCard(exchange: DemoExchange, csrf: string, result: DemoResultView | null): string {
  if (result === null) return `<section class="card demo-result"><p class="meta">This result's saved evidence is unavailable.</p></section>`;
  const passed = result.checks.status === "passed";
  // The shared headline (task-status.ts): the same words as every real task.
  const headline = headlineOf({ stage: exchange.state === "complete" ? "complete" : exchange.state === "sent-back" ? "building" : "finished",
    checks: { status: passed ? "passed" : "failed", exitCode: null, head: null } });
  const status = `<span class="badge${headline === "Complete" ? " demo-complete" : headline === "Ready for review" ? " demo-ready" : ""}" data-headline="${headline}">${headline}</span>`;
  const summary = `${result.files} file${result.files === 1 ? "" : "s"} changed · +${result.additions} −${result.deletions} · ` +
    `<span class="${passed ? "demo-pass" : "demo-fail"}">${esc(result.checks.detail)}</span>`;
  const actions = exchange.state === "ready"
    ? `<div class="demo-actions">` +
      `<form method="post" action="/chat/demo/${exchange.id}/complete">${hidden(csrf)}<button type="submit" class="demo-primary">Complete</button></form>` +
      `<details class="demo-more"><summary>Request changes</summary>` +
      `<form method="post" action="/chat/demo/${exchange.id}/revise">${hidden(csrf)}` +
      `<label for="demo-revise-${exchange.id}">What should change?</label>` +
      `<textarea id="demo-revise-${exchange.id}" name="note" rows="2" maxlength="500" required></textarea>` +
      `<button type="submit">Send back</button></form></details></div>`
    : `<p class="meta"><a href="${esc(result.taskHref)}">Open in Tasks</a></p>`;
  return `<section class="card demo-result" id="demo-${exchange.id}-work" aria-label="Result">` +
    `<p class="demo-state">${status}<span class="meta">${esc(exchange.plan.project)}</span></p>` +
    `<h2>${esc(exchange.plan.title)}</h2>` +
    `<p>${esc(exchange.plan.conclusion)}</p>` +
    `<p class="meta">${summary}</p>` +
    actions +
    (result.diff === null ? "" : `<details class="demo-evidence"${exchange.state === "ready" ? " open" : ""}><summary>Changes</summary><pre class="demo-diff">${diffHtml(result.diff)}</pre></details>`) +
    (result.checkLog === null ? "" : `<details class="demo-evidence"><summary>Check log</summary><pre class="demo-log">${esc(result.checkLog)}</pre></details>`) +
    (result.screenshot === null ? "" : `<details class="demo-evidence"><summary>Screenshot</summary><figure><img src="${esc(result.screenshot.href)}" alt="${esc(result.screenshot.caption)}" width="960" height="600"><figcaption class="meta">${esc(result.screenshot.caption)}</figcaption></figure></details>`) +
    `</section>`;
}

/** The conversation itself; the live script swaps this region in place. */
export function demoThreadHtml(exchanges: readonly DemoExchange[], csrf: string, resultOf: (exchange: DemoExchange) => DemoResultView | null): string {
  if (exchanges.length === 0) return hint(csrf);
  return exchanges.map(exchange => {
    const parts = [
      `<div class="demo-said demo-you"><p>${esc(exchange.asked)}</p></div>`,
      `<div class="demo-said demo-lead"><p class="demo-who">Lead</p><p>${esc(exchange.reply)}</p></div>`,
      planCard(exchange, csrf),
    ];
    if (exchange.state === "working") parts.push(buildCard(exchange));
    if (exchange.state === "ready" || exchange.state === "complete" || exchange.state === "sent-back") parts.push(resultCard(exchange, csrf, resultOf(exchange)));
    if (exchange.state === "complete") {
      parts.push(`<div class="demo-said demo-lead"><p class="demo-who">Lead</p><p>Done. That's the whole loop: ask, approve, Ready, Complete. Ask for something else whenever you like.</p></div>`,
        `<section class="card demo-handoff" data-demo-handoff aria-label="Your own project"><h2>Now try it on your own project</h2>` +
        `<p>In your repository's folder, run:</p><pre class="demo-command"><code>${esc(START_COMMAND)}</code></pre>` +
        `<p class="meta">It opens in your browser, already signed in.</p></section>`);
    }
    return `<article class="demo-turn" id="demo-${exchange.id}">${parts.join("")}</article>`;
  }).join("");
}

export function demoChatHtml(input: { exchanges: readonly DemoExchange[]; csrf: string; version: number; problem: string | null; resultOf: (exchange: DemoExchange) => DemoResultView | null }): string {
  const working = input.exchanges.some(one => one.state === "working");
  return `<div class="demo-chat">` +
    (input.problem === null ? "" : `<p class="problem" role="alert">${esc(input.problem)}</p>`) +
    `<div id="demo-thread" class="demo-thread" aria-live="polite" data-version="${input.version}" data-working="${working ? "1" : "0"}">` +
    demoThreadHtml(input.exchanges, input.csrf, input.resultOf) + `</div>` +
    `<form method="post" action="/chat/demo/ask" class="demo-composer">${hidden(input.csrf)}` +
    `<label for="demo-message" class="so-sr-only">Message the lead</label>` +
    `<textarea id="demo-message" name="message" rows="2" maxlength="500" placeholder="Ask the lead for a change" required></textarea>` +
    `<button type="submit" class="demo-primary">Send</button></form></div>`;
}

/**
 * Keeps a running build live: polls while one is working and swaps the
 * thread in place, unless the visitor is typing inside it. Enter sends.
 */
export const DEMO_CHAT_SCRIPT = `(() => {
  const thread = () => document.getElementById("demo-thread");
  let timer = 0;
  const editing = region => region.contains(document.activeElement) && document.activeElement.matches("textarea, input") || region.querySelector("details[open] textarea:not(:placeholder-shown)") !== null;
  const tick = async () => {
    const region = thread();
    if (!region) { timer = setTimeout(tick, 400); return; }
    if (region.dataset.working !== "1") return;
    try {
      const answer = await fetch("/chat/demo/live", { headers: { accept: "application/json" }, credentials: "same-origin" });
      if (answer.ok) {
        const next = await answer.json();
        if (String(next.version) !== region.dataset.version && !editing(region)) {
          region.innerHTML = next.html;
          region.dataset.version = String(next.version);
          region.dataset.working = next.working ? "1" : "0";
          if (!next.working) {
            const last = region.querySelector(".demo-turn:last-of-type .demo-result");
            if (last) last.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
          }
        }
      }
    } catch { /* the next tick tries again */ }
    if (thread()?.dataset.working === "1") timer = setTimeout(tick, 700);
  };
  const start = () => { clearTimeout(timer); tick(); };
  document.addEventListener("keydown", event => {
    const field = event.target;
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || !(field instanceof HTMLTextAreaElement) || field.id !== "demo-message") return;
    if (field.value.trim() === "") return;
    event.preventDefault();
    field.form?.requestSubmit();
  });
  window.addEventListener("standing-orders:workspace-rendered", start);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();`;
