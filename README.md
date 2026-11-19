# Job collector clock

This public repository contains only a generic hourly coordinator and tests. Private employer retrieval runs in a separate authenticated Site and writes validated results to Interview Studio. No profiles, application records, Site source, or credentials belong here.

GitHub Secrets: `COLLECTOR_URL` is the private collector origin; `COLLECTOR_SERVICE_TOKEN` is its service credential. The workflow runs hourly at minute 42 UTC and supports manual dispatch. Standard public-repository runners are used. GitHub schedules can be delayed; the private dashboard is the source of truth for completed coverage.

Four employer pairs run in parallel, with at most eight feeds in flight. Each run has a 50-minute collection budget including retries and a separate bounded finalization budget and reports successful, failed and unfinished feeds. Overlapping runs are serialized. Partial retrieval keeps existing openings and only completed source snapshots close missing jobs. Public logs show aggregate counts only.

Run `npm test` to verify credential confinement, redirects and finalization.

## What I did
Added a small hourly HTTP coordinator with bounded retries and finalization.

## Why this approach
A private Site can handle short retrieval requests while the independent runner provides the unattended clock.

## Why not the alternative
An open browser tab or ChatGPT reminder is not a reliable backend scheduler.

## What was the issue / root cause
The collector Site had no autonomous hourly trigger.

## Why this works best
It separates public timing code from private data and keeps completion evidence in the application.

## Other valid patterns
A hosted cron service or dedicated worker can offer stronger scheduling guarantees at a hosting cost.

## Prepared Render alternative

render.yaml can run the same coordinator using a Render cron service. It is not activated by this repository alone. The smallest cron plan is paid ($0.00016 per active minute with a $1 monthly minimum, checked 19 November 2026). At 25–50 minutes per hourly run, estimated 30-day compute is $2.88–$5.76 before any additional charges. A paid service must be explicitly approved before creation. Credentials are configured as private runtime secrets, never in this file. Set COLLECTOR_TRIGGER=schedule for unattended run history.
