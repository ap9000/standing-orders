/** Result-first review (workspace package 3, 2026-09-13): the pure parts
 * of ONE result presentation shared by the task chat receipt, the run
 * page, the review cockpit, and the chat's result detail.
 *
 * Nothing here reads a database or renders a full page. The server
 * assembles the same verified records it already reads (handoff, proof,
 * diff, matrix, publication, report) into `SharedResultFacts`; every
 * surface prints those facts through `resultFactsAttributes`, so a test —
 * or a person — can check that chat, run detail, and review agree on the
 * run, its head, its checks, its caveats, and its publication.
 *
 * The presentation leads with the deliverable itself: validated
 * screenshots for UI work, the escaped report for an investigation, a
 * concise change summary for code. Missing, corrupt, or truncated
 * evidence is named in `evidenceProblemsOf` and is never described as
 * validated. Three local views — Summary, Changes, Checks — are anchor
 * links (`?tab=`) the server honours, enhanced in the browser by
 * `RESULT_REVIEW_SCRIPT`, which also keeps a bounded review draft, the
 * selected tab, and the reading position in this tab's sessionStorage,
 * keyed by the server-named account, the task, and the run. */

export type ResultTab = "summary" | "changes" | "checks";

export const RESULT_TABS: readonly { key: ResultTab; label: string }[] = [
  { key: "summary", label: "Summary" },
  { key: "changes", label: "Changes" },
  { key: "checks", label: "Checks" },
];

/** The requested local view; anything unknown reads as Summary. */
export function parseResultTab(raw: string | null | undefined): ResultTab {
  return raw === "changes" || raw === "checks" ? raw : "summary";
}

/** What leads the Summary view — decided from the records present, never
 * from the outcome word: a scout's report leads even when a diff exists;
 * validated screenshots lead UI work; a sealed diff leads code; the
 * handoff alone leads when nothing else was captured. */
export type ResultLead = "report" | "screenshots" | "changes" | "summary";

export function resultLeadOf(input: { role: string; report: boolean; screenshots: number; diff: boolean }): ResultLead {
  if (input.role === "scout" || input.report) return "report";
  if (input.screenshots > 0) return "screenshots";
  if (input.diff) return "changes";
  return "summary";
}

/** One validated screenshot as the page will show it, or the reason it
 * cannot be shown. `problem` is set when the stored bytes no longer verify
 * against their record; such a shot is counted as unavailable and is
 * never rendered as an image or described as validated. */
export type ResultScreenshot = { path: string; caption: string; artifactId: number; problem: string | null };

export type ResultEvidenceInput = {
  /** The proof artifact exists but cannot be shown (corrupt, unparseable). */
  proofProblem: string | null;
  /** The sealed diff's health: absent, unverifiable, or fine. */
  diff: { problem: string } | { truncated: boolean } | null;
  stat: { problem: string } | { filesTruncated: boolean } | null;
  checkLog: { truncated: boolean } | null;
  screenshots: readonly ResultScreenshot[];
  /** Screenshot paths the proof cites that no stored artifact answers. */
  uncapturedScreenshots: readonly string[];
  /** A scout's report record: absent, unverifiable, or fine. */
  report: { problem: string } | { ok: true } | null;
  /** Whether a report is owed (a scout's run) — absence is then a problem. */
  reportExpected: boolean;
  /** The handoff record: a no-change conclusion owes one. */
  handoffPresent: boolean;
  outcome: string | null;
};

/** Every evidence problem in plain words, in a stable order. Empty means
 * every record this result cites is present, whole, and verifies. */
