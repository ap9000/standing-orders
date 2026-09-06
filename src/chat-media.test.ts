import { test, expect, vi } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTelegramMedia, decodeChatFile, decodeChatUpload, saveTranscriptionKey, transcriptionKeyPath, telegramMedia } from "./chat-media.js";
import { parseLocalAssistantResult, runLocalAssistant } from "./chat-assistant.js";

test("attachments validate bytes, limits, type, and secret-containing text", () => {
  const png = Buffer.from([137,80,78,71,13,10,26,10]);
  const read = decodeChatFile(png,"document","application/octet-stream","picture.dat");
  expect(read.ok && read.content[0]?.source.media_type).toBe("image/png");
  expect(decodeChatFile(Buffer.from("hello"),"document","text/plain","notes.txt")).toMatchObject({ ok:true, content:[] });
  expect(decodeChatFile(Buffer.from("sk-"+"x".repeat(48)),"document","text/plain","notes.txt")).toMatchObject({ ok:false });
  expect(decodeChatFile(Buffer.from([0xff,0xfe]),"document","text/plain","notes.txt")).toMatchObject({ ok:false });
  expect(decodeChatFile(Buffer.alloc(5_000_001),"image","image/png","big.png")).toMatchObject({ ok:false });
  expect(decodeChatFile(Buffer.from("#!/bin/sh\n"),"document","application/octet-stream","program.sh")).toMatchObject({ ok:false });
  expect(decodeChatUpload(JSON.stringify({name:"notes.md",mime:"text/plain",data:Buffer.from("a note").toString("base64")}))).toMatchObject({ok:true});
  expect(decodeChatUpload('{"data":"invalid!!!"}')).toMatchObject({ok:false});
  expect(telegramMedia({photo:[{file_id:"small"},{file_id:"large",file_size:100}]})).toMatchObject({fileId:"large",kind:"image"});
});

test("Telegram file fetch is bounded and cannot redirect or escape the fixed API origin", async () => {
  const dir=mkdtempSync(join(tmpdir(),"so-media-test-"));
  try {
    const fetcher=vi.fn(async (_input:RequestInfo|URL, init?:RequestInit)=>{expect(init?.redirect).toBe("error");return new Response("notes");}) as unknown as typeof fetch;
    const media={kind:"document" as const,fileId:"id",mime:"text/plain",name:"notes.txt",size:5};
    const good=await readTelegramMedia(media,{token:"fixture",configDir:dir,transport:async()=>({ok:true,result:{file_path:"documents/file.txt"}}),fetcher});
    expect(good).toMatchObject({ok:true}); expect(fetcher).toHaveBeenCalledOnce();
    const bad=await readTelegramMedia(media,{token:"fixture",configDir:dir,transport:async()=>({ok:true,result:{file_path:"../bot-secret"}}),fetcher});
    expect(bad).toMatchObject({ok:false}); expect(fetcher).toHaveBeenCalledOnce();
    const tooLarge=await readTelegramMedia(media,{token:"fixture",configDir:dir,transport:async()=>({ok:true,result:{file_path:"files/large.txt"}}),fetcher:async()=>new Response("x",{headers:{"content-length":"6000000"}})});
    expect(tooLarge).toMatchObject({ok:false});
    let active=true;
    const revoked=await readTelegramMedia(media,{token:"fixture",configDir:dir,active:()=>active,transport:async()=>{active=false;return {ok:true,result:{file_path:"documents/file.txt"}};},fetcher});
    expect(revoked).toMatchObject({ok:false});expect(fetcher).toHaveBeenCalledOnce();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("voice is opt-in, uses a separately stored key, and never stores or echoes that key", async () => {
  const dir=mkdtempSync(join(tmpdir(),"so-voice-test-"));
  try {
    const media={kind:"voice" as const,fileId:"voice",mime:"audio/ogg",name:"Voice note",size:10};
    const transport=vi.fn(async()=>({ok:true,result:{file_path:"voice/test.ogg"}}));
    const missing=await readTelegramMedia(media,{token:"bot-fixture",configDir:dir,transport});
    expect(missing).toMatchObject({ok:false}); expect(transport).not.toHaveBeenCalled();
    saveTranscriptionKey(dir,"sk-"+"fixture".repeat(4));
    expect(statSync(transcriptionKeyPath(dir)).mode & 0o777).toBe(0o600);
    const calls:string[]=[];
    const result=await readTelegramMedia(media,{token:"bot-fixture",configDir:dir,transport,fetcher:async(input,init)=>{
      calls.push(String(input));
      if(String(input).includes("transcriptions")){expect(init?.body).toBeInstanceOf(FormData);expect((init!.body as FormData).get("model")).toBe("gpt-4o-mini-transcribe");return Response.json({text:"What needs me today?"});}
      return new Response("OggSfixture");
    }});
    expect(result).toMatchObject({ok:true,text:expect.stringContaining("What needs me today?")});
    expect(JSON.stringify(result)).not.toContain("sk-"); expect(calls).toHaveLength(2);
    saveTranscriptionKey(dir,null);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("multimodal CLI input uses stream-json on both sides and keeps image bytes out of argv", async () => {
  const result=await runLocalAssistant({cwd:tmpdir(),model:null,prompt:"Read this image.",attachments:[{type:"image",source:{type:"base64",media_type:"image/png",data:"aGVsbG8="}}],runner:async(_file,args,options)=>{
    expect(args[args.indexOf("--input-format")+1]).toBe("stream-json"); expect(args[args.indexOf("--output-format")+1]).toBe("stream-json");
    expect(args).toContain("--verbose"); expect(args.join(" ")).not.toContain("aGVsbG8");
    expect(JSON.parse(options!.input!).message.content).toHaveLength(2);
    return {code:0,stdout:JSON.stringify({type:"system",subtype:"init"})+"\n"+JSON.stringify({type:"result",subtype:"success",result:"Blue"})+"\n",stderr:"",timedOut:false,notFound:false};
  }});
  expect(result).toMatchObject({ok:true,answer:{text:"Blue"}});
  expect(parseLocalAssistantResult({code:0,stdout:'{"type":"system"}\nNOT JSON\n',stderr:"",timedOut:false,notFound:false})).toMatchObject({ok:false});
});
