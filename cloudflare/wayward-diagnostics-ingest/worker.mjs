const enc=new TextEncoder(),MAX=5*1024*1024,TTL=600,HOUR=3600;
function b64u(b){let s="";for(const x of b)s+=String.fromCharCode(x);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")}
async function hash(b){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",b))].map(x=>x.toString(16).padStart(2,"0")).join("")}
function out(v,s=200){return new Response(JSON.stringify(v),{status:s,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}})}
function hex(v,n){return typeof v==="string"&&new RegExp("^[a-f0-9]{"+n+"}$").test(v)}
async function rate(env,key,limit,windowStart){const r=await env.DB.prepare("INSERT INTO rate_limits(bucket_key,window_start,hits) VALUES(?,?,1) ON CONFLICT(bucket_key,window_start) DO UPDATE SET hits=hits+1 RETURNING hits").bind(key,windowStart).first();return (r?.hits||0)<=limit}

// User-requested instantaneous object-storage guard; Cloudflare bills R2 storage in GB-month.
const R2_OPERATIONAL_CAP_BYTES=10_000_000_000;
const R2_TRIGGER_BYTES=Math.floor(R2_OPERATIONAL_CAP_BYTES*0.90);
const R2_TARGET_BYTES=Math.floor(R2_OPERATIONAL_CAP_BYTES*0.85);
const KEEP_RECENT_REPORTS=10;
const MIN_REPORT_AGE_SECONDS=15*60;
const REPORT_KEY=/^reports\/([a-f0-9]{32})\/(\d{4}-\d{2})\/([a-f0-9]{32})\.zip$/;

export function planRetention(input){
 const totalBytes=Number(input?.totalBytes||0),now=Number(input?.now||0);
 const candidates=Array.isArray(input?.candidates)?input.candidates:[];
 if(!Number.isFinite(totalBytes)||totalBytes<R2_TRIGGER_BYTES)
  return {shouldDelete:false,reason:"below_90_percent",totalBytes,targetBytes:R2_TARGET_BYTES,deletions:[]};
 const sorted=[...candidates].filter(x=>x&&REPORT_KEY.test(String(x.key||""))&&Number(x.size)>0&&Number.isFinite(Number(x.createdAt)))
  .sort((a,b)=>Number(a.createdAt)-Number(b.createdAt));
 const protectedIds=new Set([...sorted].sort((a,b)=>Number(b.createdAt)-Number(a.createdAt))
  .slice(0,KEEP_RECENT_REPORTS).map(x=>String(x.submissionId||"")));
 const eligible=sorted.filter(x=>!protectedIds.has(String(x.submissionId||""))
  &&Number(x.createdAt)<=now-MIN_REPORT_AGE_SECONDS);
 const eligibleBytes=eligible.reduce((sum,x)=>sum+Number(x.size),0);
 const requiredBytes=Math.max(0,totalBytes-R2_TARGET_BYTES);
 if(eligibleBytes<requiredBytes)
  return {shouldDelete:false,reason:"diagnostic_only_storage_cannot_reach_target",totalBytes,targetBytes:R2_TARGET_BYTES,eligibleBytes,requiredBytes,deletions:[]};
 const deletions=[];let remainingBytes=totalBytes;
 for(const item of eligible){
  if(remainingBytes<=R2_TARGET_BYTES)break;
  deletions.push(item);remainingBytes-=Number(item.size);
 }
 return {shouldDelete:deletions.length>0,reason:deletions.length?"threshold_reached":"no_eligible_reports",
  totalBytes,targetBytes:R2_TARGET_BYTES,eligibleBytes,requiredBytes,projectedBytes:remainingBytes,deletions};
}

async function listAllObjects(bucket,includeCustomMetadata=false){
 const objects=[];let cursor;
 do{
  const page=await bucket.list({limit:1000,...(includeCustomMetadata?{include:["customMetadata"]}:{}),...(cursor?{cursor}:{})});
  objects.push(...(page.objects||[]));
  if(page.truncated&&!page.cursor)throw new Error("R2 listing truncated without a continuation cursor");
  cursor=page.truncated?page.cursor:undefined;
 }while(cursor);
 return objects;
}

async function ensureRetentionSchema(env){
 await env.DB.batch([
  env.DB.prepare("CREATE TABLE IF NOT EXISTS diagnostics_cleanup_lock (lock_id INTEGER PRIMARY KEY CHECK(lock_id=1), lock_token TEXT NOT NULL, locked_until INTEGER NOT NULL)"),
  env.DB.prepare("CREATE TABLE IF NOT EXISTS diagnostics_cleanup_items (object_key TEXT PRIMARY KEY, submission_id TEXT NOT NULL, sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL, status TEXT NOT NULL, first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_error TEXT)"),
  env.DB.prepare("CREATE TABLE IF NOT EXISTS diagnostics_cleanup_runs (run_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL, reason TEXT NOT NULL, measured_bytes INTEGER NOT NULL DEFAULT 0, report_bytes INTEGER NOT NULL DEFAULT 0, deleted_count INTEGER NOT NULL DEFAULT 0, deleted_bytes INTEGER NOT NULL DEFAULT 0, measurement TEXT NOT NULL)")
 ]);
}

async function recordCleanupRun(env,run){
 await env.DB.prepare("INSERT INTO diagnostics_cleanup_runs(run_id,started_at,finished_at,status,reason,measured_bytes,report_bytes,deleted_count,deleted_bytes,measurement) VALUES(?,?,?,?,?,?,?,?,?,?)")
  .bind(run.runId,run.startedAt,Math.floor(Date.now()/1000),run.status,run.reason,run.measuredBytes||0,run.reportBytes||0,run.deletedCount||0,run.deletedBytes||0,"r2_object_listing_all_existing_buckets").run();
 await env.DB.prepare("DELETE FROM diagnostics_cleanup_runs WHERE started_at < ?").bind(Math.floor(Date.now()/1000)-90*86400).run();
 await env.DB.prepare("DELETE FROM diagnostics_cleanup_items WHERE status='deleted' AND updated_at < ?").bind(Math.floor(Date.now()/1000)-90*86400).run();
}

async function recoverDeletedR2Rows(env,now){
 const pending=await env.DB.prepare("SELECT object_key,submission_id,sha256,status FROM diagnostics_cleanup_items WHERE status IN ('deleting','r2_deleted','failed')").all();
 for(const item of pending.results||[]){
  const current=await env.DIAGNOSTICS.head(item.object_key);
  if(!current){
   await env.DB.prepare("DELETE FROM submissions WHERE submission_id=? AND object_key=? AND sha256=?")
    .bind(item.submission_id,item.object_key,item.sha256).run();
   await env.DB.prepare("UPDATE diagnostics_cleanup_items SET status='deleted',updated_at=?,last_error=NULL WHERE object_key=?")
    .bind(now,item.object_key).run();
  }
 }
}

async function runRetention(env,scheduledTime){
 const now=Math.floor((Number(scheduledTime)||Date.now())/1000),runId=crypto.randomUUID();
 const run={runId,startedAt:now,status:"skipped",reason:"not_started",measuredBytes:0,reportBytes:0,deletedCount:0,deletedBytes:0};
 await ensureRetentionSchema(env);
 const lockToken=crypto.randomUUID();
 const lock=await env.DB.prepare("INSERT INTO diagnostics_cleanup_lock(lock_id,lock_token,locked_until) VALUES(1,?,?) ON CONFLICT(lock_id) DO UPDATE SET lock_token=excluded.lock_token,locked_until=excluded.locked_until WHERE diagnostics_cleanup_lock.locked_until < ? RETURNING lock_token")
  .bind(lockToken,now+600,now).first();
 if(!lock){run.reason="another_cleanup_is_running";console.log("diagnostics_retention",JSON.stringify(run));return;}
 try{
  if(!env.DIAGNOSTICS||!env.SAVE_SHARE)throw new Error("Required existing R2 bindings are unavailable");
  await recoverDeletedR2Rows(env,now);
  const [diagnosticObjects,saveShareObjects,submissionResult,ticketResult]=await Promise.all([
   listAllObjects(env.DIAGNOSTICS,true),listAllObjects(env.SAVE_SHARE),
   env.DB.prepare("SELECT submission_id,install_id,sha256,object_key,byte_length,created_at FROM submissions ORDER BY created_at ASC").all(),
   env.DB.prepare("SELECT DISTINCT expected_sha256 FROM upload_tickets WHERE used_at IS NULL AND expires_at>=?").bind(now).all()
  ]);
  run.measuredBytes=[...diagnosticObjects,...saveShareObjects].reduce((sum,item)=>sum+Number(item.size||0),0);
  run.reportBytes=diagnosticObjects.filter(item=>String(item.key||"").startsWith("reports/")&&String(item.key||"").endsWith(".zip"))
   .reduce((sum,item)=>sum+Number(item.size||0),0);
  const rows=submissionResult.results||[];
  const byKey=new Map(rows.map(row=>[row.object_key,row]));
  const activeHashes=new Set((ticketResult.results||[]).map(row=>row.expected_sha256));
  const candidates=[];
  for(const object of diagnosticObjects){
   const match=REPORT_KEY.exec(String(object.key||""));if(!match)continue;
   const row=byKey.get(object.key),meta=object.customMetadata||{};
   if(!row||row.submission_id!==match[3]||row.install_id!==match[1]||meta.installId!==row.install_id
    ||meta.submissionId!==row.submission_id||meta.sha256!==row.sha256
    ||Number(row.byte_length)!==Number(object.size)||Number(meta.createdAt)!==Number(row.created_at)
    ||new Date(Number(row.created_at)*1000).toISOString().slice(0,7)!==match[2]
    ||activeHashes.has(row.sha256))continue;
   candidates.push({key:object.key,size:Number(object.size),createdAt:Number(row.created_at),
    submissionId:row.submission_id,sha256:row.sha256,etag:object.etag});
  }
  const plan=planRetention({totalBytes:run.measuredBytes,candidates,now});
  run.reason=plan.reason;
  if(!plan.shouldDelete){
   run.status=plan.reason==="below_90_percent"?"below_threshold":"blocked_no_safe_diagnostic_only_cleanup";
   await recordCleanupRun(env,run);console.log("diagnostics_retention",JSON.stringify(run));return;
  }
  let remaining=run.measuredBytes;
  for(const candidate of plan.deletions){
   const current=await env.DIAGNOSTICS.head(candidate.key);
   if(!current||current.etag!==candidate.etag||Number(current.size)!==candidate.size)continue;
   const row=await env.DB.prepare("SELECT submission_id,sha256,object_key,byte_length,created_at FROM submissions WHERE object_key=?")
    .bind(candidate.key).first();
   if(!row||row.submission_id!==candidate.submissionId||row.sha256!==candidate.sha256
    ||Number(row.byte_length)!==candidate.size||Number(row.created_at)!==candidate.createdAt)continue;
   const active=await env.DB.prepare("SELECT 1 AS active FROM upload_tickets WHERE expected_sha256=? AND used_at IS NULL AND expires_at>=? LIMIT 1")
    .bind(candidate.sha256,now).first();
   if(active)continue;
   const latest=await env.DB.prepare("SELECT submission_id FROM submissions ORDER BY created_at DESC LIMIT ?")
    .bind(KEEP_RECENT_REPORTS).all();
   if((latest.results||[]).some(item=>item.submission_id===candidate.submissionId))continue;
   await env.DB.prepare("INSERT INTO diagnostics_cleanup_items(object_key,submission_id,sha256,byte_length,status,first_seen_at,updated_at,last_error) VALUES(?,?,?,?,?,?,?,NULL) ON CONFLICT(object_key) DO UPDATE SET status='deleting',updated_at=excluded.updated_at,last_error=NULL")
    .bind(candidate.key,candidate.submissionId,candidate.sha256,candidate.size,"deleting",now,now).run();
   try{
    await env.DIAGNOSTICS.delete(candidate.key);
    const after=await env.DIAGNOSTICS.head(candidate.key);
    if(after)throw new Error("R2 object still exists after delete");
    await env.DB.prepare("UPDATE diagnostics_cleanup_items SET status='r2_deleted',updated_at=? WHERE object_key=?")
     .bind(now,candidate.key).run();
    await env.DB.prepare("DELETE FROM submissions WHERE submission_id=? AND object_key=? AND sha256=?")
     .bind(candidate.submissionId,candidate.key,candidate.sha256).run();
    await env.DB.prepare("UPDATE diagnostics_cleanup_items SET status='deleted',updated_at=?,last_error=NULL WHERE object_key=?")
     .bind(now,candidate.key).run();
    run.deletedCount++;run.deletedBytes+=candidate.size;remaining-=candidate.size;
   }catch(error){
    await env.DB.prepare("UPDATE diagnostics_cleanup_items SET status='failed',updated_at=?,last_error=? WHERE object_key=?")
     .bind(now,String(error?.message||error).slice(0,240),candidate.key).run();
    console.error("diagnostics_retention_delete_failed",JSON.stringify({runId,key:candidate.key,errorName:error?.name||"UnknownError",errorMessage:String(error?.message||error).slice(0,240)}));
   }
   if(remaining<=R2_TARGET_BYTES)break;
  }
  run.status=remaining<=R2_TARGET_BYTES?"completed":"partial";
  run.reason=remaining<=R2_TARGET_BYTES?"target_reached":"eligible_diagnostic_reports_exhausted_or_failed";
  await recordCleanupRun(env,run);
  console.log("diagnostics_retention",JSON.stringify(run));
 }catch(error){
  run.status="error";run.reason=String(error?.message||error).slice(0,240);
  try{await recordCleanupRun(env,run);}catch(recordError){console.error("diagnostics_retention_record_failed",String(recordError?.message||recordError));}
  console.error("diagnostics_retention_failed",JSON.stringify({runId,errorName:error?.name||"UnknownError",errorMessage:run.reason}));
 }finally{
  await env.DB.prepare("UPDATE diagnostics_cleanup_lock SET locked_until=0 WHERE lock_id=1 AND lock_token=?").bind(lockToken).run();
 }
}

export default{async fetch(req,env){
 const u=new URL(req.url),requestId=crypto.randomUUID();
 let stage="route";
 try {
 if(req.method==="GET"&&u.pathname==="/health")return out({ok:true,service:"wayward-diagnostics-ingest",version:1});
 if(req.method==="POST"&&u.pathname==="/v1/ticket"){
  stage="ticket_validate";
  if(Number(req.headers.get("content-length")||0)>2048)return out({error:"request_too_large"},413);
  let x;try{x=await req.json()}catch{return out({error:"invalid_json"},400)}
  const id=x?.installId,h=x?.sha256,n=Number(x?.byteLength);
  if(!hex(id,32)||!hex(h,64)||!Number.isInteger(n)||n<1||n>MAX)return out({error:"invalid_request"},400);
  stage="ticket_rate_limit";
  const ip=req.headers.get("CF-Connecting-IP")||"unknown",ipHash=await hash(enc.encode(ip)),now=Math.floor(Date.now()/1000),win=Math.floor(now/HOUR)*HOUR;
  const [ipOk,installOk]=await Promise.all([rate(env,"ip:"+ipHash,100,win),rate(env,"install:"+id,10,win)]);
  if(!ipOk||!installOk)return out({error:"rate_limited",retryAfter:win+HOUR-now},429);
  stage="ticket_cleanup";
  await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now-48*HOUR).run();
  await env.DB.prepare("DELETE FROM upload_tickets WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)").bind(now-86400,now-86400).run();
  stage="ticket_token_generation";
  const token=b64u(crypto.getRandomValues(new Uint8Array(32))),tokenHash=await hash(enc.encode(token)),exp=now+TTL;
  stage="ticket_insert";
  await env.DB.prepare("INSERT INTO upload_tickets(nonce,install_id,ip_hash,expected_sha256,expires_at) VALUES(?,?,?,?,?)").bind(tokenHash,id,ipHash,h,exp).run();
  return out({ticket:token,expiresAt:exp,uploadUrl:"/v1/upload",maxBytes:MAX});
 }
 if(req.method==="POST"&&u.pathname==="/v1/upload"){
  stage="upload_authorize";
  const auth=/^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.get("authorization")||"");if(!auth)return out({error:"missing_ticket"},401);
  const tokenHash=await hash(enc.encode(auth[1])),now=Math.floor(Date.now()/1000);
  const t=await env.DB.prepare("SELECT nonce,install_id,expected_sha256,expires_at,used_at FROM upload_tickets WHERE nonce=?").bind(tokenHash).first();
  if(!t||t.used_at!==null||t.expires_at<now)return out({error:"ticket_unavailable"},401);
  const len=Number(req.headers.get("content-length")||0);
  if(len<1||len>MAX||req.headers.get("content-type")!=="application/zip")return out({error:"invalid_upload_size_or_type"},400);
  const bytes=await req.arrayBuffer();if(bytes.byteLength!==len||await hash(bytes)!==t.expected_sha256)return out({error:"checksum_mismatch"},400);
  const prior=await env.DB.prepare("SELECT submission_id FROM submissions WHERE sha256=?").bind(t.expected_sha256).first();
  if(prior){await env.DB.prepare("UPDATE upload_tickets SET used_at=? WHERE nonce=? AND used_at IS NULL").bind(now,tokenHash).run();return out({ok:true,duplicate:true,submissionId:prior.submission_id})}
  const sid=crypto.randomUUID().replace(/-/g,""),month=new Date(now*1000).toISOString().slice(0,7),key="reports/"+t.install_id+"/"+month+"/"+sid+".zip";
  stage="upload_r2_put";
  await env.DIAGNOSTICS.put(key,bytes,{httpMetadata:{contentType:"application/zip",cacheControl:"private, no-store"},customMetadata:{submissionId:sid,installId:t.install_id,sha256:t.expected_sha256,createdAt:String(now)}});
  const version=(req.headers.get("x-wayward-version")||"").slice(0,32).replace(/[^A-Za-z0-9._+-]/g,""),errors=Math.max(0,Math.min(10000,Number(req.headers.get("x-wayward-error-count")||0)||0));
  stage="upload_d1_commit";
  try{
   const r=await env.DB.batch([
    env.DB.prepare("INSERT INTO submissions(submission_id,install_id,sha256,object_key,byte_length,created_at,app_version,error_count) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM upload_tickets WHERE nonce=? AND used_at IS NULL AND expires_at>=?) AND NOT EXISTS(SELECT 1 FROM submissions WHERE sha256=?)").bind(sid,t.install_id,t.expected_sha256,key,len,now,version,errors,tokenHash,now,t.expected_sha256),
    env.DB.prepare("UPDATE upload_tickets SET used_at=? WHERE nonce=? AND used_at IS NULL AND expires_at>=?").bind(now,tokenHash,now)
   ]);
   if(!r?.[0]?.meta?.changes||!r?.[1]?.meta?.changes){await env.DIAGNOSTICS.delete(key);const dup=await env.DB.prepare("SELECT submission_id FROM submissions WHERE sha256=?").bind(t.expected_sha256).first();if(dup)return out({ok:true,duplicate:true,submissionId:dup.submission_id});return out({error:"ticket_replayed"},409)}
  }catch(error){console.error("wayward-diagnostics-ingest commit failure",JSON.stringify({requestId,stage:"upload_d1_commit",errorName:error instanceof Error?error.name:"UnknownError",errorMessage:error instanceof Error?error.message.slice(0,240):"Unexpected failure"}));await env.DIAGNOSTICS.delete(key);const dup=await env.DB.prepare("SELECT submission_id FROM submissions WHERE sha256=?").bind(t.expected_sha256).first();if(dup)return out({ok:true,duplicate:true,submissionId:dup.submission_id});return out({error:"storage_commit_failed"},503)}
  return out({ok:true,duplicate:false,submissionId:sid,createdAt:now});
 }
 return out({error:"not_found"},404);
 } catch(error) {
  console.error("wayward-diagnostics-ingest failure",JSON.stringify({requestId,stage,errorName:error instanceof Error?error.name:"UnknownError",errorMessage:error instanceof Error?error.message.slice(0,240):"Unexpected failure"}));
  return out({error:"internal_error",requestId},500);
 }
 },
 async scheduled(controller,env,ctx){
  ctx.waitUntil(runRetention(env,controller?.scheduledTime).catch(error=>{
   console.error("diagnostics_retention_unhandled",String(error?.message||error));
  }));
 }
};