export function evidenceProblemsOf(input: ResultEvidenceInput): string[] {
  const problems: string[] = [];
  if (input.proofProblem !== null) problems.push(`The agent's proof cannot be shown: ${input.proofProblem}.`);
  if (input.diff !== null && "problem" in input.diff) problems.push(`The sealed diff is unavailable: ${input.diff.problem}.`);
  else if (input.diff !== null && input.diff.truncated) problems.push("The sealed diff was shortened when it was stored; review the full download before relying on it.");
  else if (input.diff === null && input.outcome === "no-change" && !input.reportExpected) problems.push("No sealed diff was captured, so the no-change conclusion is not verified.");
  if (input.stat !== null && "problem" in input.stat) problems.push(`The change summary is unavailable: ${input.stat.problem}.`);
  else if (input.stat !== null && input.stat.filesTruncated) problems.push("The changed-file list was cut short; the counts are complete.");
  if (input.checkLog !== null && input.checkLog.truncated) problems.push("The check output was shortened when it was stored.");
  for (const shot of input.screenshots) {
    if (shot.problem !== null) problems.push(`Screenshot ${shot.path} no longer verifies (${shot.problem}) and is not shown.`);
  }
  for (const path of input.uncapturedScreenshots) problems.push(`The proof cites screenshot ${path}, but no validated image was stored.`);
  if (input.report !== null && "problem" in input.report) problems.push(`The report cannot be shown: ${input.report.problem}.`);
  else if (input.report === null && input.reportExpected) problems.push("This investigation stored no report.");
  if (!input.handoffPresent && input.outcome === "no-change" && !input.reportExpected) problems.push("The no-change conclusion has no handoff record.");
  return problems;
}

/** The facts every result surface must agree on. */
export type SharedResultFacts = {
  runId: number;
  /** The exact commits, from the sealed diff summary when it verifies,
   * else from the run record — `headSource` says which. */
  base: string | null;
  head: string | null;
  headSource: "sealed diff" | "run record" | null;
  /** Signed criteria passed, from the machine's matrix; null = no rubric. */
  checks: { passed: number; total: number } | null;
  caveats: readonly string[];
  evidenceProblems: readonly string[];
  /** The observed publication state, "none" when nothing was intended. */
  publicationState: string;
  publicationWords: string;
};

/** The `data-result-*` attributes every surface stamps on its result
 * element. Values are short, escaped, and deterministic for one run, so
 * two surfaces rendering the same result carry byte-identical attributes. */
export function resultFactsAttributes(facts: SharedResultFacts): string {
  const attr = (name: string, value: string): string => ` data-result-${name}="${escapeAttribute(value)}"`;
  return (
    attr("run", String(facts.runId)) +
    attr("head", facts.head === null ? "" : facts.head.slice(0, 12)) +
    attr("base", facts.base === null ? "" : facts.base.slice(0, 12)) +
    attr("head-source", facts.headSource ?? "none") +
    attr("checks", facts.checks === null ? "none" : `${facts.checks.passed}/${facts.checks.total}`) +
    attr("caveats", String(facts.caveats.length)) +
    attr("evidence", facts.evidenceProblems.length === 0 ? "ok" : `problems:${facts.evidenceProblems.length}`) +
    attr("publication", facts.publicationState)
  );
}

/** The shared fact names, in the order `resultFactsAttributes` writes them. */
export const RESULT_FACT_KEYS = ["run", "head", "base", "head-source", "checks", "caveats", "evidence", "publication"] as const;

/** Parse the shared facts back — the test-side and proof-side reader.
 * Only the shared keys are read; a panel's own presentation attributes
 * (place, lead, task, user) are not facts and are left out. */
export function resultFactsFromHtml(html: string): Record<string, string>[] {
  const found: Record<string, string>[] = [];
  const tag = /<[a-z]+\b[^>]*\bdata-result-run="[^"]*"[^>]*>/g;
  const keys = new Set<string>(RESULT_FACT_KEYS);
  for (const match of html.matchAll(tag)) {
    const facts: Record<string, string> = {};
    for (const pair of match[0].matchAll(/data-result-([a-z-]+)="([^"]*)"/g)) {
      if (keys.has(pair[1] as string)) facts[pair[1] as string] = unescapeAttribute(pair[2] as string);
    }
    found.push(facts);
  }
  return found;
}

/** Where a result form may send its reader back: the review cockpit's
 * own deep link, the chat's result detail, or the run page. Anything else
 * lands on the run page. Matched exactly — never a bare open redirect. */
