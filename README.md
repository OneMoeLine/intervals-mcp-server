# Intervals.icu MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes your
[Intervals.icu](https://intervals.icu) training data — activities, power curves,
wellness, calendar, workouts, gear and routes — to an MCP client such as Claude.

Runs locally over stdio, or as a hosted multi-user server on Cloudflare Workers
(see [Hosting it for others](#hosting-it-for-others)). 38 tools — 26 read-only and 12 that write — plus one
resource, the Intervals.icu workout syntax reference. Built on v2 of the MCP
TypeScript SDK (`@modelcontextprotocol/server`).

## Requirements

- Node.js 20 or newer (required by the MCP SDK; the server also uses the
  global `fetch` and `AbortSignal.timeout`)
- An Intervals.icu API key: **Settings → Developer Settings** on intervals.icu

## Configuration

The server reads two required environment variables and exits with a clear
message if either is missing, plus three optional ones:

| Variable | Description |
| --- | --- |
| `INTERVALS_API_KEY` | Your Intervals.icu API key |
| `INTERVALS_ATHLETE_ID` | Your athlete ID, e.g. `i12345` |
| `INTERVALS_BASE_URL` | *Optional.* API root, for pointing the client at a local fake server. Defaults to `https://intervals.icu/api/v1`; the test suite is the only thing that normally sets it. |
| `INTERVALS_DELETE_MODE` | *Optional.* `safe` (default), `full` or `none` — how much deleting the server will do. See [Deleting](#deleting-is-gated) below. An unknown value exits with the list of valid ones. |
| `INTERVALS_TIMEZONE` | *Optional.* IANA zone, e.g. `America/Chicago`, that decides what "today" is for the `safe` delete gate and `get_fitness_chart`. Defaults to the host's own zone, which is right whenever the server runs on your machine. |

> **Note:** there is no `dotenv` dependency, so a `.env` file is **not** loaded
> automatically. `.env.example` is a reference for the values you need — supply
> them through your MCP client's `env` block (below), or export them in your
> shell before `npm start`.

### Keeping your key safe

Your API key grants full read and write access to your Intervals.icu account —
treat it like a password.

- **Never commit it.** `.env` is gitignored; `.env.example` holds placeholders
  only. Your MCP client's config file lives outside this repository, which is
  the right place for the real value.
- **Rotate it** at Settings → Developer Settings if it is ever exposed.
- The server sends the key only to `intervals.icu`, over HTTPS, as an HTTP
  Basic `Authorization` header. It is never logged, never written to disk, and
  never included in an error message.
- Credential-shaped fields in API responses are stripped before anything is
  returned to the model — see *Credentials are withheld* below.

## Install and build

```bash
git clone https://github.com/OneMoeLine/intervals-mcp-server.git
```

Then, from the clone:

```bash
npm install && npm run build
```

`npm install` builds automatically via `prepare`, so installing straight from
the repository also works:

```bash
npm install -g github:OneMoeLine/intervals-mcp-server
```

That puts an `intervals-mcp-server` command on your PATH, which you can use in
place of `node /path/to/dist/index.js` below.

## Running

```bash
npm start
```

More usefully, register it with your MCP client. For Claude Desktop, add this to
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "intervals-icu": {
      "command": "node",
      "args": ["/absolute/path/to/Intervals MCP Server/dist/index.js"],
      "env": {
        "INTERVALS_API_KEY": "your_api_key_here",
        "INTERVALS_ATHLETE_ID": "i12345"
      }
    }
  }
}
```

For development without a build step:

```bash
npm run dev
```

## Hosting it for others

The same tools can run as one hosted server that you and your friends each add
to Claude as a custom connector, from the web, desktop or phone apps. Each
person signs in once with **their own** Intervals.icu API key, so each person
sees only their own account. It runs on Cloudflare Workers, and the free plan
is enough for a handful of people.

### How it works

- `worker/index.ts` makes the Worker its own OAuth 2.1 server with
  [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider),
  which handles client registration, PKCE and tokens, the way claude.ai
  connectors expect.
- When someone connects, Claude opens `/authorize`
  (`worker/authorize.ts`). They enter an **invite code**, their API key, and
  optionally their athlete ID, timezone and delete mode. The key is checked
  against Intervals.icu once, before any grant exists.
- The key is stored only in the grant's `props`, which the library encrypts
  with a key derived from that user's token. Tokens are stored only as
  hashes. Someone reading the KV namespace cannot recover anyone's API key.
- Each request to `/mcp` builds a server bound to the caller's own
  credentials (`worker/mcp.ts`). Nothing is shared between users.

### Deploying

You need a free Cloudflare account. From the clone:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create OAUTH_KV   # paste the printed id into wrangler.toml
openssl rand -hex 16                          # the invite code you'll share
npx wrangler secret put INVITE_CODE           # paste it
npm run deploy
```

`npm run deploy` prints the Worker's URL, e.g.
`https://intervals-mcp.<your-subdomain>.workers.dev`.

### Automatic deploys

`.github/workflows/deploy.yml` runs the typecheck and tests on every push to
`main` (so on every merged pull request) and, if they pass, runs
`wrangler deploy`. It deploys `wrangler.toml` as-is, so the `OAUTH_KV`
namespace and everyone's sign-ins are untouched, and secrets such as
`INVITE_CODE` stay as you set them. You can also run it by hand from the
**Actions** tab (**Deploy Worker → Run workflow**).

It needs two repository secrets, added once under **Settings → Secrets and
variables → Actions → New repository secret**:

- `CLOUDFLARE_API_TOKEN`: in the Cloudflare dashboard, **My Profile → API
  Tokens → Create Token**, use the **Edit Cloudflare Workers** template, limit
  it to your account, and create it.
- `CLOUDFLARE_ACCOUNT_ID`: shown on the dashboard's **Workers & Pages**
  overview, or by `npx wrangler whoami`.

### Connecting (you and each friend)

In Claude: **Settings → Connectors → Add custom connector**. Name it
Intervals.icu and use the URL with `/mcp` on the end:

```
https://intervals-mcp.<your-subdomain>.workers.dev/mcp
```

Claude opens the sign-in page. Enter the invite code and your
API key (intervals.icu → Settings → Developer Settings). The athlete ID is
read from the key when the field is left blank. The timezone is filled in
from the browser. A connection stays signed in while it is used, and lapses
after 60 days unused.

### Running it locally

```bash
cp .dev.vars.example .dev.vars   # set INVITE_CODE
npm run dev:worker               # http://localhost:8787/mcp
```

### Things to know

- **Trust.** Friends hand their write-capable API key to your Worker. It is
  stored encrypted and never logged, but code you deploy handles it in memory.
  Anyone can cut off access by regenerating their key in Intervals.icu.
- **One shared code.** Everyone, you included, signs in with the same
  `INVITE_CODE`, so there is no list to keep track of. To change it, run
  `npx wrangler secret put INVITE_CODE` again and give people the new one.
  That affects only new sign-ins: anyone already connected stays connected
  until their sign-in lapses or they regenerate their Intervals.icu key. It
  also means you can't shut out one person without changing it for all.
- **Free-plan CPU limit.** Workers Free allows 10 ms of CPU per request.
  Waiting on Intervals.icu doesn't count toward it. Most tools use about a
  millisecond, but `get_activity_streams` on a long activity has to parse
  roughly 1.4 MB of JSON (about 15 ms measured for a 4-hour ride with every
  channel). It can fail with Cloudflare error 1102. Asking for only the
  channels you need (`types`) avoids that. The paid plan ($5/month) raises
  the limit to 30 s.
- `INTERVALS_BASE_URL` can be set as a Worker var only to point the server at
  a fake API, as the tests do.

## Tests

```bash
npm test
```

144 [vitest](https://vitest.dev) tests, about 4 seconds. **No credentials and
no network access are needed** — nothing in the suite contacts Intervals.icu.
`npm test` builds first (via `pretest`), because the protocol tests spawn the
compiled `dist/index.js`. `npm run test:watch` reruns on change, and
`npm run typecheck` checks `src`, `test` and `worker`.

Four layers:

- **`test/transform.test.ts`** — the pure helpers, no I/O: `decimate` (including
  the `max_points: 1` case that once divided by zero), `downsampleStreams`,
  `project`/`projectNested` and the date schemas.
- **`test/api.test.ts`** — `IntervalsClient` against a throwaway `node:http`
  server on an ephemeral loopback port: auth header, query building, JSON vs
  text parsing, which statuses retry and which do not, the `Retry-After`
  schedule and its cap, per-attempt timeouts and error-body truncation. The
  backoff is injected as zero, so the retry tests do not sleep.
- **`test/mcp.test.ts`** — the real server binary over stdio: `initialize`, then
  `tools/list` asserting all 38 tools and their input schemas, plus `tools/call`
  for the handler rules (the either/or on `get_activity_best_efforts`, date
  rejection before any HTTP call) and a handful of end-to-end calls against the
  fake API.
- **`test/worker.test.ts`** — the hosted Worker under `wrangler dev` (local
  workerd and KV, nothing deployed), driven through the whole OAuth flow the
  way claude.ai drives it: registration, the sign-in page (wrong invite, wrong
  key, Cancel), the token exchange, then `tools/list` and a `tools/call` that
  must reach the fake API with that user's own key and athlete ID.
  `test/server.test.ts` covers the delete-mode and timezone helpers.

## Tools

**Athlete** — `get_athlete`, `get_athlete_profile`, `update_sport_settings`
*(writes)*

**Activities** — `list_activities`, `get_activity`, `search_activities`,
`get_activity_intervals`, `search_intervals`, `get_activity_streams`, `get_activity_power_curve`,
`get_activity_best_efforts`, `get_activity_weather`, `get_activity_histogram`,
`update_activity`
*(writes)*

**Power, HR and pace** — `get_power_curves`, `get_hr_curves`,
`get_pace_curves`

**Wellness and fitness** — `list_wellness`, `get_wellness`,
`update_wellness` *(writes)*, `get_fitness_chart`

**Calendar** — `list_events`, `get_event`, `create_event` *(writes)*,
`update_event` *(writes)*, `duplicate_events` *(writes)*, `apply_plan`
*(writes)*, `delete_event` *(writes, gated)*

**Workouts** — `list_workouts`, `get_workout`, `create_workout` *(writes)*,
`update_workout` *(writes)*, `delete_workout` *(writes, gated)*,
`list_folders`, `create_folder` *(writes)*

**Gear and routes** — `list_gear`, `list_routes`, `get_route`

### Resources

`intervals-icu://workout-syntax` — the structured-workout text format, which
is what `description` carries on a workout event or a library workout. Read it
before writing a workout: the syntax fails silently, and the resource lists the
cases where it does.

## Behaviour worth knowing

**Streams are downsampled.** `get_activity_streams` would otherwise return tens
of thousands of samples across every channel — easily megabytes, enough to
exhaust a model's context in one call. Each channel is reduced to 500 evenly
spaced points by default, always keeping the first and last. When a channel is
reduced, the response includes a `downsampled` field reporting the original and
returned point counts. Pass `types` to fetch only the channels you need
(e.g. `["watts","heartrate"]`) and `max_points` to change the resolution.

**Records are trimmed.** The API returns fixed, very wide records — 184 fields
per activity, 84 per interval lap, 162 on the athlete, 62 per calendar event,
47 per wellness day — with much of it null or irrelevant for any given sport.
Nine tools therefore return a compact summary by default and accept a `fields`
parameter. Measured against real data:

| Call | Default | Full | Saving |
| --- | --- | --- | --- |
| `get_athlete` | 0.4 KB | 14.9 KB | 97% |
| `list_events`, 43 events | 14.9 KB | 91.9 KB | 84% |
| `list_activities`, 14 activities | 10.9 KB | 63.8 KB | 83% |
| `get_activity`, one activity | 0.9 KB | 4.8 KB | 82% |
| `get_activity_intervals`, 12 laps | 7.4 KB | 29.0 KB | 74% |
| `get_power_curves`, type=Ride | 5.4 KB | 17.9 KB | 70% |
| `get_hr_curves`, type=Run | 3.3 KB | 10.8 KB | 69% |
| `get_pace_curves`, type=Run | 2.6 KB | 10.6 KB | 75% |
| `list_wellness`, 15 days | 5.4 KB | 12.9 KB | 58% |

Pass `fields` to choose exactly what you want — `fields: ["id","name",
"icu_training_load"]` returns those three and nothing else — or
`fields: ["*"]` for the complete record. Because the API's key set is fixed
(inapplicable metrics come back null rather than absent), a field name that
matches no record is treated as a typo: the call fails and lists the valid
field names so the mistake can be corrected in one step.

Three cases are worth knowing. On `get_activity_intervals` the bulk is the
nested per-lap list, so `fields` applies to the laps inside `icu_intervals` and
`icu_groups` rather than to the wrapper. On `get_athlete`, `sportSettings`
holds per-sport FTP, thresholds and zones and is 10.2 KB on its own — ask for
it explicitly with `fields: ["sportSettings"]`. On the three curve tools the
`activities` lookup map is roughly as large as the curves themselves and is
omitted unless you pass `["*"]`; `secs` and `values` on each power or HR
curve are the curve, and `distance` against `values` on a pace curve.

**Credentials are withheld.** The athlete record carries a slot for the
account's own API key (`icu_api_key`) and a shareable `icu_friend_invite_token`.
Both are replaced with a visible marker on every athlete response, including
when you ask for `fields: ["*"]`, so neither can reach a model's context, a
transcript or a log. `email` and `icu_date_of_birth` are personal but not
credentials, so they are merely absent from the default field set and can still
be requested by name.

**Dates are validated locally.** Date inputs must be `YYYY-MM-DD`
(`create_event` and `update_event` also accept `YYYY-MM-DDTHH:MM:SS`). Malformed values fail
immediately with an actionable message rather than producing a confusing 422
from the API.

**Requests time out and retry.** Each HTTP attempt is aborted after 30 seconds.
Responses of 429 or 5xx are retried up to 3 times with exponential backoff,
honouring a `Retry-After` header when the server sends one. Intervals.icu rate
limits both per day and per rolling 15-minute window, so this matters in
practice.

**Responses are compact.** Tool results are minified JSON; the indentation in
pretty-printed output roughly doubles token cost for no benefit.

**Structured workouts are plain text.** Workout steps are not JSON: they are
written in Intervals.icu's own workout syntax and passed in `description` on
`create_event`, `update_event`, `create_workout` or `update_workout`.
Intervals.icu parses that text server-side into a structured workout with
training load, zone targets and device sync. A description it cannot parse is
kept verbatim as free text with no load and nothing to push to a head unit —
and nothing in the API response says so. Because that failure is silent, the
syntax is published as the `intervals-icu://workout-syntax` resource, including
the traps: a bare `m` is minutes (`400m` is 400 minutes, not 400 metres —
that is `400mtr`), and an absolute pace target needs the trailing word
`pace`.

<a id="deleting-is-gated"></a>
**Deleting is gated.** `INTERVALS_DELETE_MODE` decides how much deleting the
server will do, and the gate is in the server rather than in a tool argument
because a model can set an argument itself:

| Mode | Effect |
| --- | --- |
| `safe` (default) | The delete tools are registered, but `delete_event` refuses an event dated before today — it reads the event first and compares. Planning mistakes are removable; training history is not. |
| `full` | Any event can be deleted, past included, with no pre-flight read. |
| `none` | The delete tools are not registered at all, so no client can see or call them. |

`delete_workout` is allowed in both `safe` and `full`: a library workout is a
template and carries no training history of its own. Deleting one leaves
calendar events already created from it untouched.

**Reads and writes are labelled.** 26 of the 38 tools only read, and are
annotated `readOnlyHint: true` so a client can auto-approve them. The twelve
writers come in three shapes. The updates — `update_activity`,
`update_wellness`, `update_event`, `update_workout`, `update_sport_settings` — overwrite fields on an
existing record (`destructiveHint: true`, `idempotentHint: true`: repeating
the call leaves the record in the same state). The creates — `create_event`,
`duplicate_events`, `apply_plan`, `create_workout`, `create_folder` — only ever add (`destructiveHint: false`,
but `idempotentHint: false`, since a second call adds a second entry). The
deletes — `delete_event`, `delete_workout` — are `destructiveHint: true` and
`idempotentHint: true`, since once a record is gone a second delete changes
nothing further. Every tool is `openWorldHint: true`: they all reach the
Intervals.icu API, whose contents this server does not control. A test asserts
the split, so a new tool cannot be added without a hint.

## Known gaps

- The athlete ID is fixed at startup, so coach/multi-athlete use is not possible
  without restarting with a different ID.
- Athlete zones are read through `get_athlete` with
  `fields: ["sportSettings"]`. `update_sport_settings` changes them for
  activities from then on, but nothing here re-applies them to activities
  already recorded (`sport-settings/{id}/apply`): that rewrites history and
  is not exposed.
- `update_activity`, `update_event`, `delete_event`, `create_workout`,
  `update_workout`, `delete_workout`, `list_folders`, `get_fitness_chart` and
  the workout-syntax resource were exercised against a live Intervals.icu
  account on 2026-10-16 and behave as documented. Still unverified there:
  `create_folder` (the account had a folder already, so none was created), and
  `INTERVALS_DELETE_MODE=full`, which is covered only by the fake-server test —
  running it against a real account risks real history for no new information.
- Changing `category` on an existing event is one-way for some kinds: once an
  event is `TARGET` or `PLAN`, the API answers 422 "Cannot change category"
  and the only route is delete-and-recreate. `SET_EFTP` additionally requires
  `type`, since eFTP is per sport. All fourteen categories in the enum were
  accepted by the live API.
- `get_fitness_chart` reports future days as `projected` by comparing dates
  against "today" in `INTERVALS_TIMEZONE` (or the timezone chosen at hosted
  sign-in), falling back to the host's zone. A hosted server with neither
  set would count days in UTC.
- No tool declares an `outputSchema`, so a client cannot validate a result
  against a promised shape before handing it to a model.
- The test suite never contacts Intervals.icu, so it pins down this server's
  behaviour rather than the upstream API's. A change in what Intervals.icu
  actually returns would not be caught by it.
- Of the 38 tools, twenty-one are driven end to end against the fake API
  (`list_activities`, `duplicate_events`, `apply_plan`, `update_sport_settings`, `search_intervals`, `get_activity_streams`, `get_activity_histogram`,
  `get_power_curves`,
  `get_hr_curves`, `get_pace_curves`,
  `update_wellness`, `list_events`, `get_event`, `create_event`,
  `update_event`, `delete_event`, `update_activity`, `create_workout`,
  `delete_workout`, `list_folders`, `get_fitness_chart`) and two more are
  exercised on their error paths. The remaining fifteen are covered only at the
  schema level, by `tools/list`.
- `list_gear` and `list_routes` return zero records for the configured
  athlete, so they have never been exercised against real data and are
  unverified. (`list_workouts` has since been exercised live, against a
  workout created and then deleted by the verification run.)
- The `intervals-icu://workout-syntax` resource was rewritten from what the
  live parser does, not from the forum documentation, after round-tripping
  each rule through a real event. Six of its claims were wrong: the dashed
  `- 3x` repeat form (never parses), a blank line after the `Nx` marker
  (kills the repeat), clock step lengths `5:00` and `1:30:00` (dropped),
  `lap press` as a manual step (becomes prompt text), and absolute bpm
  targets in every spelling (dropped). An unparseable line is dropped on its
  own, silently, so a wrong rule shortens the workout rather than failing it.
- The curve tools take exactly one sport `type`; the API rejects a
  comma-separated list, so there is no all-sports view.

## Contributing

Issues and pull requests are welcome. Please run `npm run typecheck` and
`npm test` before opening a PR; the suite needs no credentials and no network.

## License

[MIT](LICENSE) © Travis Moe
