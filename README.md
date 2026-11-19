# Job collector clock

This public repository contains only a generic hourly coordinator and tests. Private employer retrieval runs in a separate authenticated Site and writes validated results to Interview Studio. No profiles, application records, Site source, or credentials belong here.

Cloudflare runs the timer. One sweep starts at the top of each hour in India (minute 30 UTC). A two-minute Cron Trigger resumes the sweep through a SQLite-backed Durable Object and three collection lanes. Keep `COLLECTOR_URL` in the Worker configuration and `COLLECTOR_SERVICE_TOKEN` in Worker Secrets. The Worker needs no public route. The private dashboard shows completed coverage.

Three independent lanes run up to six employer pairs each. Each scheduled run targets a 14-minute collection window before finalization and reports successful, failed, and unfinished feeds. Overlapping runs are serialized. Partial retrieval keeps existing openings and only completed source snapshots close missing jobs. Public logs show aggregate counts only.

Run `npm test` to verify credential confinement, retries, expiry recovery and a simulated 1,532-feed sweep. Cloudflare deployment configuration is in `cloudflare/wrangler.jsonc`. It allows one 105-second tick at a time, with at most 48 outbound requests per invocation per lane. Each lane dispatches up to 44 employer pairs per tick and retains assignments until the private collector acknowledges terminal counts. The remaining minute after the collection window is reserved for finalization.

## What I did
Deployed a scheduled Cloudflare Worker with a SQLite queue and parallel collection lanes, and kept the generic Node runner for alternate hosts.

## Why this approach
A private Site can handle short retrieval requests while the independent runner provides the unattended clock.

## Why not the alternative
GitHub Actions rejected the runner before job startup because of an account billing lock. Cloudflare handles the schedule independently.

## What was the issue / root cause
The collector Site needed an external timer. A single Workers cron invocation has a 15-minute wall-time limit, so the bounded ticks persist progress across invocations. The single cursor also throttled throughput because slow requests held up the next batch. Independent lanes and a small queue of concurrent requests keep work moving while retaining one sweep lease.

## Why this works best
The coordinator stores only run state. Interview Studio owns job snapshots, profile matching and sweep outcomes. An interrupted or failed source preserves previous results.

## Other valid patterns
The GitHub workflow and Render template can run the Node coordinator if either host is selected in the future. Enable only one scheduler at a time.

## Prepared Render alternative

render.yaml can run the same coordinator using a Render cron service. It is not activated by this repository alone. The smallest cron plan is paid ($0.00016 per active minute with a $1 monthly minimum, checked 19 November 2026). At 25–50 minutes per hourly run, estimated 30-day compute is $2.88–$5.76 before any additional charges. A paid service must be explicitly approved before creation. Credentials are configured as private runtime secrets, never in this file. Set COLLECTOR_TRIGGER=schedule for unattended run history.
