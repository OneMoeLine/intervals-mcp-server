import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, IntervalsClient, retryDelayMs } from "../src/api.js";
import { startFakeServer, type FakeServer } from "./helpers/fake-server.js";

let fake: FakeServer;

/** Every client here is pointed at the local fake server, and the backoff is
 *  collapsed to zero so the retry tests do not sit through real sleeps. */
const clientFor = (
  server: { baseUrl: string },
  options: Record<string, unknown> = {}
) =>
  new IntervalsClient("test-key", "i1", {
    baseUrl: server.baseUrl,
    retryDelay: () => 0,
    ...options,
  });

beforeEach(async () => {
  fake = await startFakeServer();
});

afterEach(async () => {
  await fake.close();
});

describe("defaults", () => {
  it("points at the live API when no base URL is given", () => {
    expect(DEFAULT_BASE_URL).toBe("https://intervals.icu/api/v1");
  });
});

describe("request shape", () => {
  it("sends HTTP Basic auth built from the API key", async () => {
    fake.replyWith({ body: { ok: true } });
    await clientFor(fake).get("/athlete/i1");

    const expected =
      "Basic " + Buffer.from("API_KEY:test-key").toString("base64");
    expect(fake.requests[0].headers.authorization).toBe(expected);
  });

  it("builds the path and query string", async () => {
    fake.replyWith({ body: [] });
    await clientFor(fake).get("/athlete/i1/activities", {
      oldest: "2024-06-01",
      newest: "2024-06-30",
      limit: "10",
    });

    const req = fake.requests[0];
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/athlete/i1/activities");
    expect(req.query).toEqual({
      oldest: "2024-06-01",
      newest: "2024-06-30",
      limit: "10",
    });
    expect(req.body).toBe("");
  });

  it("escapes query values that need it", async () => {
    fake.replyWith({ body: [] });
    await clientFor(fake).get("/search", { q: "long ride & hills", n: "100%" });

    expect(fake.requests[0].query).toEqual({
      q: "long ride & hills",
      n: "100%",
    });
  });

  it("omits the query string entirely when there are no params", async () => {
    fake.replyWith({ body: {} });
    await clientFor(fake).get("/athlete/i1");
    expect(fake.requests[0].query).toEqual({});
  });

  it("sends a JSON body on PUT and POST", async () => {
    fake.replyWith({ body: { id: 1 } });
    const client = clientFor(fake);
    await client.put("/athlete/i1/wellness/2024-06-01", { restingHR: 48 });
    await client.post("/athlete/i1/events", { name: "Race" });

    expect(fake.requests[0].method).toBe("PUT");
    expect(JSON.parse(fake.requests[0].body)).toEqual({ restingHR: 48 });
    expect(fake.requests[1].method).toBe("POST");
    expect(JSON.parse(fake.requests[1].body)).toEqual({ name: "Race" });
    expect(fake.requests[0].headers["content-type"]).toBe("application/json");
  });

  it("honours a base URL carrying a path prefix", async () => {
    fake.replyWith({ body: {} });
    await new IntervalsClient("k", "i1", {
      baseUrl: `${fake.baseUrl}/api/v1`,
    }).get("/athlete/i1");
    expect(fake.requests[0].path).toBe("/api/v1/athlete/i1");
  });
});

