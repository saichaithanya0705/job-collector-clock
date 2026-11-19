import test from 'node:test';
import assert from 'node:assert/strict';
import { runSweep } from './run.mjs';
test('the hourly coordinator confines credentials, traverses every pair, and finalizes the cycle', async () => {
 const calls=[];
 const result=await runSweep({origin:'https://collector.example.test',token:'private-test',event:'schedule',transport:async(url,init)=>{
  assert.equal(url.origin,'https://collector.example.test');assert.equal(init.redirect,'manual');assert.equal(init.headers['OAI-Sites-Authorization'],'Bearer private-test');
  const body=JSON.parse(init.body);calls.push(body);
  return Response.json(body.action==='begin'?{runId:body.runId,status:'running',sourceIds:['greenhouse-a','ashby-b','lever-c'],deadline:Date.now()+55*60000}
   :body.action==='finish'?{status:'complete',expected:3,successful:3,failed:0,unfinished:0}:{successful:body.sourceIds.length});
 }});
 assert.equal(result.successful,3);assert.equal(calls[0].origin,'scheduled');assert.deepEqual(calls.filter(c=>c.action==='collect').flatMap(c=>c.sourceIds),['greenhouse-a','ashby-b','lever-c']);
 assert.equal(calls.at(-1).action,'finish');
});
test('redirected requests never forward credentials to another destination',async()=>{
 let count=0;await assert.rejects(runSweep({origin:'https://collector.example.test',token:'private-test',transport:async()=>{count++;return new Response('',{status:302});}}),/HTTP 302/);assert.equal(count,1);
});

test('bounded parallel collection waits for all active pairs before finalizing a failure',async()=>{
 let active=0,peak=0,finished=false;
 await assert.rejects(runSweep({origin:'https://collector.example.test',token:'private-test',sleep:async()=>{},transport:async(url,init)=>{
  const body=JSON.parse(init.body);
  if(body.action==='begin')return Response.json({runId:body.runId,status:'running',sourceIds:Array.from({length:20},(_,i)=>'greenhouse-'+i)});
  if(body.action==='finish'){assert.equal(active,0);finished=true;return Response.json({status:'partial',expected:20,successful:6,failed:0,unfinished:14});}
  active++;peak=Math.max(peak,active);assert.ok(active<=4);
  await new Promise(resolve=>setTimeout(resolve,body.sourceIds[0]==='greenhouse-0'?1:15));active--;
  return body.sourceIds[0]==='greenhouse-0'?Response.json({}, {status:400}):Response.json({successful:2});
 }}),/HTTP 400/);
 assert.equal(peak,4);assert.equal(finished,true);
});
