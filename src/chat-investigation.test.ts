import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.js";
import { addApprover } from "./scope.js";
import { verifyApproverByPassword } from "./principal.js";
import { investigate } from "./chat-investigation.js";

test("source inspection reads only admitted tracked text, redacts credentials, and refuses escapes", async () => {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"so-inspect-")));const store=openStore(":memory:");
  try {
    const repo=join(root,"project");mkdirSync(repo);execFileSync("git",["init","-q",repo]);
    writeFileSync(join(repo,"source.ts"),"export const count = 4;\nconst key = '"+"sk-"+"x".repeat(48)+"';\n");
    writeFileSync(join(repo,"untracked.txt"),"not committed");writeFileSync(join(root,"outside.txt"),"OUTSIDE-CANARY");
    symlinkSync(join(root,"outside.txt"),join(repo,"escape.txt"));
    execFileSync("git",["-C",repo,"add","source.ts","escape.txt"]);
    const added=addApprover(store,"alex",new Date());if(!added.ok)throw Error("fixture");
    const verified=verifyApproverByPassword(store,"alex",added.token,[repo]);if(!verified.ok)throw Error("fixture");
    const sources:string[]=[];
    const ctx={store,who:verified.who,now:new Date(),draft:()=>null,step:0,readDecisions:new Map<number,number>(),sources};
    const valid=JSON.stringify(await investigate(ctx,"read_file",{repo:"r1",path:"source.ts"}));
    expect(valid).toContain("count = 4");expect(valid).not.toContain("x".repeat(48));expect(valid).not.toContain(root);expect(sources).toHaveLength(1);
    for(const args of [{repo:"r1",path:"../outside.txt"},{repo:"r2",path:"source.ts"},{repo:"r1",path:"escape.txt"},{repo:"r1",path:"untracked.txt"},{repo:"r1",path:".env"}]) {
      const rejected=await investigate(ctx,"read_file",args);expect(rejected).toMatchObject({ok:false});expect(JSON.stringify(rejected)).not.toContain("OUTSIDE-CANARY");
    }
    expect(await investigate(ctx,"exec",{cmd:"rm -rf /"})).toMatchObject({ok:false});
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});
