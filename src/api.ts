const BASE_URL = "https://intervals.icu/api/v1";

/** Abort a single HTTP attempt after this long, so a hung connection cannot
 *  hang a tool call indefinitely. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Retries *after* the initial attempt. */
const MAX_RETRIES = 3;

/** Upper bound on an upstream error body echoed back to the caller, so an
 *  HTML error page is not dumped verbatim into a tool result. */
const MAX_ERROR_BODY = 500;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function truncate(text: string, limit = MAX_ERROR_BODY): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit
    ? `${collapsed.slice(0, limit)}... (${collapsed.length} chars total)`
    : collapsed;
}

/** Honour Retry-After when the server sends it, else exponential backoff. */
function retryDelayMs(res: Response | undefined, attempt: number): number {
  const header = res?.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 10_000);
    }
  }
  return Math.min(500 * 2 ** attempt, 4_000);
}

export class IntervalsClient {
  private authHeader: string;
  public athleteId: string;

  constructor(apiKey: string, athleteId: string) {
    this.authHeader =
      "Basic " + Buffer.from(`API_KEY:${apiKey}`).toString("base64");
    this.athleteId = athleteId;
  }

  async request<T>(
    method: string,
    path: string,
    params?: Record<string, string>,
    body?: unknown
  ): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
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
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        // Timeouts and transport failures are both worth another attempt.
        const name = err instanceof Error ? err.name : "";
        lastError =
          name === "TimeoutError" || name === "AbortError"
            ? `request timed out after ${REQUEST_TIMEOUT_MS}ms`
            : `network error: ${err instanceof Error ? err.message : String(err)}`;
        if (attempt === MAX_RETRIES) break;
        await sleep(retryDelayMs(undefined, attempt));
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
      await sleep(retryDelayMs(res, attempt));
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
}
