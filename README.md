# Intervals.icu MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes your
[Intervals.icu](https://intervals.icu) training data — activities, power curves,
wellness, calendar, workouts, gear and routes — to an MCP client such as Claude.

Communicates over stdio. 22 tools, 20 read-only and 2 that write
(`update_wellness` and `create_event`). Built on v2 of the MCP TypeScript
SDK (`@modelcontextprotocol/server`).

## Requirements

- Node.js 20 or newer (required by the MCP SDK; the server also uses the
  global `fetch` and `AbortSignal.timeout`)
- An Intervals.icu API key: **Settings → Developer Settings** on intervals.icu

## Configuration

The server reads two environment variables and exits with a clear message if
either is missing:

| Variable | Description |
| --- | --- |
| `INTERVALS_API_KEY` | Your Intervals.icu API key |
| `INTERVALS_ATHLETE_ID` | Your athlete ID, e.g. `i12345` |
| `INTERVALS_BASE_URL` | *Optional.* API root, for pointing the client at a local fake server. Defaults to `https://intervals.icu/api/v1`; the test suite is the only thing that normally sets it. |

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

## Tests

```bash
npm test
```

85 [vitest](https://vitest.dev) tests, about 1.5 seconds. **No credentials and
no network access are needed** — nothing in the suite contacts Intervals.icu.
`npm test` builds first (via `pretest`), because the protocol tests spawn the
compiled `dist/index.js`. `npm run test:watch` reruns on change, and
`npm run typecheck` checks `src` and `test` together.

Three layers:

- **`test/transform.test.ts`** — the pure helpers, no I/O: `decimate` (including
  the `max_points: 1` case that once divided by zero), `downsampleStreams`,
  `project`/`projectNested` and the date schemas.
- **`test/api.test.ts`** — `IntervalsClient` against a throwaway `node:http`
  server on an ephemeral loopback port: auth header, query building, JSON vs
  text parsing, which statuses retry and which do not, the `Retry-After`
  schedule and its cap, per-attempt timeouts and error-body truncation. The
  backoff is injected as zero, so the retry tests do not sleep.
- **`test/mcp.test.ts`** — the real server binary over stdio: `initialize`, then
  `tools/list` asserting all 22 tools and their input schemas, plus `tools/call`
  for the handler rules (the either/or on `get_activity_best_efforts`, date
  rejection before any HTTP call) and a handful of end-to-end calls against the
  fake API.

## Tools

**Athlete** — `get_athlete`, `get_athlete_profile`

**Activities** — `list_activities`, `get_activity`, `search_activities`,
`get_activity_intervals`, `get_activity_streams`, `get_activity_power_curve`,
`get_activity_best_efforts`, `get_activity_weather`

**Power** — `get_power_curves`

**Wellness** — `list_wellness`, `get_wellness`, `update_wellness` *(writes)*

**Calendar** — `list_events`, `get_event`, `create_event` *(writes)*

**Workouts** — `list_workouts`, `get_workout`

**Gear and routes** — `list_gear`, `list_routes`, `get_route`

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
Eight tools therefore return a compact summary by default and accept a `fields`
parameter. Measured against real data:

| Call | Default | Full | Saving |
| --- | --- | --- | --- |
| `get_athlete` | 0.4 KB | 14.9 KB | 97% |
| `list_events`, 43 events | 14.9 KB | 91.9 KB | 84% |
| `list_activities`, 14 activities | 10.9 KB | 63.8 KB | 83% |
| `get_activity`, one activity | 0.9 KB | 4.8 KB | 82% |
| `get_activity_intervals`, 12 laps | 7.4 KB | 29.0 KB | 74% |
| `get_power_curves`, type=Ride | 5.4 KB | 17.9 KB | 70% |
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
it explicitly with `fields: ["sportSettings"]`. On `get_power_curves` the
`activities` lookup map is roughly as large as the curves themselves and is
omitted unless you pass `["*"]`; `secs` and `values` on each curve are the
curve.

**Credentials are withheld.** The athlete record carries a slot for the
account's own API key (`icu_api_key`) and a shareable `icu_friend_invite_token`.
Both are replaced with a visible marker on every athlete response, including
when you ask for `fields: ["*"]`, so neither can reach a model's context, a
transcript or a log. `email` and `icu_date_of_birth` are personal but not
credentials, so they are merely absent from the default field set and can still
be requested by name.

**Dates are validated locally.** Date inputs must be `YYYY-MM-DD`
(`create_event` also accepts `YYYY-MM-DDTHH:MM:SS`). Malformed values fail
immediately with an actionable message rather than producing a confusing 422
from the API.

**Requests time out and retry.** Each HTTP attempt is aborted after 30 seconds.
Responses of 429 or 5xx are retried up to 3 times with exponential backoff,
honouring a `Retry-After` header when the server sends one. Intervals.icu rate
limits both per day and per rolling 15-minute window, so this matters in
practice.

**Responses are compact.** Tool results are minified JSON; the indentation in
pretty-printed output roughly doubles token cost for no benefit.

**Reads and writes are labelled.** Twenty of the 22 tools only read, and are
annotated `readOnlyHint: true` so a client can auto-approve them. Exactly two
change anything: `update_wellness` overwrites fields on the existing record for
a date (`destructiveHint: true`, `idempotentHint: true` — repeating the call
leaves the record in the same state), and `create_event` adds a calendar entry
(`destructiveHint: false`, but `idempotentHint: false`, since a second call adds
a second entry). Every tool is `openWorldHint: true`: they all reach the
Intervals.icu API, whose contents this server does not control. A test asserts
the split, so a new tool cannot be added without a hint.

## Known gaps

- No `DELETE` support, so events and workouts can be created but not removed.
- The athlete ID is fixed at startup, so coach/multi-athlete use is not possible
  without restarting with a different ID.
- Athlete zones and fitness metrics (CTL/ATL/form) are not yet exposed.
- No tool declares an `outputSchema`, so a client cannot validate a result
  against a promised shape before handing it to a model.
- The test suite never contacts Intervals.icu, so it pins down this server's
  behaviour rather than the upstream API's. A change in what Intervals.icu
  actually returns would not be caught by it.
- Of the 22 tools, five are driven end to end against the fake API
  (`list_activities`, `get_activity_streams`, `get_power_curves`,
  `update_wellness`, `create_event`) and three more are exercised on their
  error paths. The remaining fourteen are covered only at the schema level, by
  `tools/list`.
- `list_workouts`, `list_gear` and `list_routes` return zero records for the
  configured athlete, so they have never been exercised against real data and
  are unverified.
- `get_power_curves` takes exactly one sport `type`; the API rejects a
  comma-separated list, so there is no all-sports view.

## Contributing

Issues and pull requests are welcome. Please run `npm run typecheck` and
`npm test` before opening a PR; the suite needs no credentials and no network.

## License

[MIT](LICENSE) © Travis Moe