export function resultReturnTarget(raw: string | null | undefined, runId: number): string {
  if (raw !== null && raw !== undefined) {
    if (/^\/review\?result=[A-Za-z0-9._~%-]{1,200}$/.test(raw)) return raw;
    const chat = /^\/chat\?task=([A-Za-z0-9._~%-]{1,200})&result=([0-9]{1,15})$/.exec(raw);
    if (chat !== null && Number(chat[2]) === runId) return raw;
  }
  return `/r/${runId}`;
}

/** A form's own request token, minted per render — the same shape the
 * chat composer uses. A replayed submission carries the same token, so
 * the server can recognise it and mint nothing twice. */
export const REQUEST_TOKEN = /^[a-f0-9]{32}$/;

/** The dedupe key a review note is stored under when the form carried a
 * request token: bound to the account and the token, never to the words,
 * so the same person saying the same thing twice on purpose still lands. */
export function commentSourceKey(user: string, request: string | null | undefined): string | undefined {
  return request !== null && request !== undefined && REQUEST_TOKEN.test(request) ? `review:${user}:${request}` : undefined;
}

export const REVIEW_DRAFT_PREFIX = "standing-orders:review-draft:";
export const RESULT_SCROLL_PREFIX = "standing-orders:result-scroll:";

/** The in-page half of the result presentation. Everything it does is
 * presentational or a bounded draft: no fetch, no endpoint, no submit.
 *
 * - Tabs: the anchor links switch the visible view in place and record
 *   `?tab=` with replaceState, so refresh and Back land on the same view
 *   the server would render for that URL.
 * - Diff modes: View hides the line pins; Annotate shows them. A pin or a
 *   file button copies its target into the Request changes form, opens
 *   the pin disclosure, and focuses the note.
 * - Review draft: the note, file, and line are kept in sessionStorage
 *   under the account, task, and run the form names, for at most a day,
 *   and restored on load. The draft clears only when the page carries the
 *   receipt for THIS draft's request token (`?noted=<token>`); a refused
 *   submission leaves it in place. Other accounts' drafts on this tab are
 *   dropped, never restored.
 * - Reading position: the page's scroll offset is kept under the same
 *   account/task and the URL's own result and tab, and restored on load
 *   when the URL carries no hash, so Back to chat and refresh return the
 *   reader to where they were. */
