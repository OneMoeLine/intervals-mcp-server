# Intervals.icu MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes your
[Intervals.icu](https://intervals.icu) training data — activities, power curves,
wellness, calendar, workouts, gear and routes — to an MCP client such as Claude.

Communicates over stdio. 22 tools, 20 read-only and 2 that write
(`update_wellness` and `create_event`).

## Requirements

- Node.js 18 or newer (the server uses the global `fetch` and
  `AbortSignal.timeout`)
- An Intervals.icu API key: **Settings → Developer Settings** on intervals.icu

## Configuration

The server reads two environment variables and exits with a clear message if
either is missing:

| Variable | Description |
| --- | --- |
| `INTERVALS_API_KEY` | Your Intervals.icu API key |
| `INTERVALS_ATHLETE_ID` | Your athlete ID, e.g. `i12345` |

> **Note:** there is no `dotenv` dependency, so a `.env` file is **not** loaded
> automatically. `.env.example` is a reference for the values you need — supply
> them through your MCP client's `env` block (below), or export them in your
> shell before `npm start`.

## Install and build

```bash
npm install
npm run build
```

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

**Activity and event records are trimmed.** The API returns a fixed, very wide
record — 184 fields per activity and 62 per calendar event, with roughly half
null for any given sport. `list_activities`, `get_activity`, `list_events` and
`get_event` therefore return a compact summary by default (30 fields for
activities, 14 for events, omitting the `workout_doc` workout structure).
Measured against real data:

| Call | Default | Full | Saving |
| --- | --- | --- | --- |
| `list_activities`, 14 activities | 10.9 KB | 63.8 KB | 83% |
| `get_activity`, one activity | 0.9 KB | 4.8 KB | 82% |
| `list_events`, 43 events | 14.9 KB | 91.9 KB | 84% |

Pass `fields` to choose exactly what you want — `fields: ["id","name",
"icu_training_load"]` returns those three and nothing else — or
`fields: ["*"]` for the complete record. Because the API's key set is fixed
(inapplicable metrics come back null rather than absent), a field name that
matches no record is treated as a typo: the call fails and lists the valid
field names so the mistake can be corrected in one step.

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

## Known gaps

- No `DELETE` support, so events and workouts can be created but not removed.
- The athlete ID is fixed at startup, so coach/multi-athlete use is not possible
  without restarting with a different ID.
- Athlete zones and fitness metrics (CTL/ATL/form) are not yet exposed.
- Tools use the SDK's deprecated `server.tool()` API rather than `registerTool`,
  so they carry no `readOnlyHint`/`destructiveHint` annotations and no
  `outputSchema`.
- No automated tests.
