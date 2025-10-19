# TLE Mirror Cloudflare Worker

This project contains a Cloudflare Worker that mirrors the public `gp_history` TLE catalog from [Space-Track](https://www.space-track.org/) into an R2 bucket while respecting Space-Track's 30-requests-per-minute throttle.

## Features

- Automatic authentication with Space-Track credentials stored as Worker secrets.
- Cookie reuse through KV storage with proactive refresh before expiration.
- Parallel year-based downloads throttled to at most 30 requests per minute.
- Streaming uploads to R2, storing each year as `tle/<year>.tle` with metadata.
- Scheduled daily sync via Cloudflare cron triggers and optional on-demand `/sync` endpoint.
- Metrics KV entry describing the most recent synchronization status.

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Configure bindings in `wrangler.toml` with your actual KV namespace and R2 bucket identifiers.

3. Add Space-Track credentials as secrets:

   ```bash
   npx wrangler secret put SPACE_TRACK_USER
   npx wrangler secret put SPACE_TRACK_PASSWORD
   ```

4. Deploy the Worker:

   ```bash
   npm run deploy
   ```

5. Trigger a manual synchronization (optional):

   ```bash
   curl -X POST https://<your-worker>/sync
   ```

The Worker will also run nightly according to the cron expression configured in `wrangler.toml`.
