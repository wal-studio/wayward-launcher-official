import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
const workerSource=fs.readFileSync(path.join(process.cwd(),"cloudflare/wayward-diagnostics-ingest/worker.mjs"),"utf8");
import { planRetention } from "../cloudflare/wayward-diagnostics-ingest/worker.mjs";
const GB=1_000_000_000,now=1_800_000_000,install="a".repeat(32),month="2026-11";
const item=(n,size,age=3600)=>({key:"reports/"+install+"/"+month+"/"+String(n).padStart(32,"0")+".zip",submissionId:String(n).padStart(32,"0"),size,createdAt:now-age-n});
test("usage below 90 percent never deletes",()=>{
 const result=planRetention({totalBytes:8.99*GB,candidates:[item(1,GB)],now});
 assert.equal(result.shouldDelete,false);assert.equal(result.reason,"below_90_percent");
});
test("90 percent threshold deletes oldest diagnostic ZIPs only until 85 percent target",()=>{
 const candidates=Array.from({length:12},(_,i)=>item(i+1,600_000_000));
 const result=planRetention({totalBytes:9.5*GB,candidates,now});
 assert.equal(result.shouldDelete,true);assert.equal(result.targetBytes,8.5*GB);
 assert.equal(result.deletions.length,2);assert.equal(result.deletions[0].submissionId,String(12).padStart(32,"0"));
 assert.equal(result.projectedBytes,8_300_000_000);
});
test("non-diagnostic storage floor blocks deletion if diagnostics cannot reach target",()=>{
 const candidates=Array.from({length:57},(_,i)=>item(i+1,10_000));
 const result=planRetention({totalBytes:14.87*GB,candidates,now});
 assert.equal(result.shouldDelete,false);assert.equal(result.reason,"diagnostic_only_storage_cannot_reach_target");
 assert.equal(result.deletions.length,0);
});
test("newest ten diagnostic submissions are protected",()=>{
 const candidates=Array.from({length:12},(_,i)=>item(i+1,600_000_000));
 const result=planRetention({totalBytes:9.5*GB,candidates,now});
 const removed=new Set(result.deletions.map(x=>x.submissionId));
 for(let i=1;i<=10;i++)assert.equal(removed.has(String(i).padStart(32,"0")),false);
});
test("existing upload routes remain and no Git upload is introduced",()=>{
 assert.ok(workerSource.includes("/v1/ticket"));
 assert.ok(workerSource.includes("/v1/upload"));
 assert.equal(workerSource.toLowerCase().includes("api.github.com"),false);
 assert.equal(workerSource.toLowerCase().includes("git push"),false);
 assert.equal(workerSource.toLowerCase().includes("git commit"),false);
});
test("retention is locked, report-only, and removes D1 rows only after R2 objects",()=>{
 assert.ok(workerSource.includes("diagnostics_cleanup_lock"));
 assert.ok(workerSource.includes("KEEP_RECENT_REPORTS=10"));
 assert.ok(workerSource.includes("REPORT_KEY="));
 assert.ok(workerSource.includes('include:["customMetadata"]'));
 assert.ok(workerSource.includes("env.DIAGNOSTICS.delete(candidate.key)"));
 assert.ok(workerSource.includes("DELETE FROM submissions"));
 const deletionBlock=workerSource.slice(workerSource.indexOf("await env.DIAGNOSTICS.delete(candidate.key)"),workerSource.indexOf("run.deletedCount++"));
 assert.ok(deletionBlock.indexOf("await env.DIAGNOSTICS.delete(candidate.key)")<deletionBlock.indexOf("DELETE FROM submissions WHERE submission_id"));
 assert.ok(workerSource.includes("env.SAVE_SHARE"));
 assert.ok(workerSource.includes("async scheduled("));
});
test("recent and non-diagnostic object keys are never eligible",()=>{
 const candidates=[item(1,2*GB,60),{...item(2,2*GB),key:"artifacts/build.zip"},{...item(3,2*GB),key:"reports/not-an-install/2026-11/abc.zip"}];
 const result=planRetention({totalBytes:9.5*GB,candidates,now});
 assert.equal(result.shouldDelete,false);
});