export const RESULT_REVIEW_SCRIPT = String.raw`
(function(){
  var panel=document.querySelector('[data-result-panel]');
  var user=panel?panel.getAttribute('data-result-user')||'':'';
  var task=panel?panel.getAttribute('data-result-task')||'':'';
  var run=panel?panel.getAttribute('data-result-run')||'':'';
  var draftPrefix='standing-orders:review-draft:',scrollPrefix='standing-orders:result-scroll:';
  var day=86400000,storage=true,rememberPosition=null;
  function read(key){try{return JSON.parse(sessionStorage.getItem(key)||'null');}catch(e){return null;}}
  function write(key,value){try{if(value===null)sessionStorage.removeItem(key);else sessionStorage.setItem(key,JSON.stringify(value));}catch(e){storage=false;}}
  // Prune: anything older than a day, and anything another account left on this tab.
  try{
    for(var i=sessionStorage.length-1;i>=0;i--){var k=sessionStorage.key(i);if(!k)continue;
      if(k.indexOf(draftPrefix)===0||k.indexOf(scrollPrefix)===0){var item=read(k);var owner=k.split(':')[2]||'';
        if(!item||typeof item.at!=='number'||item.at<Date.now()-day||(user&&owner!==user))sessionStorage.removeItem(k);}}
  }catch(e){storage=false;}
  // ---- tabs -----------------------------------------------------------
  if(panel){
    var tabs=panel.querySelectorAll('[data-result-tab]'),views=panel.querySelectorAll('[data-result-view]');
    function show(name){
      Array.prototype.forEach.call(views,function(view){var on=view.getAttribute('data-result-view')===name;view.hidden=!on;});
      Array.prototype.forEach.call(tabs,function(tab){var on=tab.getAttribute('data-result-tab')===name;tab.setAttribute('aria-selected',on?'true':'false');tab.tabIndex=on?0:-1;});
    }
    Array.prototype.forEach.call(tabs,function(tab){
      tab.addEventListener('click',function(ev){
        if(ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.altKey||ev.button!==0)return;
        ev.preventDefault();var name=tab.getAttribute('data-result-tab');show(name);
        try{var url=new URL(location.href);url.searchParams.set('tab',name);url.hash='';history.replaceState(history.state,'',url.toString());}catch(e){}
        if(rememberPosition)rememberPosition();
      });
      tab.addEventListener('keydown',function(ev){
        var list=Array.prototype.slice.call(tabs),at=list.indexOf(tab),next=null;
        if(ev.key==='ArrowRight')next=list[(at+1)%list.length];else if(ev.key==='ArrowLeft')next=list[(at-1+list.length)%list.length];else if(ev.key==='Home')next=list[0];else if(ev.key==='End')next=list[list.length-1];
        if(next){ev.preventDefault();next.focus();next.click();}
      });
    });
  }
  // ---- diff modes and line pins ------------------------------------------
  var form=document.getElementById('comment-form');
  var review=document.querySelector('[data-review-diff]');
  if(review){
    review.setAttribute('data-mode','view');
    review.addEventListener('click',function(ev){
      var mode=ev.target&&ev.target.closest?ev.target.closest('button[data-diff-mode]'):null;if(!mode)return;
      var value=mode.getAttribute('data-diff-mode')==='annotate'?'annotate':'view';review.setAttribute('data-mode',value);
      review.querySelectorAll('button[data-diff-mode]').forEach(function(one){one.setAttribute('aria-pressed',String(one===mode));});
    });
  }
  if(form){
    var noteBox=form.querySelector('[name=note]'),pathBox=form.querySelector('[name=path]'),lineBox=form.querySelector('[name=line]'),pin=form.querySelector('details.result-pin');
    var limit=document.getElementById('comment-note-limit'),requestBox=form.querySelector('[name=request]');
    if(noteBox&&limit&&noteBox.maxLength>0){
      var tally=function(){limit.textContent=noteBox.value.length===0?'up to '+noteBox.maxLength+' characters':noteBox.value.length+' of '+noteBox.maxLength+' characters';};
      tally();noteBox.addEventListener('input',tally);
    }
    document.addEventListener('click',function(ev){
      var button=ev.target&&ev.target.closest?ev.target.closest('button.pick-file,button.pick-line'):null;if(!button)return;
      if(pathBox)pathBox.value=button.getAttribute('data-path')||'';
      if(lineBox)lineBox.value=button.getAttribute('data-line')||'';
      if(pin)pin.open=true;
      save();
      form.scrollIntoView({behavior:'smooth',block:'center'});if(noteBox)noteBox.focus();
    });
    // The bounded draft: this account, this task, this run.
    var draftKey=draftPrefix+user+':'+task+':'+run;
    var noted=null;try{noted=new URL(location.href).searchParams.get('noted');}catch(e){}
    var saved=read(draftKey);
    if(saved&&noted&&saved.request===noted){write(draftKey,null);saved=null;}
    // The receipt lands with a fragment: browsers skip autofocus on a
    // fragment URL and move focus to the fragment's target on load, so the
    // just-posted form's note box is focused after that step.
    if(noted&&noteBox&&!noteBox.value){
      var focusNote=function(){setTimeout(function(){noteBox.focus({preventScroll:true});},0);};
      if(document.readyState==='complete')focusNote();else window.addEventListener('load',focusNote);
    }
    if(saved&&typeof saved.note==='string'&&saved.note.length<=2000){
      if(noteBox&&!noteBox.value)noteBox.value=saved.note;
      if(pathBox&&!pathBox.value&&typeof saved.path==='string')pathBox.value=saved.path;
      if(lineBox&&!lineBox.value&&typeof saved.line==='string')lineBox.value=saved.line;
      if(pin&&(pathBox&&pathBox.value||lineBox&&lineBox.value))pin.open=true;
      if(typeof saved.request==='string'&&/^[a-f0-9]{32}$/.test(saved.request)&&requestBox)requestBox.value=saved.request;
      if(noteBox)noteBox.dispatchEvent(new Event('input'));
    }
    function save(){
      var note=noteBox?noteBox.value:'',path=pathBox?pathBox.value:'',line=lineBox?lineBox.value:'';
      if(!note&&!path&&!line){write(draftKey,null);return;}
      write(draftKey,{note:note,path:path,line:line,request:requestBox?requestBox.value:'',at:Date.now()});
      if(!storage&&limit)limit.textContent='Draft stays on this page only. Browser storage is unavailable.';
    }
    form.addEventListener('input',save);
    // A double click never posts twice; a refused post keeps the draft.
    // On a chat page the conversation's own delegated latch owns
    // aria-busy (it runs after this form-level listener and would refuse
    // a form already marked busy), so the latch is added only elsewhere.
    var chatLatch=document.querySelector('.composer[data-chat-session]')!==null;
    form.addEventListener('submit',function(event){
      save();
      if(chatLatch)return;
      if(form.getAttribute('aria-busy')==='true'){event.preventDefault();return;}
      form.setAttribute('aria-busy','true');
    });
    window.addEventListener('pageshow',function(){form.removeAttribute('aria-busy');});
  }
  // ---- reading position ---------------------------------------------------
  // Kept under the account, the task, and the URL's own result and view,
  // read again at every save so a tab switched in place records under the
  // view the URL now names.
  var returnKey=scrollPrefix+user+':'+task+':return';
  function scrollKeyFor(){var url=null;try{url=new URL(location.href);}catch(e){}
    return scrollPrefix+user+':'+task+':'+(url?(url.searchParams.get('result')||run)+':'+(url.searchParams.get('tab')||'summary'):run);}
  // Once a navigation has begun (pageswap / beforeunload) the document's
  // scroll is no longer the reader's — a cross-document transition can
  // move it to the top while it is captured — so remembering stops.
  var leaving=false;
  window.addEventListener('pageswap',function(){leaving=true;});
  window.addEventListener('beforeunload',function(){leaving=true;});
  if(panel&&user&&task){
    var pending=false;
    var remember=function(){pending=false;if(leaving)return;write(scrollKeyFor(),{y:window.scrollY,at:Date.now()});};
    rememberPosition=remember;
    window.addEventListener('scroll',function(){if(!pending){pending=true;requestAnimationFrame(remember);}},{passive:true});
    // Leaving the result view marks the way back, so the conversation can
    // return the reader to where they were. The position itself is taken
    // from the last scroll, never at pagehide: a navigation's transition
    // can already have moved the document by then.
    window.addEventListener('pagehide',function(){write(returnKey,{at:Date.now()});});
    var where=read(scrollKeyFor());
    if(where&&typeof where.y==='number'&&!location.hash){
      try{if('scrollRestoration' in history)history.scrollRestoration='manual';}catch(e){}
      window.scrollTo({top:where.y,behavior:'instant'});
    }
  }
  // Chat pages remember where the reader was, so opening a result and
  // coming back lands on the same message (the page itself, no panel).
  var composer=document.querySelector('.composer[data-chat-session]');
  if(!panel&&composer&&composer.dataset.chatTask){
    var chatUser=composer.dataset.chatUser||'',chatTask=composer.dataset.chatTask;
    var chatKey=scrollPrefix+chatUser+':'+chatTask+':chat',chatReturn=scrollPrefix+chatUser+':'+chatTask+':return';
    var chatPending=false;
    function rememberChat(){chatPending=false;if(leaving)return;write(chatKey,{y:window.scrollY,at:Date.now()});}
    window.addEventListener('scroll',function(){if(!chatPending){chatPending=true;requestAnimationFrame(rememberChat);}},{passive:true});
    var came=read(chatReturn);write(chatReturn,null);
    var back=read(chatKey);
    if(came&&typeof came.at==='number'&&came.at>Date.now()-600000&&back&&typeof back.y==='number'&&!location.hash){
      try{if('scrollRestoration' in history)history.scrollRestoration='manual';}catch(e){}
      window.scrollTo({top:back.y,behavior:'instant'});
    }
  }
})();`;

function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeAttribute(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
