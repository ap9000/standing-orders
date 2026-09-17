import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const child=spawn('npx',['--yes','shadcn@4.21.0','mcp'],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});
let seq=0,buffer='',stderr='';const pending=new Map();
child.stderr.on('data',b=>{stderr=(stderr+b).slice(-4000)});
child.stdout.on('data',b=>{buffer+=b;while(buffer.includes('\n')){const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;let reply;try{reply=JSON.parse(line)}catch{continue}if(reply.id!==undefined&&pending.has(reply.id)){const one=pending.get(reply.id);pending.delete(reply.id);clearTimeout(one.timer);reply.error?one.reject(Error(JSON.stringify(reply.error))):one.resolve(reply.result)}}});
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('Timed out: '+method))},60000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')});
let receipt;
try{
 const init=await send('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'standing-orders-shadcn-check',version:'1.0.0'}});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const inventory=await send('tools/list');
 receipt={package:'shadcn@4.21.0',at:new Date().toISOString(),init,tools:inventory.tools};
 if(process.argv[2]){const args=JSON.parse(process.argv[3]);receipt.call={name:process.argv[2],arguments:args,result:await send('tools/call',{name:process.argv[2],arguments:args})};}
 writeFileSync('output/shadcn-mcp/'+(process.argv[2]??'discovery')+'.json',JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify({package:receipt.package,server:receipt.init.serverInfo,tools:receipt.tools.map(t=>t.name),call:receipt.call}));
}finally{child.stdin.end();setTimeout(()=>child.kill('SIGTERM'),1500).unref();}
