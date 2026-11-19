const minute = 60_000;
const hour = 60 * minute;
const sweepWindow = 14 * minute;
const lanes = 3;
const maxPairs = 44;

function collectorClient(env, transport, now) {
  const base = new URL(env.COLLECTOR_URL);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash
      || base.username || base.password || !env.COLLECTOR_SERVICE_TOKEN) throw Error('Configure private collector access.');
  let requests = 0;
  return async (payload, deadline) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (requests >= 48 || now() >= deadline) throw Error('Tick budget reached; will resume.');
      requests++;
      let response;
      try {
        response = await transport(new URL('/api/run', base), {
          method: 'POST', redirect: 'manual',
          headers: { 'Content-Type': 'application/json', 'OAI-Sites-Authorization': 'Bearer ' + env.COLLECTOR_SERVICE_TOKEN },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(Math.max(1, deadline - now())),
        });
      } catch {
        if (attempt === 1) throw Error('Collector network request failed.');
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status >= 500 && attempt === 0) continue;
        throw Error('Collector rejected request: HTTP ' + response.status);
      }
      let data;
      try { data = await response.json(); } catch { throw Error('Invalid collector response.'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid collector response.');
      return data;
    }
  };
}

export async function collectLane(runId, ids, deadline, env, { transport = fetch, now = Date.now } = {}) {
  const call = collectorClient(env, transport, now);
  const pairs = Array.from({ length: Math.ceil(ids.length / 2) }, (_, index) => ids.slice(index * 2, index * 2 + 2));
  const settled = new Set();
  let next = 0;
  async function consume() {
    while (next < pairs.length && now() + 1000 < deadline) {
      const sourceIds = pairs[next++];
      try {
        const result = await call({ action: 'collect', runId, sourceIds }, deadline);
        if (result.expected === sourceIds.length && result.unfinished === 0
            && Number.isInteger(result.successful) && Number.isInteger(result.failed)
            && result.successful >= 0 && result.failed >= 0 && result.successful + result.failed === sourceIds.length) {
          sourceIds.forEach(id => settled.add(id));
        }
      } catch { /* An unacknowledged assignment stays queued. */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, pairs.length) }, consume));
  return [...settled];
}

function splitLanes(ids) {
  const partitions = Array.from({ length: lanes }, () => []);
  ids.forEach((id, index) => partitions[index % lanes].push(id));
  return partitions;
}

export async function advanceClock(state, save, env, options = {}) {
  const { transport = fetch, now = Date.now, uuid = () => crypto.randomUUID(),
    dispatch = (_index, runId, ids, deadline) => collectLane(runId, ids, deadline, env, { transport, now }) } = options;
  const call = collectorClient(env, transport, now);
  const offset = 30 * minute;
  const bucket = Math.floor((now() - offset) / hour);
  const bucketStart = bucket * hour + offset;
  const tickDeadline = now() + 105_000;
  const persist = () => save(state);

  async function finish() {
    const result = await call({ action: 'finish', runId: state.runId }, tickDeadline);
    if (!['complete', 'partial'].includes(result.status)
        || !['successful', 'failed', 'unfinished', 'expected'].every(key => Number.isInteger(result[key]) && result[key] >= 0)
        || result.successful + result.failed + result.unfinished !== result.expected) throw Error('Invalid sweep summary.');
    state = { bucket: state.bucket, stage: 'finished', summary: result, finishedAt: now() };
    persist();
    return result;
  }

  try {
    if (state && state.stage !== 'finished' && now() >= state.leaseUntil) {
      state = { bucket: state.bucket, stage: 'finished', summary: { status: 'expired' }, finishedAt: now() };
      persist();
    }
    if (state?.stage === 'finished' && state.bucket >= bucket) return { status: 'idle', summary: state.summary };
    if (!state || state.stage === 'finished' || state.stage === 'starting' && state.bucket < bucket) {
      if (now() - bucketStart > 4 * minute) return { status: 'waiting_for_next_hour' };
      state = { bucket, stage: 'starting', runId: uuid(), leaseUntil: now() + 55 * minute, deadline: bucketStart + sweepWindow };
      persist();
    }
    if (state.stage === 'starting') {
      const started = await call({ action: 'begin', runId: state.runId, origin: 'scheduled' }, tickDeadline);
      if (started.status === 'busy') return { status: 'busy' };
      if (started.finished) {
        state = { bucket, stage: 'finished', summary: { status: 'already_finished' }, finishedAt: now() };
        persist();
        return { status: 'already_finished' };
      }
      if (started.runId !== state.runId || !Array.isArray(started.sourceIds) || started.sourceIds.length > 3000
          || started.sourceIds.some(id => typeof id !== 'string' || !/^[a-z0-9_-]{1,100}$/.test(id))
          || new Set(started.sourceIds).size !== started.sourceIds.length) throw Error('Invalid collector assignment.');
      state = { ...state, stage: 'running', pending: splitLanes(started.sourceIds), expected: started.sourceIds.length,
        leaseUntil: Number.isFinite(started.deadline) ? started.deadline : state.leaseUntil };
      persist();
    }
    // A deployment during an older sweep can resume at its saved cursor.
    if (!state.pending) {
      const { sourceIds, cursor, ...rest } = state;
      state = { ...rest, expected: sourceIds.length, pending: splitLanes(sourceIds.slice(cursor)) };
      persist();
    }
    if (now() < state.deadline && state.pending.some(ids => ids.length)) {
      const deadline = Math.min(tickDeadline - 5000, state.deadline);
      const result = await Promise.allSettled(state.pending.map(async (ids, index) => {
        const assigned = ids.slice(0, maxPairs * 2);
        if (!assigned.length) return ids;
        const confirmed = await dispatch(index, state.runId, assigned, deadline);
        if (!Array.isArray(confirmed)) throw Error('Invalid lane result.');
        const completed = new Set(confirmed);
        return assigned.filter(id => !completed.has(id)).concat(ids.slice(assigned.length));
      }));
      state.pending = state.pending.map((ids, index) => result[index].status === 'fulfilled' ? result[index].value : ids);
      persist();
    }
    const remaining = state.pending.reduce((count, ids) => count + ids.length, 0);
    if (!remaining || now() >= state.deadline) return await finish();
    return { status: 'running', processed: state.expected - remaining, expected: state.expected };
  } catch (error) {
    return { status: 'deferred', error: error instanceof Error ? error.message : 'Clock request failed.' };
  }
}
