import {test,expect} from 'vitest';
import {Window} from 'happy-dom';
import {WORKSPACE_MOTION_SCRIPT,WORKSPACE_MOTION_CSS} from './workspace-motion.js';
import {TRANSITIONS_CSS} from './transitions-recipes.js';
import {RESULT_REVIEW_SCRIPT} from './result-review.js';

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('native disclosures retain drafts, interrupt closing, and honor external closes',async()=>{
  const win=new Window();
  try{
    win.document.body.innerHTML='<details class="task-history"><summary>History</summary><textarea>Keep this draft</textarea></details>';
    win.eval(WORKSPACE_MOTION_SCRIPT);
    const d=win.document.querySelector('details')!,head=d.querySelector('summary')!,field=d.querySelector('textarea')!;
    expect(d.open).toBe(false);expect(d.querySelector('.t-acc-panel-inner')!.inert).toBe(true);
    head.click();expect(d.open).toBe(true);expect(d.dataset.open).toBe('true');
    field.focus();head.click();expect(d.dataset.open).toBe('false');expect(win.document.activeElement).toBe(head);
    head.click();expect(d.dataset.open).toBe('true');
    expect(d.querySelector('textarea')).toBe(field);expect(field.value).toBe('Keep this draft');
    d.open=false;await tick();expect(d.dataset.open).toBe('false');
    expect(d.querySelectorAll('.t-acc-panel')).toHaveLength(1);
  }finally{await win.happyDOM.close();}
});

test('menu cleanup survives rapid reopen and never submits its form',async()=>{
  const win=new Window();
  try{
    win.document.body.innerHTML='<details class="switcher"><summary>Projects</summary><div class="switcher-menu"><form><button>Project</button></form></div></details>';
    let submitted=false;win.document.addEventListener('submit',e=>{e.preventDefault();submitted=true;});
    win.eval(WORKSPACE_MOTION_SCRIPT);
    const d=win.document.querySelector('details')!,head=d.querySelector('summary')!,menu=d.querySelector('.t-dropdown')!;
    head.click();expect(menu.classList.contains('is-open')).toBe(true);
    head.click();expect(menu.classList.contains('is-closing')).toBe(true);expect(menu.inert).toBe(true);
    head.click();expect(menu.classList.contains('is-open')).toBe(true);expect(menu.classList.contains('is-closing')).toBe(false);
    expect(submitted).toBe(false);
    d.open=false;await tick();expect(menu.classList.contains('is-open')).toBe(false);
  }finally{await win.happyDOM.close();}
});

test('tab motion follows existing selection and enhances fresh live disclosures once',async()=>{
  const win=new Window({url:'http://fixture/r/1'});
  try{
    win.document.body.innerHTML='<section data-result-panel><nav class="result-tabs"><a data-result-tab="summary" aria-selected="true" href="?tab=summary">Summary</a><a data-result-tab="changes" aria-selected="false" href="?tab=changes">Changes</a></nav><div data-result-view="summary"></div><div data-result-view="changes" hidden></div></section>';
    win.eval(RESULT_REVIEW_SCRIPT);win.eval(WORKSPACE_MOTION_SCRIPT);
    const tab=win.document.querySelectorAll('a')[1]!;
    Object.defineProperty(tab,'offsetLeft',{value:90});Object.defineProperty(tab,'offsetWidth',{value:100});
    tab.click();await tick();
    const pill=win.document.querySelector<HTMLElement>('.t-tabs-pill')!;
    expect(pill.style.transform).toBe('translateX(90px)');expect(pill.style.width).toBe('100px');
    expect(win.document.querySelector<HTMLElement>('[data-result-view="changes"]')!.hidden).toBe(false);
    expect(new URL(win.location.href).searchParams.get('tab')).toBe('changes');
    win.document.body.insertAdjacentHTML('beforeend','<details class="decision-context"><summary>Context</summary><p>Long content</p></details>');
    await tick();await tick();
    expect(win.document.querySelectorAll('.decision-context > .t-acc-panel')).toHaveLength(1);
  }finally{await win.happyDOM.close();}
});

test('selected recipes preserve reduced motion; product overrides remove blur and decorative pills',()=>{
  expect(TRANSITIONS_CSS.match(/prefers-reduced-motion: reduce/g)).toHaveLength(4);
  expect(WORKSPACE_MOTION_CSS).toContain('--panel-blur: 0px');
  expect(WORKSPACE_MOTION_CSS).toContain('.t-acc .t-acc-panel-inner { filter: none; }');
  expect(WORKSPACE_MOTION_CSS).toContain('animation: none !important');
  expect(WORKSPACE_MOTION_SCRIPT).not.toMatch(/fetch\(|\.submit\(|requestSubmit\(/);
});
