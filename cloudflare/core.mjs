const hour = 3600000;
/** One durable cursor per hourly sweep. No profiles or scraping payloads are stored here. */
export async function advanceClock(state, save, env, { transport = fetch, now = Date.now, uuid = () => crypto.randomUUID(), maxPairs = 40, tickMs = 105000 } = {}) {
  const base = new URL(env.COLLECTOR_URL);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password || !env.COLLECTOR_SERVICE_TOKEN) throw Error('Configure private collector access.');
  // Align sweeps to the hour in India (minute 30 UTC). Cron ticks only resume work.
  const offset = 30 * 60000;
  const bucket = Math.floor((now() - offset) / hour);
  const bucketStart = bucket * hour + offset;
  const tickDeadline = now() + tickMs;
  let requests = 0;
  async function call(payload, deadline = tickDeadline) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (requests >= 48 || now() >= deadline) throw Error('Tick budget reached; will resume.');
      requests++;
      let response;
      try {
        response = await transport(new URL('/api/run', base), { method: 'POST', redirect: 'manual',
          headers: { 'Content-Type': 'application/json', 'OAI-Sites-Authorization': 'Bearer ' + env.COLLECTOR_SERVICE_TOKEN },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(Math.max(1, deadline - now())) });
      } catch { if (attempt === 2) throw Error('Collector network request failed.'); continue; }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        if (attempt === 2) throw Error('Collector temporarily unavailable.');
        // Resume on the next scheduled tick instead of issuing an unbounded retry storm.
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw Error('Collector rejected request: HTTP ' + response.status); }
      let data;
      try { data = await response.json(); } catch { throw Error('Invalid collector response.'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid collector response.');
      return data;
    }
  }
  function persist() { save(state); }
  async function finish() {
    const result = await call({ action: 'finish', runId: state.runId });
    if (!['complete', 'partial'].includes(result.status) || !['successful', 'failed', 'unfinished', 'expected'].every(k => Number.isInteger(result[k]) && result[k] >= 0)
        || result.successful + result.failed + result.unfinished !== result.expected) throw Error('Invalid sweep summary.');
    state = { bucket: state.bucket, stage: 'finished', summary: result, finishedAt: now() }; persist();
    return result;
  }
  try {
    if ((state?.stage === 'running' || state?.stage === 'starting') && now() >= state.leaseUntil) {
      state = { bucket: state.bucket, stage: 'finished', summary: { status: 'expired' }, finishedAt: now() };
      persist();
    }
    if (state?.stage === 'running' && (state.cursor >= state.sourceIds.length || now() >= state.deadline)) return await finish();
    if (state?.stage === 'finished' && state.bucket >= bucket) return { status: 'idle', summary: state.summary };
    if (!state || state.stage === 'finished' || state.stage === 'starting' && state.bucket < bucket) {
      if (now() - bucketStart > 10 * 60000) return { status: 'waiting_for_next_hour' };
      state = { bucket, stage: 'starting', runId: uuid(), leaseUntil: now() + 55 * 60000,
        deadline: Math.min(now() + 50 * 60000, bucketStart + hour - 120000) }; persist();
    }
    if (state.stage === 'starting') {
      const started = await call({ action: 'begin', runId: state.runId, origin: 'scheduled' });
      if (started.status === 'busy') return { status: 'busy' };
      if (started.finished) { state = { bucket, stage: 'finished', summary: { status: 'already_finished' } }; persist(); return { status: 'already_finished' }; }
      if (started.runId !== state.runId || !Array.isArray(started.sourceIds) || started.sourceIds.length > 3000
          || started.sourceIds.some(id => typeof id !== 'string' || !/^[a-z0-9_-]{1,100}$/.test(id))
          || new Set(started.sourceIds).size !== started.sourceIds.length) throw Error('Invalid collector assignment.');
      state = { ...state, stage: 'running', sourceIds: started.sourceIds, cursor: 0, leaseUntil: Number.isFinite(started.deadline) ? started.deadline : state.leaseUntil,
        deadline: Math.min(state.deadline, Number.isFinite(started.deadline) ? started.deadline - 120000 : Infinity) }; persist();
    }
    let pairs = 0;
    while (state.cursor < state.sourceIds.length && pairs < maxPairs && now() < Math.min(tickDeadline, state.deadline) && requests <= 43) {
      const length = Math.min(8, state.sourceIds.length - state.cursor, (maxPairs - pairs) * 2);
      const ids = state.sourceIds.slice(state.cursor, state.cursor + length);
      const results = await Promise.allSettled(Array.from({ length: Math.ceil(ids.length / 2) }, (_, i) =>
        call({ action: 'collect', runId: state.runId, sourceIds: ids.slice(i * 2, i * 2 + 2) }, Math.min(tickDeadline, state.deadline))));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      state.cursor += ids.length; pairs += results.length; state.lastError = null; persist();
    }
    if (state.cursor === state.sourceIds.length || now() >= state.deadline) return await finish();
    return { status: 'running', processed: state.cursor, expected: state.sourceIds.length };
  } catch (error) {
    if (state) { state.lastError = error instanceof Error ? error.message : 'Clock request failed.'; persist(); }
    // Safe, bounded messages only. No upstream body, URL or secret is returned.
    return { status: 'deferred', processed: state?.cursor ?? 0, error: state?.lastError ?? 'Clock request failed.' };
  }
}
