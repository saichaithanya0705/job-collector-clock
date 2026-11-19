import { DurableObject } from 'cloudflare:workers';
import { advanceClock } from './core.mjs';

export class CollectorClock extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.busy = false;
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS clock_state(id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  }
  async tick() {
    if (this.busy) return { status: 'busy' };
    this.busy = true;
    try {
      const row = this.ctx.storage.sql.exec('SELECT body FROM clock_state WHERE id=1').toArray()[0];
      return await advanceClock(row ? JSON.parse(row.body) : null, state => {
        this.ctx.storage.sql.exec('INSERT INTO clock_state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', JSON.stringify(state));
      }, this.env);
    } finally { this.busy = false; }
  }
}
export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil((async () => {
      const result = await env.CLOCK.get(env.CLOCK.idFromName('hourly-collector')).tick();
      console.log(JSON.stringify(result));
    })());
  },
  fetch() { return new Response('Scheduled coordinator. No public control endpoint.', { status: 404 }); },
};
