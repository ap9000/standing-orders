/** Progressive enhancement for the existing chat, not a second transport.
 * Native POSTs and server-rendered approval forms remain the authority.
 * Only the message draft is kept in this tab, for at most 24 hours. */
export const CHAT_CONTINUITY_SCRIPT = String.raw`
(function(){
  var form=document.querySelector('.composer[data-chat-session]');
  if(!form)return;
  var box=form.querySelector('textarea[name="message"]'),request=form.querySelector('[name="request"]');
  var status=document.getElementById('chat-connection'),session=form.dataset.chatSession;
  var key='standing-orders:chat-draft:'+session+':'+(form.dataset.chatTask||'');
  var prefix='standing-orders:chat-draft:',draft=null,sending=false,timer=null,polling=false;
  var busy=form.dataset.chatBusy==='1',version=form.dataset.chatVersion,storage=true;
  function say(text){if(status)status.textContent=text;}
  function fresh(){var bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return Array.from(bytes,function(b){return b.toString(16).padStart(2,'0');}).join('');}
  function save(){try{if(draft)sessionStorage.setItem(key,JSON.stringify(draft));else sessionStorage.removeItem(key);}catch(e){storage=false;}}
  try{
    for(var i=sessionStorage.length-1;i>=0;i--){var old=sessionStorage.key(i);if(old&&old.indexOf(prefix)===0){var item=JSON.parse(sessionStorage.getItem(old)||'null');if(!item||item.at<Date.now()-86400000||old.indexOf(prefix+session+':')!==0)sessionStorage.removeItem(old);}}
    var saved=JSON.parse(sessionStorage.getItem(key)||'null');
    if(saved&&typeof saved.text==='string'&&saved.text.length<=2000&&/^[a-f0-9]{32}$/.test(saved.request)){draft=saved;box.value=saved.text;request.value=saved.request;}
  }catch(e){storage=false;}
  function buttons(){document.querySelectorAll('form[action="/chat"] button[type="submit"]').forEach(function(button){button.disabled=busy||sending;});}
  box.addEventListener('input',function(){
    if(draft&&draft.submitted)request.value=fresh();
    draft=box.value===''?null:{text:box.value,request:request.value,submitted:false,at:Date.now()};save();
    if(!storage)say('Draft stays on this page only. Browser storage is unavailable.');
  });
  document.querySelectorAll('form[action="/chat"]').forEach(function(one){
    if(!one.querySelector('[name="request"]')){var id=document.createElement('input');id.type='hidden';id.name='request';id.value=fresh();one.appendChild(id);}
    if(!one.querySelector('[name="request-session"]')){var binding=document.createElement('input');binding.type='hidden';binding.name='request-session';binding.value=session;one.appendChild(binding);}
    one.addEventListener('submit',function(event){
      if(busy||sending){event.preventDefault();return;}
      if(one===form){if(!box.value.trim()){event.preventDefault();return;}draft={text:box.value,request:request.value,submitted:true,at:Date.now()};save();}
      sending=true;say('Sending…');
      // Keep the clicked submitter successful (its value is the prompt).
      // A logical latch prevents a second submit without disabling it.
      one.setAttribute('aria-busy','true');
    });
  });
  function later(ms){clearTimeout(timer);timer=setTimeout(check,ms);}
  async function check(){
    if(polling)return;
    if(document.hidden){later(5000);return;}
    polling=true;
    try{
      var sent=draft&&draft.submitted?draft.request:'';
      var r=await fetch('/chat/mate/status'+(sent?'?request='+encodeURIComponent(sent):''),{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(r.status===401||r.status===403||r.redirected){say('Sign in again to reconnect. Your draft stays in this tab.');return;}
      if(!r.ok)throw new Error('connection');
      var data=await r.json();
      if(String(data.session)!==session){draft=null;save();location.reload();return;}
      if(typeof data.version!=='string'||typeof data.pending!=='boolean')throw new Error('response');
      if(sent&&data.received&&draft&&draft.request===sent){
        draft=null;save();box.value='';request.value=fresh();box.dispatchEvent(new Event('input')); 
      }
      if(data.version!==version){
        var active=document.activeElement;
        if(active&&active.matches('input,textarea,select')){say('An update is ready. Finish editing, then tap outside the field to see it.');later(5000);return;}
        location.reload();return;
      }
      busy=data.pending;buttons();
      say(busy?'Reply in progress. You can draft your next message or come back later.':draft&&draft.submitted?'Message not confirmed. Check the conversation before retrying.':'Connected · changes appear as cards for you to confirm.');
      later(5000);
    }catch(e){say('Connection lost. Reconnecting… Your existing work is not cancelled.');later(10000);}
    finally{polling=false;}
  }
  document.addEventListener('visibilitychange',function(){if(!document.hidden){sending=false;buttons();later(0);}});
  document.addEventListener('focusout',function(){later(0);});
  window.addEventListener('online',function(){later(0);});
  window.addEventListener('pageshow',function(){sending=false;form.removeAttribute('aria-busy');buttons();later(0);});
  var end=document.querySelector('form[action="/chat/mate/end"]');
  if(end)end.addEventListener('submit',function(){draft=null;save();});
  buttons();later(0);
})();`;
