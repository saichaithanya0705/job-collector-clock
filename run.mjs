import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function runSweep({ origin, token, event = 'manual', transport = fetch, sleep = pause, onProgress = () => {}, concurrency = 4 }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw Error('Collection concurrency must be between one and four employer pairs.');
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash || !token) throw Error('Configure the collector origin and its private service token.');
  const cycleDeadline = Date.now() + 50 * 60000;
  async function call(payload, timeout = 140000, deadline = cycleDeadline) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error('Collection time budget reached.');
      let response;
      try { response = await transport(new URL('/api/run', base), { method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/json', 'OAI-Sites-Authorization': 'Bearer ' + token },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(Math.min(timeout, remaining)) }); }
      catch { if (attempt === 2) throw Error('Collector could not be reached.'); await sleep(1000 * 2 ** attempt); continue; }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel(); if (attempt === 2) throw Error('Collector service is unavailable.'); await sleep(1000 * 2 ** attempt); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw Error('Collector rejected the request: HTTP ' + response.status); }
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid collector response.');
      return data;
    }
  }
  const runId = randomUUID(), run = await call({ action: 'begin', runId, origin: event === 'schedule' ? 'scheduled' : 'manual' });
  if (run.status === 'busy' || run.finished) return { status: run.status, alreadyRunning: run.status === 'busy' };
  let summary, failure;
  try {
    if (run.runId !== runId || !Array.isArray(run.sourceIds) || run.sourceIds.length > 3000
      || run.sourceIds.some(id => typeof id !== 'string' || !/^[a-z0-9_-]{1,100}$/.test(id))
      || new Set(run.sourceIds).size !== run.sourceIds.length) throw Error('Invalid collector assignment.');
    const deadline = Math.min(cycleDeadline, Number.isFinite(run.deadline) ? run.deadline - 2 * 60000 : Infinity);
    let cursor = 0, processed = 0, collectionFailure;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (!collectionFailure && cursor < run.sourceIds.length && Date.now() < deadline) {
        const ids = run.sourceIds.slice(cursor, cursor += 2);
        try {
          await call({ action: 'collect', runId, sourceIds: ids }, 140000, deadline);
          processed += ids.length;
          onProgress({ processed, expected: run.sourceIds.length });
        } catch (error) { collectionFailure = error; }
      }
    }));
    if (collectionFailure) throw collectionFailure;
  } catch (error) { failure = error; }
  finally { summary = await call({ action: 'finish', runId }, 90000, Date.now() + 4 * 60000); }
  if (failure) throw failure;
  if (!['complete', 'partial'].includes(summary.status) || !['successful', 'failed', 'unfinished', 'expected'].every(key => Number.isInteger(summary[key]) && summary[key] >= 0)
    || summary.successful + summary.failed + summary.unfinished !== summary.expected) throw Error('Invalid final sweep report.');
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const summary = await runSweep({ origin: process.env.COLLECTOR_URL, token: process.env.COLLECTOR_SERVICE_TOKEN, event: process.env.COLLECTOR_TRIGGER || process.env.GITHUB_EVENT_NAME,
      onProgress: ({processed, expected}) => { if (processed % 50 === 0 || processed === expected) console.log(JSON.stringify({processed, expected})); } });
    console.log(JSON.stringify(summary));
    if (summary.status === 'partial') console.log('::warning::Some employer feeds failed or were unfinished. Review the private collector dashboard.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
