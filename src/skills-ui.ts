import { randomUUID } from "node:crypto";
import type {
  SavedSkill,
  SkillsSnapshot,
  SkillsView,
  skillTestResult,
} from "./project-skills.js";
const e = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const hidden = (data: Record<string, unknown>) =>
  Object.entries(data)
    .map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`)
    .join("");
export const SKILLS_CSS = `.skills{max-width:780px;min-width:0;overflow-wrap:anywhere}.skills h2{font-size:1.1rem}.skills .card{padding:18px;margin:14px 0;min-width:0}.skills form,.skills label{display:grid;gap:10px}.skills input,.skills textarea,.skills select{box-sizing:border-box;width:100%;max-width:100%;min-width:0}.skills textarea{resize:vertical;min-height:130px}.skills button{justify-self:start;white-space:nowrap;min-height:44px}.skills summary{cursor:pointer;min-height:44px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}.skills pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;font-size:.9rem}.skills .skill-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.skills .skill-heading h2{margin:0}.skills .skill-state{font-size:.85rem;flex-shrink:0}.skills .skill-source{font-size:.85rem}.skills .skill-controls{display:flex;gap:12px;flex-wrap:wrap}.skills .skill-controls form{margin:0}.skills details details{margin-top:10px}.skills [hidden]{display:none!important}.skills .skill-files{max-height:200px;overflow:auto}.skills .problem{padding:12px}@media(max-width:600px){.skills input,.skills textarea,.skills select{font-size:16px}.skills .card{padding:14px}.skills .skill-heading{align-items:flex-start}}`;
function source(skill: SavedSkill) {
  return `<p class="skill-source">${e(skill.source)} · ${skill.sha.slice(0, 10)}</p><p>${skill.files.length} files · ${Math.ceil(skill.files.reduce((n, f) => n + Buffer.from(f.base64, "base64").length, 0) / 1024)} KB</p><pre>${e(Buffer.from(skill.files.find((f) => f.path === "SKILL.md")!.base64, "base64").toString("utf8"))}</pre><details><summary>Package files</summary><ul class="skill-files">${skill.files.map((f) => `<li>${e(f.path)}</li>`).join("")}</ul></details>`;
}
export function skillsHtml(
  view: SkillsView,
  csrf: string,
  canManage: boolean,
  options: {
    focus?: string;
    error?: string;
    draft?: Record<string, string>;
    agent?: string;
  } = {},
) {
  const manage = canManage && !!csrf,
    base = {
      csrf,
      repo: view.repo,
      identity: view.identity,
      revision: view.revision,
    };
  const form = (
    action: string,
    contents: string,
    extra: Record<string, unknown> = {},
  ) =>
    `<form method="post" action="/settings/skills/change">${hidden({ ...base, action, ...extra })}${contents}</form>`;
  const active = Object.values(view.selection).filter((c) => c.enabled).length;
  const renderSkill = (skill: SavedSkill) => {
    const enabled =
      view.selection[skill.name]?.sha === skill.sha &&
      view.selection[skill.name]?.enabled === true;
    const replaced =
      view.selection[skill.name]?.enabled &&
      view.selection[skill.name]?.sha !== skill.sha;
    return `<article class="card" id="skill-${skill.sha}"><div class="skill-heading"><h2>${e(skill.name)}</h2><span class="skill-state">${enabled ? "Enabled" : "In library"}</span></div><p>${e(skill.description)}</p>${skill.requirements ? `<p><strong>Requires:</strong> ${e(skill.requirements)} <span class="meta">Availability is checked when the agent tests or uses it.</span></p>` : ""}${skill.warnings.map((w) => `<p class="meta">${e(w)}</p>`).join("")}<details${options.focus === skill.sha ? " open" : ""}><summary>Review skill</summary>${source(skill)}${manage ? form(enabled ? "disable" : "enable", `${replaced ? "<p>Replaces the enabled version of this skill for new tasks.</p>" : ""}<button>${enabled ? "Disable skill" : "Enable skill"}</button>`, { sha: skill.sha }) : ""}</details>${manage ? `<details${options.draft?.["sha"] === skill.sha ? " open" : ""}><summary>Test skill</summary>${form("test", `<p>${e(options.agent ?? "Uses this project’s configured report agent")}. Runs a read-only sample through the normal task and approval flow.</p><label>Sample request<textarea name="sample" required maxlength="800" placeholder="Review this project’s home page and suggest three clearer button labels.">${e(options.draft?.["sha"] === skill.sha ? (options.draft?.["sample"] ?? "") : "")}</textarea></label><p class="meta">The report shows what worked and what needs tools or permission. Enabled status alone does not prove use.</p><button>Create test</button>`, { sha: skill.sha, nonce: randomUUID() })}</details>` : ""}</article>`;
  };
  const names = [...new Set(view.library.map((s) => s.name))];
  const cards = names
    .map((name) => {
      const versions = view.library.filter((s) => s.name === name),
        primary =
          versions.find((s) => s.sha === options.focus) ??
          versions.find((s) => s.sha === view.selection[name]?.sha) ??
          versions.at(-1)!;
      const older = versions.filter((s) => s !== primary);
      return `<div data-skill-group data-skill-query="${e(name + " " + primary.description)}">${renderSkill(primary)}${older.length ? `<details><summary>Other versions (${older.length})</summary>${older.map(renderSkill).join("")}</details>` : ""}</div>`;
    })
    .join("");
  const search =
    names.length > 5
      ? '<label>Search library<input type="search" data-skill-search placeholder="Name or description"></label><p data-skill-no-matches hidden>No matching skills.</p>'
      : "";
  const d = options.draft ?? {};
  const add = manage
    ? `<details class="card"${options.error && options.draft?.["method"] ? " open" : ""}><summary>Add skill</summary><form method="post" action="/settings/skills/import" data-skill-import>${hidden(base)}<label>Add from<select name="method" data-skill-method><option value="paste"${d["method"] === "paste" ? " selected" : ""}>Paste SKILL.md</option><option value="github"${d["method"] === "github" ? " selected" : ""}>GitHub folder</option><option value="folder"${d["method"] === "folder" ? " selected" : ""}>Local folder</option></select></label><div data-skill-input="paste"><label>SKILL.md<textarea name="content" rows="8" maxlength="24576" placeholder="---&#10;name: design-review&#10;description: Review interface copy and layout.&#10;---&#10;Write your instructions here.">${e(d["content"])}</textarea></label></div><div data-skill-input="github"><label>Public GitHub folder<input name="url" type="url" value="${e(d["url"])}" placeholder="https://github.com/owner/repo/tree/main/skills/review"></label></div><div data-skill-input="folder"><label>Skill folder<input type="file" webkitdirectory multiple data-skill-folder></label><input type="hidden" name="files" value=""><p class="meta">Choose the folder containing SKILL.md. Up to 64 files, 1 MB total.</p><noscript>Folder uploads require JavaScript. You can paste SKILL.md or use a GitHub folder.</noscript></div><p class="meta">Added to your library first. Review its source and requirements before enabling it.</p><p data-skill-error role="alert" hidden></p><button>Add to library</button></form></details>`
    : "";
  const history = view.history.length
    ? `<details><summary>Change history</summary>${view.history.map((h) => `<div class="card"><p>Selection ${h.revision} · ${e(h.actor)} · ${e(h.at.slice(0, 16).replace("T", " "))} UTC</p><ul>${h.enabled.length ? h.enabled.map((s) => `<li>${e(s.name)} · ${e(s.version)}</li>`).join("") : "<li>No skills enabled</li>"}</ul>${manage && h.revision !== view.revision ? form("restore", "<button>Restore selection</button>", { restore: h.revision }) : '<span class="meta">Current selection</span>'}</div>`).join("")}</details>`
    : "";
  return `<section class="skills">${options.error ? `<p class="problem" role="alert">${e(options.error)}</p>` : ""}<p>${active ? `${active} skill${active === 1 ? "" : "s"} enabled for new tasks.` : "No skills enabled for this project."} Active tasks keep their saved versions.</p>${add}${search}${cards || "<p>Your library is empty. Add a skill to review and enable it here.</p>"}${history}</section>`;
}
export function skillsSnapshotHtml(snapshot: SkillsSnapshot | null) {
  if (!snapshot || !snapshot.packages.length) return "";
  return `<details class="skills"><summary>Skills supplied (${snapshot.packages.length})</summary><p class="meta">Exact versions supplied to this run. This does not confirm the agent read or applied them.</p>${snapshot.packages.map((s) => `<details><summary>${e(s.name)} · ${s.sha.slice(0, 10)}</summary>${source(s)}</details>`).join("")}</details>`;
}
export function skillsScript() {
  return `(()=>{const search=document.querySelector('[data-skill-search]');if(search)search.addEventListener('input',()=>{let found=0;document.querySelectorAll('[data-skill-group]').forEach(el=>{el.hidden=!el.dataset.skillQuery.toLowerCase().includes(search.value.trim().toLowerCase());if(!el.hidden)found++;});document.querySelector('[data-skill-no-matches]').hidden=found>0;});const form=document.querySelector('[data-skill-import]');if(!form)return;const method=form.querySelector('[data-skill-method]'),error=form.querySelector('[data-skill-error]');function sync(){form.querySelectorAll('[data-skill-input]').forEach(el=>{el.hidden=el.dataset.skillInput!==method.value;el.querySelectorAll('input,textarea').forEach(i=>i.disabled=el.hidden);});}method.addEventListener('change',sync);sync();form.addEventListener('submit',async event=>{if(method.value!=='folder')return;if(form.dataset.prepared==='yes'){delete form.dataset.prepared;return;}event.preventDefault();error.hidden=true;const button=form.querySelector('button');button.disabled=true;try{const files=Array.from(form.querySelector('[data-skill-folder]').files);if(!files.length||files.length>64||files.reduce((n,f)=>n+f.size,0)>1048576||files.some(f=>f.size>262144))throw Error('Choose one skill folder with up to 64 files and 1 MB total.');const packed=[];for(const file of files){const parts=file.webkitRelativePath.split('/');parts.shift();const data=new Uint8Array(await file.arrayBuffer());let binary='';for(const byte of data)binary+=String.fromCharCode(byte);packed.push({path:parts.join('/'),base64:btoa(binary)});}form.querySelector('[name=files]').value=JSON.stringify(packed);form.dataset.prepared='yes';button.disabled=false;form.requestSubmit();}catch(e){error.textContent=e.message||'The folder could not be read. Select it again.';error.hidden=false;button.disabled=false;}});})();`;
}

export function skillTestFeedbackHtml(
  test: NonNullable<ReturnType<typeof skillTestResult>>,
  csrf: string,
  canManage: boolean,
  error = "",
  draft = "",
) {
  return `<section class="skills" id="skill-test-feedback"><h2>Improve this test</h2>${test.sourceRun ? `<p>Revises test run #${test.sourceRun}.</p>` : ""}${test.feedback ? `<details><summary>Feedback for this test</summary><p>${e(test.feedback)}</p></details>` : ""}${test.revisions.length ? `<p>${test.revisions.map((id, i) => `<a href="/t/${encodeURIComponent(id)}">Test revision ${i + 1}</a>`).join(" · ")}</p>` : ""}${error ? `<p role="alert">${e(error)}</p>` : ""}${canManage && csrf ? `<form method="post" action="/settings/skills/revise">${hidden({ csrf, repo: test.repo, run: test.run, nonce: randomUUID() })}<label>What should change?<textarea name="feedback" required maxlength="500" rows="3" placeholder="Try a clearer action label and explain why it fits the user’s goal.">${e(draft)}</textarea></label><p class="meta">Creates another report task with this skill version and your feedback. Review its scope before it runs.</p><button>Create revision</button></form>` : ""}</section>`;
}
