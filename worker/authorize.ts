import { IntervalsClient } from "../src/api.js";
import {
  DELETE_MODES,
  isValidTimeZone,
  parseDeleteMode,
  type DeleteMode,
} from "../src/server.js";
import type { Props } from "./props.js";

/** The parts of the OAuth provider's helpers (`env.OAUTH_PROVIDER`) the
 *  sign-in page uses. Declared here rather than imported so the page can be
 *  tested under Node with a stand-in: the provider package itself only loads
 *  inside the Workers runtime. */
export interface ConsentHelpers<R extends { scope: string[] }> {
  parseAuthRequest(request: Request): Promise<R>;
  describeConsent(authRequest: R): Promise<{
    clientName: string;
    clientDomain?: string;
    redirectHost: string;
    redirectIsLoopback: boolean;
  }>;
  beginConsent(authRequest: R): Promise<{ handle: string; headers: Headers }>;
  approveConsent(
    request: Request,
    handle: string
  ): Promise<{ request: R; headers: Headers }>;
  denyConsent(request: Request, handle: string): Promise<{ headers: Headers }>;
  completeAuthorization(options: {
    request: R;
    userId: string;
    metadata: unknown;
    scope: string[];
    props: Props;
  }): Promise<{ redirectTo: string }>;
}

export interface AuthorizeOptions {
  /** Comma-separated invite codes. Sign-in is closed when there are none. */
  inviteCodes?: string;
  /** API root override, for tests against a fake server. */
  baseUrl?: string;
}

/** `/authorize`: one page that both signs the user in - an invite code plus
 *  their own Intervals.icu API key - and asks whether the connecting app may
 *  act for them. GET renders it; POST checks it and completes the grant. */
export async function handleAuthorize<R extends { scope: string[] }>(
  request: Request,
  oauth: ConsentHelpers<R>,
  options: AuthorizeOptions
): Promise<Response> {
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      // Describe first: a failed lookup then leaves nothing behind in KV.
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return page(details, consent.handle, {}, consent.headers);
    }
    if (request.method !== "POST") {
      return text("Method not allowed", 405);
    }

    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    const input: FormInput = {
      athleteId: String(form.get("athlete_id") ?? "").trim(),
      timeZone: String(form.get("timezone") ?? "").trim(),
      deleteMode: String(form.get("delete_mode") ?? "safe"),
    };
    const checked = await checkSignIn(form, input, options);
    if ("error" in checked) {
      // The form posts back to the same URL, so the authorization request
      // can be read again without consuming the handle; the browser keeps
      // the binding cookie it was given with the first render.
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      return page(details, handle, { ...input, error: checked.error }, new Headers(), 400);
    }

    const approved = await oauth.approveConsent(request, handle);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request, // from storage, not from the form
      userId: checked.props.athleteId,
      metadata: {},
      scope: approved.request.scope,
      props: checked.props,
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "AuthorizationError") {
      const redirectTo = (err as { redirectTo?: string }).redirectTo;
      // A redirect back to the client is safe only once the library has
      // validated its redirect URI; otherwise the error is shown here.
      if (redirectTo) return Response.redirect(redirectTo, 302);
      const description = (err as { description?: string }).description;
      return text(
        `Sign-in failed: ${description || "invalid request"}. ` +
          "Start again from the app you were connecting.",
        400
      );
    }
    if (name === "CimdFetchError") {
      return text("This app could not be verified.", 400);
    }
    throw err;
  }
}

interface FormInput {
  athleteId: string;
  timeZone: string;
  deleteMode: string;
  error?: string;
}

/** Check the invite code, then the API key against the live API. The key is
 *  never echoed back, logged, or kept anywhere but the grant's encrypted
 *  props. */
