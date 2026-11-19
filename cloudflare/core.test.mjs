import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceClock } from './core.mjs';

const env={COLLECTOR_URL:'https://collector.example.test',COLLECTOR_SERVICE_TOKEN:'private-test'};
function fixture(n=1350) {
  let state=null,time=30*60000,active=0,peak=0,tickRequests=0;const complete=new Set(),runIds=[],begins=[];
  const transport=async(url,init)=>{
    tickRequests++;assert.ok(tickRequests<=48);assert.equal(url.origin,env.COLLECTOR_URL);assert.equal(init.redirect,'manual');
    const body=JSON.parse(init.body);assert.equal(init.headers['OAI-Sites-Authorization'],'Bearer private-test');
    if(body.action==='begin'){runIds.push(body.runId);begins.push(body);return Response.json({runId:body.runId,status:'running',sourceIds:Array.from({length:n},(_,i)=>'greenhouse-'+i),deadline:time+55*60000});}
    if(body.action==='finish')return Response.json({status:complete.size===n?'complete':'partial',expected:n,successful:complete.size,failed:0,unfinished:n-complete.size});
    active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,0));body.sourceIds.forEach(id=>complete.add(id));active--;
    return Response.json({successful:body.sourceIds.length});
  };
  return {tick:async(options={})=>{tickRequests=0;return advanceClock(state,s=>state=structuredClone(s),env,{transport,now:()=>time,...options});},
    transport,next:()=>time+=2*60000,advance:ms=>time+=ms,get state(){return state},get peak(){return peak},runIds,begins};
}
test('the free-tier timer covers 1350 feeds within one hour without overlapping or exceeding subrequest budgets',async()=>{
 const f=fixture();let result;
 for(let i=0;i<17;i++){result=await f.tick();f.next();}
 assert.equal(result.status,'complete');assert.equal(result.successful,1350);assert.equal(f.peak,4);assert.equal(f.runIds.length,1);assert.equal(f.begins[0].origin,'scheduled');
 assert.equal((await f.tick()).status,'idle');assert.equal(f.runIds.length,1);
 f.advance(26*60000);await f.tick();assert.equal(f.runIds.length,2);
});
test('a failed wave replays safely from durable state and does not skip assignments',async()=>{
 const f=fixture(10);let failed=true;
 const unavailable=async(url,init)=>{if(JSON.parse(init.body).action==='collect'&&failed){failed=false;return Response.json({}, {status:400});}return f.transport(url,init);};
 const bad=await f.tick({transport:unavailable});assert.equal(bad.status,'deferred');assert.ok(!JSON.stringify(bad).includes('private provider body'));
 assert.equal(f.state.cursor,0);
 f.next();const done=await f.tick();assert.equal(done.status,'complete');assert.equal(done.successful,10);
});
test('an expired collection budget finalizes unfinished feeds instead of reporting a successful sweep',async()=>{
 const f=fixture();await f.tick();f.advance(51*60000);const done=await f.tick();assert.equal(done.status,'partial');assert.equal(done.successful,80);assert.equal(done.unfinished,1270);
});
test('redirects and malformed responses never expose credentials or follow another origin',async()=>{
 const f=fixture();let count=0;
 const result=await f.tick({transport:async()=>{count++;return new Response('',{status:302});}});
 assert.equal(count,1);assert.equal(result.status,'deferred');assert.match(result.error,/302/);assert.ok(!JSON.stringify(result).includes(env.COLLECTOR_SERVICE_TOKEN));
 const malformed=await f.tick({transport:async()=>new Response('private provider body')});assert.equal(malformed.error,'Invalid collector response.');
});
test('a lease that expires during an outage does not block the following hour',async()=>{
 const f=fixture();await f.tick();
 f.advance(60*60000);const next=await f.tick();
 assert.equal(next.status,'running');assert.equal(f.runIds.length,2);
 assert.notEqual(f.runIds[0],f.runIds[1]);
});
