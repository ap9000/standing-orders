/** Motion adapts presentation only. Native navigation, forms and tab state
 * remain owned by their existing handlers. No network or credential access. */
export const WORKSPACE_MOTION_CSS = String.raw`
:root {
  --panel-open-dur: 250ms;
  --panel-close-dur: 150ms;
  --panel-translate-y: 8px;
  --panel-blur: 0px;
  --tabs-text-muted: var(--muted-foreground);
  --tabs-text-active: var(--foreground);
  --tabs-bar-bg: transparent;
  --tabs-pill-bg: var(--foreground);
}
/* Keep the existing underline tabs and 44px controls, not the demo's pill. */
.result-tabs.t-tabs { display: flex; padding: 0; border-radius: 0; background: transparent; }
.result-tabs .t-tab { height: auto; min-height: 44px; border-radius: 0; }
.result-tabs.t-tabs a[aria-selected="true"] { border-bottom-color: transparent; }
.result-tabs .t-tabs-pill { top: auto; bottom: 0; height: 2px; border-radius: 0; }
.t-acc-panel-inner { min-height: 0; }
.t-acc .t-acc-panel-inner { filter: none; }
.t-acc[data-open="false"] > .t-acc-panel { grid-template-rows: 0fr; }
.t-acc[data-open="false"] > .t-acc-panel > .t-acc-panel-inner { opacity: 0; }
.t-acc > summary { cursor: pointer; }
.t-acc > summary .t-acc-chevron { width: 14px; height: 14px; margin-left: .4rem; }
.t-acc > summary .t-acc-chevron svg { width: 100%; height: 100%; }
.t-acc > summary::before, .t-acc > summary::after { content: none !important; }
.t-acc > summary::-webkit-details-marker { display: none; }
.t-acc > summary { list-style: none; }
.switcher[open] .switcher-menu.t-dropdown { animation: none; }
/* Cross-document entry/exit: links and POSTs are never held for motion.
 * Unsupported browsers keep normal, immediate navigation. */
.chat-result { view-transition-name: so-result; }
::view-transition-old(so-result) { animation: result-leave var(--panel-close-dur) var(--panel-ease) both; }
::view-transition-new(so-result) { animation: result-enter var(--panel-open-dur) var(--panel-ease) both; }
@keyframes result-enter { from { opacity: 0; transform: translateY(var(--panel-translate-y)); } }
@keyframes result-leave { to { opacity: 0; transform: translateY(var(--panel-translate-y)); } }
@media (prefers-reduced-motion: reduce) {
  ::view-transition-old(so-result), ::view-transition-new(so-result) { animation: none !important; }
}
`;

