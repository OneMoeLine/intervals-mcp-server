/** Default Intervals.icu API root. Overridable per-client so tests can point
 *  at a local fake server. */
export const DEFAULT_BASE_URL = "https://intervals.icu/api/v1";

/** Abort a single HTTP attempt after this long, so a hung connection cannot
 *  hang a tool call indefinitely. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Retries *after* the initial attempt. */
export const MAX_RETRIES = 3;

/** Upper bound on an upstream error body echoed back to the caller, so an
 *  HTML error page is not dumped verbatim into a tool result. */
export const MAX_ERROR_BODY = 500;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function truncate(text: string, limit = MAX_ERROR_BODY): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit
    ? `${collapsed.slice(0, limit)}... (${collapsed.length} chars total)`
    : collapsed;
}

/** Honour Retry-After when the server sends it, else exponential backoff. */
export function retryDelayMs(res: Response | undefined, attempt: number): number {
  const header = res?.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 10_000);
    }
  }
  return Math.min(500 * 2 ** attempt, 4_000);
}

/** Encode one caller-supplied path segment. Handlers validate IDs against
 *  their real format first; this is the backstop. `encodeURIComponent` alone
 *  leaves `.` and `..` as they are, and the URL parser would resolve those as
 *  dot segments - walking out of the intended endpoint - so they are refused
 *  outright. */
export function segment(value: string | number): string {
  const text = String(value);
  if (text === "" || text === "." || text === "..") {
    throw new Error(`Invalid path segment: ${JSON.stringify(text)}`);
  }
  return encodeURIComponent(text);
}

export interface IntervalsClientOptions {
  /** API root. Defaults to `INTERVALS_BASE_URL` if set, else the live
   *  Intervals.icu API. */
  baseUrl?: string;
  /** Per-attempt abort timeout. */
  timeoutMs?: number;
  /** Backoff schedule. Injectable so tests need not sit through real sleeps. */
  retryDelay?: (res: Response | undefined, attempt: number) => number;
}

export class IntervalsClient {
  private authHeader: string;
  private baseUrl: string;
  private timeoutMs: number;
  private retryDelay: (res: Response | undefined, attempt: number) => number;
  public athleteId: string;

  constructor(
    apiKey: string,
    athleteId: string,
    options: IntervalsClientOptions = {}
  ) {
    this.authHeader =
      "Basic " + btoa(`API_KEY:${apiKey}`);
    this.athleteId = athleteId;
    // Without a trailing slash, so `${baseUrl}${path}` never doubles one up.
    this.baseUrl = (
      options.baseUrl ?? process.env.INTERVALS_BASE_URL ?? DEFAULT_BASE_URL
    ).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.retryDelay = options.retryDelay ?? retryDelayMs;
  }

  async request<T>(
    method: string,
    path: string,
    params?: Record<string, string>,
    body?: unknown
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    // The URL parser resolves dot segments (encoded ones too) and splits off
    // `?` and `#`, any of which would swap the endpoint the handler meant for
    // another one under the same credential. Refuse, before the credential is
    // attached, any path that does not survive parsing unchanged.
    const root = new URL(this.baseUrl).pathname.replace(/\/$/, "");
    if (url.pathname !== `${root}${path}` || url.search || url.hash) {
      throw new Error(`Refusing request to an unexpected API path: ${path}`);
    }
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    let lastError = "unknown error";

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res: Response;
      try {
        res = await fetch(url.toString(), {
          method,
          headers: {
            Authorization: this.authHeader,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // Timeouts and transport failures are both worth another attempt.
        const name = err instanceof Error ? err.name : "";
        lastError =
          name === "TimeoutError" || name === "AbortError"
            ? `request timed out after ${this.timeoutMs}ms`
            : `network error: ${err instanceof Error ? err.message : String(err)}`;
        if (attempt === MAX_RETRIES) break;
        await sleep(this.retryDelay(undefined, attempt));
        continue;
      }

      if (res.ok) {
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          return (await res.json()) as T;
        }
        return (await res.text()) as unknown as T;
      }

      lastError = `${res.status}: ${truncate(await res.text())}`;

      if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_RETRIES) {
        throw new Error(`Intervals.icu API error ${lastError}`);
      }
      await sleep(this.retryDelay(res, attempt));
    }

    throw new Error(
      `Intervals.icu API request failed after ${MAX_RETRIES + 1} attempts - ${lastError}`
    );
  }

  get<T>(path: string, params?: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, undefined, body);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, undefined, body);
  }

  /** `delete` is a legal method name and keeps the verb honest at the call
   *  site. Query params rather than a body: the delete endpoints take their
   *  options in the URL. */
  delete<T>(path: string, params?: Record<string, string>): Promise<T> {
    return this.request<T>("DELETE", path, params);
  }
}
