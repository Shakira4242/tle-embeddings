/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Env {
  SPACE_TRACK_USER: string;
  SPACE_TRACK_PASSWORD: string;
  AUTH_KV: KVNamespace;
  TLE_BUCKET: R2Bucket;
  METRICS_KV: KVNamespace;
}

const COOKIE_KEY = "space-track-cookie";
const COOKIE_EXPIRY_BUFFER_MS = 15 * 60 * 1000; // refresh 15 minutes before expiry
const RATE_LIMIT_PER_MINUTE = 30;
const REQUEST_INTERVAL_MS = Math.ceil(60_000 / RATE_LIMIT_PER_MINUTE);
const YEAR_RANGE_START = 2000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/sync") {
      const years = collectYearRanges(url.searchParams.get("from"));
      const result = await syncYears(years, env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const years = collectYearRanges();
    ctx.waitUntil(syncYears(years, env).catch((err) => console.error(err)));
  },
};

function collectYearRanges(from?: string | null): Array<{ start: string; end: string; label: string }> {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const startYear = Math.min(Number(from ?? YEAR_RANGE_START), currentYear);
  const ranges: Array<{ start: string; end: string; label: string }> = [];

  for (let year = startYear; year <= currentYear; year += 1) {
    const start = `${year}-01-01`;
    const end = `${year + 1}-01-01`;
    ranges.push({ start, end, label: String(year) });
  }

  return ranges;
}

async function syncYears(ranges: Array<{ start: string; end: string; label: string }>, env: Env) {
  const limiter = new RateLimiter(REQUEST_INTERVAL_MS);
  const cookie = await getAuthCookie(env);
  const summary: Record<string, { stored: boolean; bytes?: number; error?: string }> = {};

  await Promise.all(
    ranges.map(async (range) => {
      const key = `tle/${range.label}.tle`;
      try {
        const response = await fetchWithAuth(
          `https://www.space-track.org/basicspacedata/query/class/gp_history/EPOCH/>${range.start}/EPOCH/<${range.end}/orderby/EPOCH/format/tle`,
          cookie,
          limiter,
        );

        if (!response.ok || !response.body) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const putResult = await env.TLE_BUCKET.put(key, response.body, {
          customMetadata: {
            rangeStart: range.start,
            rangeEnd: range.end,
            fetchedAt: new Date().toISOString(),
          },
        });

        summary[range.label] = { stored: true, bytes: putResult.size }; // size may be undefined if unknown
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary[range.label] = { stored: false, error: message };
      }
    }),
  );

  await env.METRICS_KV.put(
    "last-sync",
    JSON.stringify({
      timestamp: Date.now(),
      ranges: summary,
    }),
  );

  return summary;
}

async function fetchWithAuth(url: string, cookie: string, limiter: RateLimiter): Promise<Response> {
  await limiter.wait();
  return fetch(url, {
    headers: {
      cookie,
    },
  });
}

async function getAuthCookie(env: Env): Promise<string> {
  const cached = await env.AUTH_KV.get<{ cookie: string; expiresAt: number }>(COOKIE_KEY, {
    type: "json",
  });

  if (cached && cached.cookie && cached.expiresAt > Date.now() + COOKIE_EXPIRY_BUFFER_MS) {
    return cached.cookie;
  }

  const fresh = await login(env);
  await env.AUTH_KV.put(COOKIE_KEY, JSON.stringify(fresh), {
    expiration: Math.floor(fresh.expiresAt / 1000),
  });

  return fresh.cookie;
}

async function login(env: Env): Promise<{ cookie: string; expiresAt: number }> {
  const body = new URLSearchParams();
  body.set("identity", env.SPACE_TRACK_USER);
  body.set("password", env.SPACE_TRACK_PASSWORD);

  const response = await fetch("https://www.space-track.org/ajaxauth/login", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
  });

  if (!response.ok) {
    throw new Error(`Authentication failed with status ${response.status}`);
  }

  const cookieHeader = collectCookies(response.headers);
  if (!cookieHeader) {
    throw new Error("Space-Track login did not return a cookie");
  }

  const expiresAt = Date.now() + 2 * 60 * 60 * 1000; // session cookie is valid for ~2 hours
  return { cookie: cookieHeader, expiresAt };
}

function collectCookies(headers: Headers): string | null {
  const cfHeaders = headers as unknown as {
    getAll?: (name: string) => string[];
    getSetCookie?: () => string[];
  };

  const candidates = new Set<string>();

  const multi = cfHeaders.getSetCookie?.() ?? cfHeaders.getAll?.("set-cookie") ?? [];
  for (const value of multi) {
    const token = value?.split(";", 1)[0];
    if (token) {
      candidates.add(token);
    }
  }

  const single = headers.get("set-cookie");
  if (single) {
    const token = single.split(";", 1)[0];
    candidates.add(token);
  }

  if (candidates.size === 0) {
    return null;
  }

  return Array.from(candidates).join("; ");
}

class RateLimiter {
  private nextAvailable = Date.now();

  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly intervalMs: number) {}

  async wait(): Promise<void> {
    const previous = this.queue;
    let release: () => void;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    release!();

    const now = Date.now();
    const scheduled = Math.max(this.nextAvailable, now);
    const delay = scheduled - now;
    this.nextAvailable = scheduled + this.intervalMs;

    if (delay > 0) {
      await sleep(delay);
    }
  }
}

function sleep(duration: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, duration));
}