export const WORKSPACE_MOTION_SCRIPT = String.raw`
(function(){
  var reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  var closers=new WeakMap();
  function duration(name,fallback){
    if(reduced.matches)return 0;
    var raw=getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    var n=parseFloat(raw);return Number.isFinite(n)?n*(raw.endsWith('ms')?1:1000):fallback;
  }
  function enhanceDetails(details,menu){
    if(details.dataset.motionReady)return;
    var head=details.querySelector(':scope > summary');if(!head)return;
    var panel,inner;
    if(menu){
      panel=details.querySelector(':scope > .switcher-menu, :scope > .work-tools-menu');if(!panel)return;
      inner=panel;panel.classList.add('t-dropdown');panel.dataset.origin='top-left';
    }else{
      panel=document.createElement('div');panel.className='t-acc-panel';
      inner=document.createElement('div');inner.className='t-acc-panel-inner';
      Array.from(details.childNodes).forEach(function(node){if(node!==head)inner.appendChild(node);});
      panel.appendChild(inner);details.appendChild(panel);details.classList.add('t-acc');
      var chevron=document.createElement('span');chevron.className='t-acc-chevron';chevron.setAttribute('aria-hidden','true');
      chevron.innerHTML='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6.5L8 10.5L12 6.5"/></svg>';
      // Use the existing icon when present, rather than rendering two.
      var old=head.querySelector(':scope > svg');if(old)old.remove();head.appendChild(chevron);
    }
    details.dataset.motionReady='true';
    var timer=null,closing=false;
    function paint(open){
      details.dataset.open=String(open);head.setAttribute('aria-expanded',String(open));inner.inert=!open;
      if(menu){panel.classList.toggle('is-open',open);if(open)panel.classList.remove('is-closing');}
    }
    function cancel(){if(timer!==null)clearTimeout(timer);timer=null;}
    function finish(){closing=false;details.open=false;panel.classList.remove('is-closing');timer=null;paint(false);}
    function open(){
      cancel();closing=false;details.open=true;paint(false);panel.classList.remove('is-closing');
      void panel.offsetHeight;paint(true);
    }
    function close(){
      cancel();closing=true;
      if(inner.contains(document.activeElement))head.focus();
      paint(false);if(menu)panel.classList.add('is-closing');
      var ms=duration(menu?'--dropdown-close-dur':'--acc-collapse',menu?150:250);
      if(ms===0)finish();else timer=setTimeout(finish,ms);
    }
    paint(details.open);
    head.addEventListener('click',function(ev){
      if(ev.defaultPrevented||ev.ctrlKey||ev.metaKey||ev.altKey||ev.shiftKey||ev.button!==0)return;
      if(ev.target.closest('a,button,input,select,textarea'))return;
      ev.preventDefault();if(details.open&&!closing)close();else open();
    });
    // External close (Escape/outside click/group exclusivity) stays immediate.
    details.addEventListener('toggle',function(){
      if(!details.open){cancel();closing=false;panel.classList.remove('is-closing');paint(false);}
      else if(!closing)paint(true);
    });
    closers.set(details,function(){if(closing){cancel();finish();}});
  }
  function enhanceTabs(bar){
    if(bar.dataset.motionReady)return;
    var tabs=Array.from(bar.querySelectorAll('[data-result-tab]'));if(!tabs.length)return;
    bar.dataset.motionReady='true';bar.classList.add('t-tabs');
    var pill=document.createElement('span');pill.className='t-tabs-pill';pill.setAttribute('aria-hidden','true');bar.prepend(pill);
    tabs.forEach(function(tab){tab.classList.add('t-tab');});
    function move(animate){
      var tab=tabs.find(function(t){return t.getAttribute('aria-selected')==='true';})||tabs[0];
      var prev=pill.style.transition;
      if(!animate)pill.style.transition='none';
      pill.style.transform='translateX('+tab.offsetLeft+'px)';pill.style.width=tab.offsetWidth+'px';
      if(!animate){void pill.offsetWidth;pill.style.transition=prev;}
    }
    // Selection and keyboard behavior remain in RESULT_REVIEW_SCRIPT.
    new MutationObserver(function(){move(!reduced.matches);}).observe(bar,{subtree:true,attributes:true,attributeFilter:['aria-selected']});
    move(false);
    if(typeof ResizeObserver!=='undefined')new ResizeObserver(function(){move(false);}).observe(bar);
    else window.addEventListener('resize',function(){move(false);});
  }
  function scan(){
    document.querySelectorAll('details.switcher,details.work-tools').forEach(function(d){enhanceDetails(d,true);});
    document.querySelectorAll('details.nav-group,details.task-history,details.decision-context,details.result-knowledge,details.chat-activity-details,details.result-pin,details.result-notes,details.result-details').forEach(function(d){enhanceDetails(d,false);});
    document.querySelectorAll('.result-tabs').forEach(enhanceTabs);
  }
  scan();
  reduced.addEventListener('change',function(){if(reduced.matches)document.querySelectorAll('details[data-motion-ready]').forEach(function(d){var finish=closers.get(d);if(finish)finish();});});
  // Live chat can insert new disclosures. Only enhance fresh nodes; never
  // replace content or read field values, and never restart existing motion.
  var queued=false;
  new MutationObserver(function(records){
    if(queued||!records.some(function(r){return r.addedNodes.length>0;}))return;
    queued=true;queueMicrotask(function(){queued=false;scan();});
  }).observe(document.body,{childList:true,subtree:true});
})();
`;