describe("response parsing", () => {
  it("parses a JSON body by content-type", async () => {
    fake.replyWith({
      body: { id: "a1", watts: [1, 2, 3] },
      headers: { "content-type": "application/json" },
    });
    expect(await clientFor(fake).get("/activity/a1")).toEqual({
      id: "a1",
      watts: [1, 2, 3],
    });
  });

  it("parses JSON when the content-type carries a charset", async () => {
    fake.replyWith({
      body: { id: "a1" },
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    expect(await clientFor(fake).get("/activity/a1")).toEqual({ id: "a1" });
  });

  it("falls back to text for any other content-type", async () => {
    fake.replyWith({
      body: "time,watts\n0,200\n",
      headers: { "content-type": "text/csv" },
    });
    expect(await clientFor(fake).get("/activity/a1")).toBe("time,watts\n0,200\n");
  });

  it("falls back to text when there is no content-type at all", async () => {
    // The fake sets JSON by default, so blank it explicitly.
    fake.replyWith({ body: "plain", headers: { "content-type": "" } });
    expect(await clientFor(fake).get("/x")).toBe("plain");
  });
});

describe("retries", () => {
  it("retries a 429 and then succeeds", async () => {
    fake.replyWith(
      { status: 429, body: "slow down" },
      { body: { ok: true } }
    );
    expect(await clientFor(fake).get("/x")).toEqual({ ok: true });
    expect(fake.requests).toHaveLength(2);
  });

  it("retries each retryable 5xx status and then succeeds", async () => {
    for (const status of [500, 502, 503, 504]) {
      await fake.close();
      fake = await startFakeServer();
      fake.replyWith({ status, body: "upstream" }, { body: { ok: status } });
      expect(await clientFor(fake).get("/x")).toEqual({ ok: status });
      expect(fake.requests).toHaveLength(2);
    }
  });

  it("recovers after several consecutive failures", async () => {
    fake.replyWith(
      { status: 503, body: "a" },
      { status: 503, body: "b" },
      { status: 503, body: "c" },
      { body: { ok: true } }
    );
    expect(await clientFor(fake).get("/x")).toEqual({ ok: true });
    expect(fake.requests).toHaveLength(4);
  });

  it("gives up after four attempts (the initial one plus three retries)", async () => {
    fake.replyWith({ status: 500, body: "boom" });
    await expect(clientFor(fake).get("/x")).rejects.toThrow(
      /Intervals\.icu API error 500: boom/
    );
    expect(fake.requests).toHaveLength(4);
  });

  it("does not retry a 404", async () => {
    fake.replyWith({ status: 404, body: "no such activity" });
    await expect(clientFor(fake).get("/activity/nope")).rejects.toThrow(
      /Intervals\.icu API error 404: no such activity/
    );
    expect(fake.requests).toHaveLength(1);
  });

  it("does not retry a 422", async () => {
    fake.replyWith({ status: 422, body: "bad parameter" });
    await expect(clientFor(fake).get("/x")).rejects.toThrow(
      /Intervals\.icu API error 422: bad parameter/
    );
    expect(fake.requests).toHaveLength(1);
  });

  it("does not retry a 401 or a 403", async () => {
    fake.replyWith({ status: 401, body: "unauthorized" });
    await expect(clientFor(fake).get("/x")).rejects.toThrow(/401/);
    expect(fake.requests).toHaveLength(1);

    await fake.close();
    fake = await startFakeServer();
    fake.replyWith({ status: 403, body: "forbidden" });
    await expect(clientFor(fake).get("/x")).rejects.toThrow(/403/);
    expect(fake.requests).toHaveLength(1);
  });

  it("retries a transport failure and reports it", async () => {
    // A port that was listening and is now closed: connections are refused.
    const dead = await startFakeServer();
    const url = dead.baseUrl;
    await dead.close();

    await expect(clientFor({ baseUrl: url }).get("/x")).rejects.toThrow(
      /failed after 4 attempts - network error/
    );
  });
});

describe("retry delay", () => {
  it("passes the failing response to the backoff on each retry", async () => {
    const seen: Array<{ attempt: number; retryAfter: string | null }> = [];
    fake.replyWith(
      { status: 429, body: "x", headers: { "retry-after": "2" } },
      { body: { ok: true } }
    );
    await clientFor(fake, {
      retryDelay: (res: Response | undefined, attempt: number) => {
        seen.push({ attempt, retryAfter: res?.headers.get("retry-after") ?? null });
        return 0;
      },
    }).get("/x");

    expect(seen).toEqual([{ attempt: 0, retryAfter: "2" }]);
  });

  it("honours Retry-After in seconds", () => {
    const res = new Response("", { headers: { "retry-after": "2" } });
    expect(retryDelayMs(res, 0)).toBe(2_000);
    expect(retryDelayMs(res, 3)).toBe(2_000); // header wins over the attempt
  });

  it("caps Retry-After at ten seconds", () => {
    const res = new Response("", { headers: { "retry-after": "900" } });
    expect(retryDelayMs(res, 0)).toBe(10_000);
  });

  it("accepts a zero-second Retry-After", () => {
    const res = new Response("", { headers: { "retry-after": "0" } });
    expect(retryDelayMs(res, 2)).toBe(0);
  });

  it("ignores an unparseable or negative Retry-After", () => {
    const http = new Response("", {
      headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
    });
    expect(retryDelayMs(http, 0)).toBe(500);
    const negative = new Response("", { headers: { "retry-after": "-5" } });
    expect(retryDelayMs(negative, 0)).toBe(500);
  });

  it("backs off exponentially and caps at four seconds", () => {
    expect(retryDelayMs(undefined, 0)).toBe(500);
    expect(retryDelayMs(undefined, 1)).toBe(1_000);
    expect(retryDelayMs(undefined, 2)).toBe(2_000);
    expect(retryDelayMs(undefined, 3)).toBe(4_000);
    expect(retryDelayMs(undefined, 9)).toBe(4_000);
  });
});

describe("timeouts", () => {
  it("aborts an attempt that never responds and reports the timeout", async () => {
    fake.replyWith({ hang: true });
    await expect(
      clientFor(fake, { timeoutMs: 80 }).get("/x")
    ).rejects.toThrow(/failed after 4 attempts - request timed out after 80ms/);
    expect(fake.requests).toHaveLength(4);
  });

  it("succeeds when a slow response still beats the timeout", async () => {
    let n = 0;
    fake.replyUsing(() => (n++ === 0 ? { hang: true } : { body: { ok: true } }));
    expect(await clientFor(fake, { timeoutMs: 120 }).get("/x")).toEqual({
      ok: true,
    });
  });
});

describe("error bodies", () => {
  it("truncates a long body to 500 characters and says how long it was", async () => {
    const long = "E".repeat(2_000);
    fake.replyWith({ status: 404, body: long });

    await expect(clientFor(fake).get("/x")).rejects.toThrow(
      /E{500}\.\.\. \(2000 chars total\)/
    );
  });

  it("keeps a short body whole", async () => {
    fake.replyWith({ status: 404, body: "not found" });
    await expect(clientFor(fake).get("/x")).rejects.toThrow(
      /API error 404: not found$/
    );
  });

  it("collapses the whitespace of an HTML error page", async () => {
    fake.replyWith({
      status: 500,
      body: "<html>\n  <body>\n    Gateway   problem\n  </body>\n</html>",
      headers: { "content-type": "text/html" },
    });
    await expect(clientFor(fake).get("/x")).rejects.toThrow(
      /<html> <body> Gateway problem <\/body> <\/html>/
    );
  });
});