async function checkSignIn(
  form: FormData,
  input: FormInput,
  options: AuthorizeOptions
): Promise<{ props: Props } | { error: string }> {
  const codes = (options.inviteCodes ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
  if (codes.length === 0) {
    return { error: "This server is not accepting sign-ins right now." };
  }
  const invite = String(form.get("invite") ?? "").trim();
  if (!(await matchesAny(invite, codes))) {
    return { error: "That invite code is not valid." };
  }

  const apiKey = String(form.get("api_key") ?? "").trim();
  if (!apiKey) return { error: "Enter your Intervals.icu API key." };

  const deleteMode = parseDeleteMode(input.deleteMode);
  if (!deleteMode) return { error: "Choose a delete mode." };
  if (input.timeZone && !isValidTimeZone(input.timeZone)) {
    return { error: `"${input.timeZone}" is not a timezone this server knows.` };
  }

  // Athlete ID 0 means "whoever owns this key", so the field can be left
  // blank and the real ID read back from the profile.
  const client = new IntervalsClient(apiKey, input.athleteId || "0", {
    baseUrl: options.baseUrl,
    retryDelay: () => 0,
  });
  let athlete: { id?: unknown; timezone?: unknown };
  try {
    athlete = await client.get(`/athlete/${client.athleteId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    return /API error 40[134]\b/.test(message)
      ? {
          error:
            "Intervals.icu did not accept that API key and athlete ID. If you " +
            "left the athlete ID blank, enter it and try again.",
        }
      : { error: "Could not reach Intervals.icu to check the key. Try again." };
  }
  const athleteId = typeof athlete.id === "string" ? athlete.id : input.athleteId;
  if (!athleteId || athleteId.includes(":")) {
    return { error: "Could not read your athlete ID. Enter it and try again." };
  }

  // Prefer the zone the browser reported; fall back to the profile's own.
  const profileZone =
    typeof athlete.timezone === "string" && isValidTimeZone(athlete.timezone)
      ? athlete.timezone
      : undefined;
  const timeZone = input.timeZone || profileZone;

  return { props: { apiKey, athleteId, deleteMode, timeZone } };
}

/** Compare against every code by SHA-256 digest, so neither the time taken
 *  nor an early exit says how much of a guess was right. */
async function matchesAny(candidate: string, codes: string[]): Promise<boolean> {
  const digest = async (value: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    );
  const given = await digest(candidate);
  let matched = false;
  for (const code of codes) {
    const expected = await digest(code);
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ given[i];
    matched = matched || diff === 0;
  }
  return matched;
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

const DELETE_MODE_LABELS: Record<DeleteMode, string> = {
  safe: "Safe - can delete planned events and workouts, never past ones",
  full: "Full - can delete anything, including past events",
  none: "None - cannot delete anything",
};

function page(
  details: Awaited<ReturnType<ConsentHelpers<never>["describeConsent"]>>,
  handle: string,
  input: Partial<FormInput>,
  headers: Headers,
  status = 200
): Response {
  const nonce = crypto.randomUUID();
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const modes = DELETE_MODES.map(
    (mode) =>
      `<option value="${mode}"${(input.deleteMode ?? "safe") === mode ? " selected" : ""}>` +
      `${escape(DELETE_MODE_LABELS[mode])}</option>`
  ).join("");

  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Intervals.icu</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --muted: #5f5f5f; --bg: #fafafa;
    --card: #fff; --line: #d9d9d9; --accent: #c2410c; --error: #b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ededed; --muted: #a3a3a3;
    --bg: #111; --card: #1c1c1c; --line: #333; --accent: #fb923c; --error: #f87171; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 16px; background: var(--bg); color: var(--fg);
    font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 440px; margin: 0 auto; background: var(--card);
    border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
  h1 { font-size: 1.3rem; margin: 0 0 8px; }
  p { margin: 0 0 12px; }
  .muted { color: var(--muted); font-size: 0.9rem; }
  .warn, .error { font-weight: 600; }
  .error { color: var(--error); }
  label { display: block; margin: 16px 0 4px; font-weight: 600; font-size: 0.95rem; }
  input, select { width: 100%; padding: 10px; font: inherit; color: inherit;
    background: transparent; border: 1px solid var(--line); border-radius: 8px; }
  .hint { color: var(--muted); font-size: 0.85rem; margin-top: 4px; }
  /* Connect comes first in the markup so Enter submits it; shown on the right. */
  .buttons { display: flex; flex-direction: row-reverse; gap: 12px; margin-top: 24px; }
  button { flex: 1; padding: 10px; font: inherit; font-weight: 600; border-radius: 8px;
    cursor: pointer; border: 1px solid var(--line); background: transparent; color: inherit; }
  button[value=approve] { background: var(--accent); border-color: var(--accent); color: #fff; }
</style>
<main>
  <h1>Connect ${name} to Intervals.icu</h1>
  <p class="muted">${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
  ${details.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started signing in from it.</p>' : ""}
  ${input.error ? `<p class="error" role="alert">${escape(input.error)}</p>` : ""}
  <form method="post">
    <input type="hidden" name="handle" value="${escape(handle)}">
    <label for="invite">Invite code</label>
    <input id="invite" name="invite" autocomplete="off">
    <label for="api_key">Intervals.icu API key</label>
    <input id="api_key" name="api_key" type="password" autocomplete="off">
    <p class="hint">intervals.icu → Settings → Developer Settings. It is checked once now,
      then stored encrypted and used only to call Intervals.icu for you.</p>
    <label for="athlete_id">Athlete ID <span class="muted">(optional)</span></label>
    <input id="athlete_id" name="athlete_id" placeholder="Found from your key if left blank"
      value="${escape(input.athleteId ?? "")}">
    <label for="timezone">Timezone</label>
    <input id="timezone" name="timezone" placeholder="e.g. America/Chicago"
      value="${escape(input.timeZone ?? "")}">
    <p class="hint">Decides what counts as "today". Blank uses your Intervals.icu profile's.</p>
    <label for="delete_mode">Deleting</label>
    <select id="delete_mode" name="delete_mode">${modes}</select>
    <div class="buttons">
      <button name="decision" value="approve">Connect</button>
      <button name="decision" value="deny">Cancel</button>
    </div>
  </form>
</main>
<script nonce="${nonce}">
  const tz = document.getElementById("timezone");
  if (!tz.value) {
    try { tz.value = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch {}
  }
</script>
</html>`;

  const out = new Headers(headers);
  out.set("Content-Type", "text/html; charset=utf-8");
  out.set("Cache-Control", "no-store");
  out.set("Referrer-Policy", "no-referrer");
  out.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; ` +
      "frame-ancestors 'none'; base-uri 'none'"
  );
  return new Response(html, { status, headers: out });
}
