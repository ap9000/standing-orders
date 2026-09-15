import { describe, expect, test } from 'vitest';
import { Window } from 'happy-dom';
import type { ChatSnapshot } from './store.js';
import { chatWorkingHtml, chatActivityDetailsHtml, completedWorkHtml, CHAT_POLISH_CSS } from './chat-polish.js';
import { knowledgeHtml } from './knowledge-ui.js';

const snapshot = (tasks: ChatSnapshot['tasks']): ChatSnapshot => ({tasks,repos:[],tasksSaturated:false,decisions:[],decisionsSaturated:false,incidents:[],incidentsSaturated:false,routines:[],routinesSaturated:false,publications:[],publicationsSaturated:false});
const task = (id: string, patch: Partial<ChatSnapshot['tasks'][number]> = {}): ChatSnapshot['tasks'][number] => ({id,title:id,repoIndex:0,state:'done',ageHours:1,strikes:0,proofVerdict:null,proofMatrix:[],...patch});

describe('quiet chat and reference-first knowledge', () => {
  test('recorded activity stays inspectable without decorative status badges', () => {
    const win=new Window();try {
      win.document.body.innerHTML=chatActivityDetailsHtml('read 2 · proposed 0 · <script>');
      expect(win.document.querySelector('details')?.open).toBe(false);
      expect(win.document.querySelector('summary')?.textContent).toBe('Activity');
      expect(win.document.querySelector('.chat-activity')?.textContent).toContain('read 2');
      expect(win.document.querySelector('script')).toBeNull();
      expect(chatActivityDetailsHtml(null)).toBe('');
    } finally {win.close();}
  });
  test('completion list is bounded, escaped, family-linked, and never invents verified or since-last-visit claims', () => {
    const html=completedWorkHtml(snapshot([task('version',{rootId:'root/a',title:'<img onerror="bad">'}),task('two'),task('three'),task('four')]),['<Project>']);
    const win=new Window();try {
      win.document.body.innerHTML=html;
      expect(win.document.querySelectorAll('a')).toHaveLength(3);
      expect(win.document.querySelector('a')?.getAttribute('href')).toBe('/t/root%2Fa');
      expect(win.document.querySelector('img')).toBeNull();
      expect(win.document.body.textContent).toContain('<Project>');
      expect(html).not.toMatch(/Checks passed|Verified|while you were away|today/i);
    } finally {win.close();}
  });
  test('failed evidence, active work and damaged family history cannot enter the completion shortlist', () => {
    expect(completedWorkHtml(snapshot([
      task('failed',{state:'failed'}),task('working',{state:'running'}),task('short',{proofVerdict:'short'}),
      task('refuted',{proofVerdict:'refuted'}),task('history',{historyProblem:'missing version'}),task('active',{otherActive:['revision']})
    ]),[])).toBe('');
    expect(completedWorkHtml(snapshot([]),[])).toBe('');
  });
  test('pending chat is one quiet disclosure; billing remains readable and stop remains outside it', () => {
    const win=new Window();try {
      win.document.body.innerHTML=chatWorkingHtml({keyed:true,details:'Turn #1 · <unsafe> · up to $1 reserved',stopForm:'<form action="/chat/mate/stop"><button>Stop</button></form>'});
      expect(win.document.querySelector('[data-key="pending"] [role="status"]')).toBeNull();
      expect(win.document.querySelector('[data-key="pending"]')?.getAttribute('role')).toBe('status');
      expect(win.document.querySelector('details')?.open).toBe(false);
      expect(win.document.querySelector('summary')?.textContent).toBe('Working…');
      expect(win.document.querySelector('details form')).toBeNull();
      expect(win.document.querySelector('unsafe')).toBeNull();
      expect(win.document.querySelector('.meta')?.textContent).toContain('$1 reserved');
      expect(CHAT_POLISH_CSS).toContain('prefers-reduced-motion: no-preference');
    } finally {win.close();}
  });
  test('saved instructions read first; editing is explicit, failed drafts open, viewers cannot edit', () => {
    const view={repo:'/repo',identity:'identity',revision:1,history:[],knowledge:{instructions:'Keep things concise.',references:[]}};
    const win=new Window();try {
      win.document.body.innerHTML=knowledgeHtml(view,'csrf',true);
      expect(win.document.querySelector('.knowledge-instructions')?.textContent).toBe('Keep things concise.');
      expect(win.document.querySelector('details.knowledge-editor')?.hasAttribute('open')).toBe(false);
      expect(win.document.querySelector('form [name="revision"]')?.getAttribute('value')).toBe('1');
      win.document.body.innerHTML=knowledgeHtml(view,'csrf',true,{instructions:'My unsaved draft'},'Changed in another window.');
      expect(win.document.querySelector('details.knowledge-editor')?.hasAttribute('open')).toBe(true);
      expect(win.document.querySelector('textarea')?.value).toBe('My unsaved draft');
      expect(win.document.querySelector('[role="alert"]')?.textContent).toContain('another window');
      win.document.body.innerHTML=knowledgeHtml(view,'',false);
      expect(win.document.querySelector('form')).toBeNull();
    } finally {win.close();}
  });
});
