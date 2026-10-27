import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeServer, type FakeServer } from "./helpers/fake-server.js";

/** The hosted server end to end: the real Worker under `wrangler dev` (local
 *  workerd, local KV), driven through the OAuth flow the way claude.ai drives
 *  it, with Intervals.icu replaced by the fake server. Nothing leaves the
 *  machine. Slower than the rest of the suite - workerd takes a few seconds
 *  to start - so it starts once for every test here. */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INVITE = "test-invite-code";
const GOOD_KEY = "good-key";
const CLIENT_REDIRECT = "https://client.example/callback";

let fake: FakeServer;
let wrangler: ChildProcess;
let origin: string;
/** Local KV for this run only, so each run starts with no clients or grants. */
const state = mkdtempSync(join(tmpdir(), "intervals-worker-"));

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  fake = await startFakeServer();
  fake.replyUsing((req) => {
    const expected = "Basic " + btoa(`API_KEY:${GOOD_KEY}`);
    if (req.headers.authorization !== expected) {
      return { status: 401, body: { error: "unauthorized" } };
    }
    if (req.path === "/athlete/0" || req.path === "/athlete/i42") {
      return { body: { id: "i42", name: "Test Athlete", timezone: "Europe/London" } };
    }
    return { body: [] };
  });

  const port = await freePort();
  origin = `http://localhost:${port}`;
  wrangler = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
      "dev",
      "--port", String(port),
      "--ip", "127.0.0.1",
      "--var", `INVITE_CODE:${INVITE}`,
      "--var", `INTERVALS_BASE_URL:${fake.baseUrl}`,
      "--persist-to", state,
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: ROOT,
      // The Worker's fetches go to the fake server on loopback, never a proxy.
      env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let log = "";
  wrangler.stdout?.on("data", (c) => (log += c));
  wrangler.stderr?.on("data", (c) => (log += c));

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${origin}/`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline || wrangler.exitCode !== null) {
      throw new Error(`wrangler dev did not start:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}, 90_000);

afterAll(async () => {
  wrangler?.kill();
  await fake?.close();
  rmSync(state, { recursive: true, force: true });
});

// ── OAuth client side, as an MCP client does it ───────────────────────────────

async function registerClient(): Promise<string> {
  const res = await fetch(`${origin}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test client",
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

interface Started {
  clientId: string;
  url: string;
  cookie: string;
  handle: string;
  html: string;
  verifier: string;
}

async function startAuthorization(): Promise<Started> {
  const clientId = await registerClient();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    state: "state-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  });
  const url = `${origin}/authorize?${params}`;
  const res = await fetch(url);
  expect(res.status).toBe(200);
  const html = await res.text();
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
  return { clientId, url, cookie, handle, html, verifier };
}

function submit(started: Started, fields: Record<string, string>) {
  return fetch(started.url, {
    method: "POST",
    redirect: "manual",
    headers: {
      Cookie: started.cookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      handle: started.handle,
      invite: INVITE,
      api_key: GOOD_KEY,
      athlete_id: "",
      timezone: "America/Chicago",
      delete_mode: "safe",
      decision: "approve",
      ...fields,
    }),
  });
}

async function signIn(fields: Record<string, string> = {}): Promise<string> {
  const started = await startAuthorization();
  const res = await submit(started, fields);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(CLIENT_REDIRECT);
  expect(location.searchParams.get("state")).toBe("state-123");

  const token = await fetch(`${origin}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: location.searchParams.get("code")!,
      redirect_uri: CLIENT_REDIRECT,
      client_id: started.clientId,
      code_verifier: started.verifier,
      resource: `${origin}/mcp`,
    }),
  });
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

let rpcId = 1;
async function rpc(token: string, method: string, params: object = {}) {
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const body = await res.text();
  // A stateless reply may come as one SSE event rather than plain JSON.
  const json = body.startsWith("{")
    ? body
    : body
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5))
        .join("");
  return { status: res.status, body: JSON.parse(json) };
}

async function initialize(token: string) {
  return rpc(token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("hosted worker", () => {
  it("refuses /mcp without a token and points at its OAuth metadata", async () => {
    const res = await fetch(`${origin}/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(
      /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/
    );
  });

  it("refuses a made-up token", async () => {
    const { status } = await initialize("not-a-real-token");
    expect(status).toBe(401);
  });

  it("publishes authorization server metadata with registration", async () => {
    const res = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.authorization_endpoint).toBe(`${origin}/authorize`);
    expect(meta.registration_endpoint).toBe(`${origin}/register`);
  });

  it("renders the sign-in page with the client named and no framing", async () => {
    const started = await startAuthorization();
    expect(started.handle).not.toBe("");
    expect(started.html).toContain("Connect Test client to Intervals.icu");
    expect(started.html).toContain("client.example");
  });

  it("rejects a wrong invite code without contacting Intervals.icu", async () => {
    const before = fake.requests.length;
    const started = await startAuthorization();
    const res = await submit(started, { invite: "guess" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invite code is not valid");
    expect(fake.requests.length).toBe(before);
  });

  it("rejects a key Intervals.icu does not accept, and keeps the form usable", async () => {
    const started = await startAuthorization();
    const res = await submit(started, { api_key: "wrong-key" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("did not accept that API key");
    expect(html).not.toContain("wrong-key");

    // Same handle, corrected key: the page still completes.
    const retry = await submit(started, {});
    expect(retry.status).toBe(302);
  });

  it("sends the user back with access_denied on Cancel", async () => {
    const started = await startAuthorization();
    const res = await submit(started, { decision: "deny" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
  });

  it("serves the tools on the signed-in user's own account", async () => {
    const token = await signIn();
    expect((await initialize(token)).status).toBe(200);

    const tools = await rpc(token, "tools/list");
    expect(tools.body.result.tools).toHaveLength(45);

    const before = fake.requests.length;
    const call = await rpc(token, "tools/call", {
      name: "get_athlete",
      arguments: {},
    });
    expect(call.body.result.isError).toBeFalsy();
    const sent = fake.requests.slice(before);
    // The athlete ID came from the key's own profile, not from the form.
    expect(sent.map((r) => r.path)).toEqual(["/athlete/i42"]);
    expect(sent[0].headers.authorization).toBe("Basic " + btoa(`API_KEY:${GOOD_KEY}`));
  });

  it("leaves the delete tools out for a user who chose delete mode none", async () => {
    const token = await signIn({ delete_mode: "none" });
    const tools = await rpc(token, "tools/list");
    const names = tools.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toHaveLength(43);
    expect(names).not.toContain("delete_event");
    expect(names).not.toContain("delete_workout");
  });
});
