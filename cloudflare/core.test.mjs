import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceClock, collectLane } from './core.mjs';

const env = { COLLECTOR_URL: 'https://collector.example.test', COLLECTOR_SERVICE_TOKEN: 'private-test' };

function fixture(total = 1532) {
  let state = null, time = 30 * 60_000, active = 0, peak = 0;
  const completed = new Set(), begins = [];
  const transport = async (url, init) => {
    assert.equal(url.origin, env.COLLECTOR_URL);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers['OAI-Sites-Authorization'], 'Bearer private-test');
    const body = JSON.parse(init.body);
    if (body.action === 'begin') {
      begins.push(body);
      return Response.json({ runId: body.runId, status: 'running',
        sourceIds: Array.from({ length: total }, (_, index) => 'greenhouse-' + index), deadline: time + 55 * 60_000 });
    }
    if (body.action === 'finish') return Response.json({ status: completed.size === total ? 'complete' : 'partial',
      expected: total, successful: completed.size, failed: 0, unfinished: total - completed.size });
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 0));
    body.sourceIds.forEach(id => completed.add(id));
    active--;
    return Response.json({ expected: body.sourceIds.length, successful: body.sourceIds.length, failed: 0, unfinished: 0 });
  };
  const now = () => time;
  function tick(options = {}) {
    return advanceClock(state, value => state = structuredClone(value), env, {
      transport, now,
      dispatch: (_i, runId, ids, deadline) => {
        let requests = 0;
        return collectLane(runId, ids, deadline, env, { now, transport: (url, init) => {
          assert.ok(++requests <= 48);
          return transport(url, init);
        } });
      }, ...options,
    });
  }
  return { tick, begins, transport, now, advance: ms => time += ms, get state() { return state; }, get peak() { return peak; } };
}

test('three independent lanes complete 1,532 assignments within six simulated ticks', async () => {
  const f = fixture(); let result;
  for (let index = 0; index < 6; index++) {
    result = await f.tick();
    f.advance(120_000);
  }
  assert.equal(result.status, 'complete');
  assert.equal(result.successful, 1532);
  assert.equal(f.state.finishedAt - 30 * 60_000, 10 * 60_000);
  assert.equal(f.peak, 18);
  assert.equal(f.begins.length, 1);
  assert.equal(f.begins[0].origin, 'scheduled');
  assert.equal((await f.tick()).status, 'idle');
  f.advance(48 * 60_000);
  await f.tick();
  assert.equal(f.begins.length, 2);
});

test('retryable assignments stay queued while other lanes make progress', async () => {
  const f = fixture(12);
  const result = await f.tick({ dispatch: (index, runId, ids, deadline) => {
    if (index === 0) throw new Error('Unavailable lane');
    return collectLane(runId, ids, deadline, env, { transport: f.transport, now: f.now });
  } });
  assert.equal(result.processed, 8);
  assert.deepEqual(f.state.pending.map(ids => ids.length), [4, 0, 0]);
  f.advance(120_000);
  assert.equal((await f.tick()).successful, 12);
});

test('an unfinished collector response is retried, and a deadline reports remaining feeds', async () => {
  const f = fixture(12);
  const result = await f.tick({ dispatch: (_index, runId, ids, deadline) => collectLane(runId, ids, deadline, env, {
    now: f.now, transport: () => Response.json({ expected: 2, successful: 1, failed: 0, unfinished: 1 }),
  }) });
  assert.equal(result.processed, 0);
  f.advance(14 * 60_000);
  const final = await f.tick();
  assert.equal(final.status, 'partial');
  assert.equal(final.unfinished, 12);
});

test('redirects and malformed responses never expose credentials or follow another origin', async () => {
  const f = fixture(); let count = 0;
  const result = await f.tick({ transport: async () => { count++; return new Response('', { status: 302 }); } });
  assert.equal(count, 1);
  assert.equal(result.status, 'deferred');
  assert.match(result.error, /302/);
  assert.ok(!JSON.stringify(result).includes(env.COLLECTOR_SERVICE_TOKEN));
  const malformed = await f.tick({ transport: async () => new Response('private provider body') });
  assert.equal(malformed.error, 'Invalid collector response.');
});

test('a lease that expires during an outage does not block the following hour', async () => {
  const f = fixture();
  await f.tick();
  f.advance(60 * 60_000);
  assert.equal((await f.tick()).status, 'running');
  assert.equal(f.begins.length, 2);
  assert.notEqual(f.begins[0].runId, f.begins[1].runId);
});
