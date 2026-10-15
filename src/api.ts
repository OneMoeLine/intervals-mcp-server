const BASE_URL = "https://intervals.icu/api/v1";

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

    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Intervals.icu API error ${res.status}: ${text}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return res.json() as Promise<T>;
    }
    return res.text() as unknown as T;
  }

  get<T>(
    path: string,
    params?: Record<string, string>
  ): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, undefined, body);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, undefined, body);
  }
}
