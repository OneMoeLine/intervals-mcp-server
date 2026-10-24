import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServerProcess, runUntilExit } from "./helpers/mcp-client.js";
import { startFakeServer, type FakeServer } from "./helpers/fake-server.js";
import { ACTIVITY_SUMMARY_FIELDS } from "../src/transform.js";

/** The tools the server is contracted to expose, in registration order. */
const EXPECTED_TOOLS = [
  "get_athlete",
  "get_athlete_profile",
  "update_sport_settings",
  "list_activities",
  "get_activity",
  "search_activities",
  "get_activity_intervals",
  "search_intervals",
  "get_activity_streams",
  "get_activity_power_curve",
  "get_activity_best_efforts",
  "get_activity_weather",
  "get_activity_histogram",
  "update_activity",
  "get_power_curves",
  "get_hr_curves",
  "get_pace_curves",
  "list_wellness",
  "get_wellness",
  "update_wellness",
  "get_fitness_chart",
  "list_events",
  "get_event",
  "create_event",
  "update_event",
  "delete_event",
  "list_workouts",
  "get_workout",
  "create_workout",
  "update_workout",
  "delete_workout",
  "list_folders",
  "create_folder",
  "list_gear",
  "list_routes",
  "get_route",
];

/** Every tool that changes something upstream, sorted. Everything else must
 *  report `readOnlyHint: true`, which is what lets a client auto-approve it.
 *  The two delete tools are here because the default delete mode registers
 *  them; "none" takes them away, which has its own test. */
const EXPECTED_WRITERS = [
  "create_event",
  "create_folder",
  "create_workout",
  "delete_event",
  "delete_workout",
  "update_activity",
  "update_event",
  "update_sport_settings",
  "update_wellness",
  "update_workout",
];

let fake: FakeServer;
let server: ServerProcess;
let tools: any[];

beforeAll(async () => {
  // Credentials are dummies and the API root is a local fake, so nothing here
  // can reach Intervals.icu even if a handler did try to make a call.
  fake = await startFakeServer();
  const started = await ServerProcess.start({
    INTERVALS_BASE_URL: fake.baseUrl,
  });
  server = started.server;
  const res = await server.request("tools/list");
  tools = res.result.tools;
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await fake?.close();
});

describe("startup", () => {
  it("exits with a clear message when credentials are missing", async () => {
    const { code, stderr } = await runUntilExit({});
    expect(code).toBe(1);
    expect(stderr).toMatch(
      /Missing required environment variables: INTERVALS_API_KEY, INTERVALS_ATHLETE_ID/
    );
  }, 20_000);

  it("completes the MCP handshake and advertises the tools capability", async () => {
    const { server: s, initialize } = await ServerProcess.start({
      INTERVALS_BASE_URL: fake.baseUrl,
    });
    expect(initialize.result.serverInfo).toEqual({
      name: "intervals-icu",
      version: "1.0.0",
    });
    expect(initialize.result.capabilities.tools).toBeDefined();
    await s.stop();
  }, 20_000);
});

describe("tools/list", () => {
  it("exposes all 36 tools", () => {
    expect(tools).toHaveLength(36);
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("gives every tool a description and a valid object input schema", () => {
    for (const tool of tools) {
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      expect(tool.inputSchema.type, `${tool.name} schema type`).toBe("object");
      expect(
        typeof tool.inputSchema.properties,
        `${tool.name} schema properties`
      ).toBe("object");
      for (const req of tool.inputSchema.required ?? []) {
        expect(
          tool.inputSchema.properties,
          `${tool.name} requires ${req}`
        ).toHaveProperty(req);
      }
    }
  });

  it("describes every declared property", () => {
    for (const tool of tools) {
      for (const [name, schema] of Object.entries<any>(
        tool.inputSchema.properties
      )) {
        expect(schema.description, `${tool.name}.${name}`).toBeTruthy();
      }
    }
  });

  it("exposes types and max_points on get_activity_streams", () => {
    const schema = tools.find((t) => t.name === "get_activity_streams")
      .inputSchema;
    expect(schema.required).toEqual(["activity_id"]);
    expect(schema.properties.types).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(schema.properties.max_points).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 10_000,
    });
    expect(schema.properties.max_points.description).toMatch(/default 500/);
  });

  it("requires stream on get_activity_best_efforts and leaves the pair optional", () => {
    const schema = tools.find((t) => t.name === "get_activity_best_efforts")
      .inputSchema;
    expect(schema.required).toEqual(["activity_id", "stream"]);
    expect(schema.properties.duration).toBeDefined();
    expect(schema.properties.distance).toBeDefined();
    // The either/or rule cannot be expressed in the raw shape, so it is
    // enforced in the handler instead - see the tools/call tests below.
    expect(schema.required).not.toContain("duration");
    expect(schema.required).not.toContain("distance");
  });

  it("gives every tool a title", () => {
    for (const tool of tools) {
      expect(tool.title, `${tool.name} title`).toBeTruthy();
    }
  });

  it("reports exactly ten writers, and they are the expected ten", () => {
    const writers = tools
      .filter((t) => t.annotations?.readOnlyHint === false)
      .map((t) => t.name)
      .sort();
    expect(writers).toEqual(EXPECTED_WRITERS);
  });

  it("marks every other tool read-only and reaching an external API", () => {
    for (const tool of tools) {
      expect(tool.annotations, `${tool.name} annotations`).toBeDefined();
      expect(tool.annotations.openWorldHint, `${tool.name} openWorldHint`).toBe(
        true
      );
      if (EXPECTED_WRITERS.includes(tool.name)) continue;
      expect(tool.annotations.readOnlyHint, `${tool.name} readOnlyHint`).toBe(
        true
      );
    }
  });

  it("describes each writer's destructiveness and idempotence", () => {
    const annotationsFor = (name: string) =>
      tools.find((t) => t.name === name).annotations;
    // Overwrites fields on an existing record, and repeating the call leaves
    // that record in the same state.
    expect(annotationsFor("update_wellness")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    // Only ever adds - but a second call adds a second calendar entry.
    expect(annotationsFor("create_event")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    // Destructive, and once it is gone a second delete changes nothing more.
    expect(annotationsFor("delete_event")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  });

  it("offers a fields parameter on each of the twelve trimming tools", () => {
    const withFields = tools
      .filter((t) => "fields" in t.inputSchema.properties)
      .map((t) => t.name)
      .sort();
    expect(withFields).toEqual([
      "get_activity",
      "get_activity_intervals",
      "get_athlete",
      "get_event",
      "get_hr_curves",
      "get_pace_curves",
      "get_power_curves",
      "list_activities",
      "list_events",
      "list_folders",
      "list_wellness",
      "search_intervals",
    ]);
  });
});

describe("tools/call validation", () => {
  /** The SDK reports both schema and handler failures as an error result. */
  const errorText = (res: any) => {
    expect(res.result?.isError, JSON.stringify(res)).toBe(true);
    return res.result.content[0].text as string;
  };

  it("rejects best efforts with neither duration nor distance", async () => {
    const before = fake.requests.length;
    const res = await server.request("tools/call", {
      name: "get_activity_best_efforts",
      arguments: { activity_id: "a1", stream: "watts" },
    });
    expect(errorText(res)).toMatch(
      /exactly one of duration \(seconds\) or distance \(meters\)/
    );
    expect(fake.requests).toHaveLength(before);
  });

  it("rejects best efforts with both duration and distance", async () => {
    const before = fake.requests.length;
    const res = await server.request("tools/call", {
      name: "get_activity_best_efforts",
      arguments: {
        activity_id: "a1",
        stream: "watts",
        duration: 300,
        distance: 1_000,
      },
    });
    expect(errorText(res)).toMatch(
      /exactly one of duration \(seconds\) or distance \(meters\)/
    );
    expect(fake.requests).toHaveLength(before);
  });

  it("rejects a malformed date before making any HTTP call", async () => {
    const before = fake.requests.length;
    const res = await server.request("tools/call", {
      name: "list_activities",
      arguments: { oldest: "June 1 2024", newest: "2024-06-30" },
    });
    expect(errorText(res)).toMatch(/Must be a date in YYYY-MM-DD format/);
    expect(errorText(res)).toMatch(/oldest/);
    expect(fake.requests).toHaveLength(before);
  });

  it("rejects a date with a time component on a date-only input", async () => {
    const before = fake.requests.length;
    const res = await server.request("tools/call", {
      name: "list_wellness",
      arguments: { oldest: "2024-06-01T10:00:00", newest: "2024-06-30" },
    });
    expect(errorText(res)).toMatch(/YYYY-MM-DD/);
    expect(fake.requests).toHaveLength(before);
  });

  it("rejects an unknown tool name", async () => {
    const res = await server.request("tools/call", {
      name: "no_such_tool",
      arguments: {},
    });
    expect(res.error ?? res.result?.isError).toBeTruthy();
  });
});

describe("tools/call against the fake API", () => {
  it("sends the request the tool promises and trims the response", async () => {
    // The API returns a fixed, very wide key set, so the fake record carries
    // the whole summary set plus one field outside it.
    const record: Record<string, unknown> = Object.fromEntries(
      ACTIVITY_SUMMARY_FIELDS.map((f) => [f, null])
    );
    record.id = "a1";
    record.name = "Morning Ride";
    record.type = "Ride";
    record.icu_training_load = 70;
    record.icu_sync_date = "2024-06-01";
    fake.replyWith({ body: [record] });
    const res = await server.request("tools/call", {
      name: "list_activities",
      arguments: { oldest: "2024-06-01", newest: "2024-06-30", limit: 5 },
    });

    const sent = fake.requests[fake.requests.length - 1];
    expect(sent.path).toBe("/athlete/i1/activities");
    expect(sent.query).toEqual({
      oldest: "2024-06-01",
      newest: "2024-06-30",
      limit: "5",
    });

    const payload = JSON.parse(res.result.content[0].text);
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      id: "a1",
      name: "Morning Ride",
      icu_training_load: 70,
    });
    // Exactly the documented default set, and nothing beyond it.
    expect(Object.keys(payload[0])).toEqual(ACTIVITY_SUMMARY_FIELDS);
    expect(payload[0]).not.toHaveProperty("icu_sync_date");
  });

  it("downsamples streams end to end and reports the counts", async () => {
    fake.replyWith({
      body: [
        {
          type: "watts",
          data: Array.from({ length: 5_000 }, (_, i) => i),
        },
      ],
    });
    const res = await server.request("tools/call", {
      name: "get_activity_streams",
      arguments: { activity_id: "a1", types: ["watts"], max_points: 50 },
    });

    expect(fake.requests[fake.requests.length - 1].query).toEqual({
      types: "watts",
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload[0].data).toHaveLength(50);
    expect(payload[0].data[0]).toBe(0);
    expect(payload[0].data[49]).toBe(4_999);
    expect(payload[0].downsampled).toEqual({
      original_points: 5_000,
      returned_points: 50,
    });
  });

  it("PUTs only the supplied fields on update_wellness", async () => {
    fake.replyWith({ body: { id: "2024-06-01" } });
    await server.request("tools/call", {
      name: "update_wellness",
      arguments: { date: "2024-06-01", restingHR: 48, mood: 4 },
    });

    const sent = fake.requests[fake.requests.length - 1];
    expect(sent.method).toBe("PUT");
    expect(sent.path).toBe("/athlete/i1/wellness/2024-06-01");
    // The date goes in the path, and the untouched metrics are not sent at all.
    expect(JSON.parse(sent.body)).toEqual({ restingHR: 48, mood: 4 });
  });

  it("POSTs a new calendar event", async () => {
    fake.replyWith({ body: { id: 99 } });
    await server.request("tools/call", {
      name: "create_event",
      arguments: {
        start_date_local: "2024-07-01T08:00:00",
        category: "WORKOUT",
        name: "Threshold intervals",
      },
    });

    const sent = fake.requests[fake.requests.length - 1];
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/athlete/i1/events");
    expect(JSON.parse(sent.body)).toMatchObject({
      start_date_local: "2024-07-01T08:00:00",
      category: "WORKOUT",
      name: "Threshold intervals",
    });
  });

  it("drops the activities lookup map from get_power_curves", async () => {
    fake.replyWith({
      body: {
        list: [
          { id: "c1", label: "42d", secs: [5, 60], values: [900, 400], ftp: 250 },
        ],
        activities: { a1: "Morning Ride", a2: "Hill repeats" },
      },
    });
    const res = await server.request("tools/call", {
      name: "get_power_curves",
      arguments: { type: "Ride", fields: ["id", "label", "secs", "values"] },
    });

    expect(fake.requests[fake.requests.length - 1].query).toEqual({
      type: "Ride",
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload).not.toHaveProperty("activities");
    expect(payload.list).toEqual([
      { id: "c1", label: "42d", secs: [5, 60], values: [900, 400] },
    ]);
  });

  it("keeps the activities map when asked for everything", async () => {
    const body = {
      list: [{ id: "c1", ftp: 250 }],
      activities: { a1: "Morning Ride" },
    };
    fake.replyWith({ body });
    const res = await server.request("tools/call", {
      name: "get_power_curves",
      arguments: { type: "Ride", fields: ["*"] },
    });
    expect(JSON.parse(res.result.content[0].text)).toEqual(body);
  });

  it("trims an hr curve to the summary fields by default", async () => {
    fake.replyWith({
      body: {
        list: [
          {
            id: "42d",
            label: "42 days",
            days: 43,
            secs: [1, 2, 3],
            values: [188, 188, 187],
            activity_id: ["a1", "a1", "a2"],
            start_index: [0, 0, 11],
            end_index: [1, 2, 14],
            submax_values: [[180]],
            weight: 67.1,
          },
        ],
        activities: { a1: "Morning Run", a2: "Hill repeats" },
      },
    });
    const res = await server.request("tools/call", {
      name: "get_hr_curves",
      arguments: { type: "Run", curves: "42d" },
    });

    const sent = fake.requests[fake.requests.length - 1];
    expect(sent.path).toBe("/athlete/i1/hr-curves");
    expect(sent.query).toEqual({ type: "Run", curves: "42d" });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload).not.toHaveProperty("activities");
    // The curve and its provenance survive; the per-point index tables and the
    // submax matrix, which dwarf them, do not.
    expect(Object.keys(payload.list[0]).sort()).toEqual([
      "activity_id",
      "days",
      "id",
      "label",
      "secs",
      "values",
    ]);
  });

  it("asks for grade adjusted pace only when told to", async () => {
    const paceBody = (type: string) => ({
      list: [
        {
          id: "42d",
          label: "42 days",
          type,
          days: 43,
          distance: [100, 200],
          values: [15, 32],
          paceModels: [{ type: "CS", criticalSpeed: 4.48, dPrime: 28.4 }],
          start_index: [0, 0],
          submax_values: [[16]],
        },
      ],
      activities: { a1: "Morning Run" },
    });

    fake.replyWith({ body: paceBody("PACE") });
    const plain = await server.request("tools/call", {
      name: "get_pace_curves",
      arguments: { type: "Run" },
    });
    expect(fake.requests[fake.requests.length - 1].query).toEqual({
      type: "Run",
    });

    fake.replyWith({ body: paceBody("GAP") });
    const adjusted = await server.request("tools/call", {
      name: "get_pace_curves",
      arguments: { type: "Run", gap: true },
    });
    const sent = fake.requests[fake.requests.length - 1];
    expect(sent.path).toBe("/athlete/i1/pace-curves");
    expect(sent.query).toEqual({ type: "Run", gap: "true" });

    // Pace curves run against distance, not duration, and `type` is in the
    // default field set so a GAP answer identifies itself.
    const curveOf = (res: any) =>
      JSON.parse(res.result.content[0].text).list[0];
    expect(curveOf(plain)).toEqual({
      id: "42d",
      label: "42 days",
      type: "PACE",
      days: 43,
      distance: [100, 200],
      values: [15, 32],
      paceModels: [{ type: "CS", criticalSpeed: 4.48, dPrime: 28.4 }],
    });
    expect(curveOf(adjusted).type).toBe("GAP");
  });

  it("asks for the chosen histogram and drops the empty buckets", async () => {
    fake.replyWith({
      body: [
        { min: 200, max: 225, secs: 600, start: null, movingSecs: null },
        { min: 175, max: 200, secs: 300 },
        { min: 225, max: 250, secs: 0 },
      ],
    });
    const res = await server.request("tools/call", {
      name: "get_activity_histogram",
      arguments: { activity_id: "i123", metric: "power" },
    });

    const req = fake.requests[fake.requests.length - 1];
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/activity/i123/power-histogram");
    expect(JSON.parse(res.result.content[0].text)).toEqual({
      metric: "power",
      total_secs: 900,
      buckets: [
        { min: 175, max: 200, secs: 300 },
        { min: 200, max: 225, secs: 600 },
      ],
    });
  });

  it("rejects a histogram metric the API does not have", async () => {
    const before = fake.requests.length;
    const res = await server.request("tools/call", {
      name: "get_activity_histogram",
      arguments: { activity_id: "i123", metric: "cadence" },
    });
    expect(res.result?.isError ?? Boolean(res.error)).toBe(true);
    expect(fake.requests.length).toBe(before);
  });

  it("sends all four interval-search bounds and trims the activities", async () => {
    fake.replyWith({
      body: [
        {
          id: "i9",
          name: "Threshold 3x12",
          type: "Ride",
          start_date_local: "2026-10-01T07:00:00",
          interval_summary: ["3x 12m 262w"],
          icu_training_load: 98,
          average_cadence: 88,
        },
      ],
    });
    const res = await server.request("tools/call", {
      name: "search_intervals",
      arguments: { min_secs: 600, max_intensity: 105, type: "POWER" },
    });

    const req = fake.requests[fake.requests.length - 1];
    expect(req.path).toBe("/athlete/i1/activities/interval-search");
    expect(req.query).toEqual({
      minSecs: "600",
      maxSecs: "86400",
      minIntensity: "0",
      maxIntensity: "105",
      limit: "30",
      type: "POWER",
    });
    const [hit] = JSON.parse(res.result.content[0].text);
    expect(hit.interval_summary).toEqual(["3x 12m 262w"]);
    expect(hit).not.toHaveProperty("average_cadence");
  });

  it("rejects an interval search whose bounds are inverted", async () => {
    const before = fake.requests.length;
    const res = await server.request("tools/call", {
      name: "search_intervals",
      arguments: { min_secs: 1200, max_secs: 600 },
    });
    expect(res.result.isError).toBe(true);
    expect(fake.requests.length).toBe(before);
  });

  it("surfaces an upstream error as an error result", async () => {
    fake.replyWith({ status: 404, body: "activity not found" });
    const res = await server.request("tools/call", {
      name: "get_activity",
      arguments: { activity_id: "nope" },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/404: activity not found/);
  });
});

describe("write tools against the fake API", () => {
  const SPORT_SETTINGS = [
    { id: 11, types: ["Ride", "VirtualRide"], ftp: 261, lthr: 172, hr_zones: [140, 172] },
    { id: 12, types: ["Run", "TrailRun"], threshold_pace: 4.0, lthr: 176 },
  ];

  it("finds the settings by sport type and PUTs only the change", async () => {
    fake.replyUsing((req) =>
      req.method === "GET"
        ? { body: SPORT_SETTINGS }
        : { body: { ...SPORT_SETTINGS[1], ...JSON.parse(req.body) } }
    );
    const res = await server.request("tools/call", {
      name: "update_sport_settings",
      arguments: { sport: "trailrun", threshold_pace: "3:56/km" },
    });

    const put = fake.requests[fake.requests.length - 1];
    expect(put.method).toBe("PUT");
    expect(put.path).toBe("/athlete/i1/sport-settings/12");
    expect(put.query).toEqual({ recalcHrZones: "true" });
    expect(JSON.parse(put.body)).toEqual({ threshold_pace: 4.2373 });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload).toMatchObject({
      id: 12,
      before: { threshold_pace: 4.0 },
      after: { threshold_pace: 4.2373 },
    });
  });

  it("leaves hr zones alone when they are supplied explicitly", async () => {
    fake.replyUsing((req) =>
      req.method === "GET" ? { body: SPORT_SETTINGS } : { body: SPORT_SETTINGS[0] }
    );
    await server.request("tools/call", {
      name: "update_sport_settings",
      arguments: { sport: "Ride", ftp: 265, hr_zones: [145, 175] },
    });
    const put = fake.requests[fake.requests.length - 1];
    expect(put.query).toEqual({ recalcHrZones: "false" });
    expect(JSON.parse(put.body)).toEqual({ ftp: 265, hr_zones: [145, 175] });
  });

  it("names the sports it has when asked for one it does not", async () => {
    fake.replyWith({ body: SPORT_SETTINGS });
    const before = fake.requests.length;
    const res = await server.request("tools/call", {
      name: "update_sport_settings",
      arguments: { sport: "Rowing", ftp: 200 },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/Ride\/VirtualRide, Run\/TrailRun/);
    expect(fake.requests.length).toBe(before + 1); // the read, and no PUT
  });

  it("rejects a sport settings update with nothing in it", async () => {
    const before = fake.requests.length;
    const res = await server.request("tools/call", {
      name: "update_sport_settings",
      arguments: { sport: "Ride" },
    });
    expect(res.result.isError).toBe(true);
    expect(fake.requests.length).toBe(before);
  });

  it("rejects a category the API does not have, before any HTTP call", async () => {
    const before = fake.requests.length;
    const res = await server.request("tools/call", {
      name: "create_event",
      arguments: {
        start_date_local: "2024-07-01T08:00:00",
        // The obvious guess, and not a category: races are RACE_A/B/C.
        category: "RACE",
        type: "Ride",
      },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/RACE_A/);
    expect(fake.requests).toHaveLength(before);
  });

  it("carries workout syntax through create_event as the description", async () => {
    fake.replyWith({ body: { id: 101 } });
    const steps = "Warmup\n- 10m 60%\n\nMain Set 3x\n- 5m 105%\n- 3m 50%\n";
    await server.request("tools/call", {
      name: "create_event",
      arguments: {
        start_date_local: "2024-07-02T06:30:00",
        category: "WORKOUT",
        type: "Ride",
        name: "VO2 blocks",
        description: steps,
        indoor: true,
        target: "POWER",
      },
    });

    const sent = fake.requests[fake.requests.length - 1];
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/athlete/i1/events");
    // Sent verbatim: Intervals.icu is what parses the steps, not this server.
    expect(JSON.parse(sent.body)).toEqual({
      start_date_local: "2024-07-02T06:30:00",
      category: "WORKOUT",
      type: "Ride",
      name: "VO2 blocks",
      description: steps,
      indoor: true,
      target: "POWER",
    });
  });

  it("PUTs only the supplied fields on update_activity", async () => {
    fake.replyWith({ body: { id: "a1" } });
    await server.request("tools/call", {
      name: "update_activity",
      arguments: { activity_id: "a1", name: "Evening Ride", icu_rpe: 7 },
    });

    const sent = fake.requests[fake.requests.length - 1];
    expect(sent.method).toBe("PUT");
    expect(sent.path).toBe("/activity/a1");
    expect(JSON.parse(sent.body)).toEqual({ name: "Evening Ride", icu_rpe: 7 });
  });

  it("PUTs an event update to the path for that event", async () => {
    fake.replyWith({ body: { id: 42 } });
    await server.request("tools/call", {
      name: "update_event",
      arguments: { event_id: 42, name: "Moved to Tuesday", moving_time: 3600 },
    });

    const sent = fake.requests[fake.requests.length - 1];
    expect(sent.method).toBe("PUT");
    expect(sent.path).toBe("/athlete/i1/events/42");
    expect(JSON.parse(sent.body)).toEqual({
      name: "Moved to Tuesday",
      moving_time: 3600,
    });
  });

  it("POSTs a library workout into its folder", async () => {
    fake.replyWith({ body: { id: 7 } });
    await server.request("tools/call", {
      name: "create_workout",
      arguments: {
        folder_id: 3,
        name: "Sweet spot 3x12",
        type: "Ride",
        description: "Main Set 3x\n- 12m 90%\n- 5m 55%\n",
      },
    });

    const sent = fake.requests[fake.requests.length - 1];
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/athlete/i1/workouts");
    expect(JSON.parse(sent.body)).toMatchObject({
      folder_id: 3,
      name: "Sweet spot 3x12",
      type: "Ride",
    });
  });

  it("DELETEs a library workout without reading it first", async () => {
    fake.replyWith({ body: {} });
    const before = fake.requests.length;
    await server.request("tools/call", {
      name: "delete_workout",
      arguments: { workout_id: "w9" },
    });

    const sent = fake.requests.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("DELETE");
    expect(sent[0].path).toBe("/athlete/i1/workouts/w9");
  });

  it("trims folder records on list_folders", async () => {
    fake.replyWith({
      body: [
        {
          id: 3,
          name: "Base plan",
          type: "PLAN",
          description: null,
          num_workouts: 24,
          duration_weeks: 8,
          start_date_local: null,
          activity_types: ["Ride"],
          visibility: "PRIVATE",
          shareToken: "secret-token",
          children: [{ id: 1 }],
        },
      ],
    });
    const res = await server.request("tools/call", {
      name: "list_folders",
      arguments: {},
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload[0]).not.toHaveProperty("shareToken");
    expect(payload[0]).not.toHaveProperty("children");
    expect(payload[0]).toMatchObject({ id: 3, name: "Base plan", type: "PLAN" });
  });
});

describe("sparse API payloads", () => {
  /** The live API omits keys per record rather than nulling them: a single
   *  event carries no `paired_activity_id` where the list of events does, and
   *  an event with no sport carries no `type`. The default summary set names
   *  those fields, so validating it would fail a read the caller did not get
   *  wrong - which is exactly what happened against the real API. */
  const sparseEvent = {
    id: 42,
    name: "Rest day",
    category: "NOTE",
    start_date_local: "2024-06-01T00:00:00",
    description: "easy",
  };

  it("reads an event whose payload omits most of the summary set", async () => {
    fake.replyWith({ body: sparseEvent });
    const res = await server.request("tools/call", {
      name: "get_event",
      arguments: { event_id: "42" },
    });

    expect(res.result.isError).toBeFalsy();
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload).toEqual(sparseEvent);
  });

  it("lists events whose payloads omit most of the summary set", async () => {
    fake.replyWith({ body: [sparseEvent] });
    const res = await server.request("tools/call", {
      name: "list_events",
      arguments: { oldest: "2024-06-01", newest: "2024-06-30" },
    });

    expect(res.result.isError).toBeFalsy();
    expect(JSON.parse(res.result.content[0].text)).toEqual([sparseEvent]);
  });

  it("builds the fitness chart from records missing the load fields", async () => {
    fake.replyWith({ body: [{ id: "2024-06-01", ctl: 50, atl: 40 }] });
    const res = await server.request("tools/call", {
      name: "get_fitness_chart",
      arguments: { oldest: "2024-06-01", newest: "2024-06-01" },
    });

    expect(res.result.isError).toBeFalsy();
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.series).toEqual([
      { date: "2024-06-01", ctl: 50, atl: 40, form: 10 },
    ]);
  });

  it("still reports a typo in a caller-supplied field name", async () => {
    fake.replyWith({ body: sparseEvent });
    const res = await server.request("tools/call", {
      name: "get_event",
      arguments: { event_id: "42", fields: ["nmae"] },
    });

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("Unknown field(s): nmae");
  });
});

describe("get_fitness_chart", () => {
  /** The API returns a fixed key set per wellness record, nulls included. */
  const record = (
    id: string,
    ctl: number | null,
    atl: number | null,
    rampRate: number | null = null
  ) => ({ id, ctl, atl, rampRate, ctlLoad: null, atlLoad: null });

  it("builds a CTL/ATL/form series and flags the projected days", async () => {
    fake.replyWith({
      body: [
        // Out of order on purpose: the series comes back ascending.
        record("2024-06-02", 50.44, 60.46, 1.27),
        record("2024-06-01", 49.9, 55.1),
        // No fitness data at all: dropped, not zero-filled.
        record("2024-06-03", null, null),
        // Far enough out to be a projection whenever this test runs.
        record("2999-01-01", 70, 40),
      ],
    });
    const res = await server.request("tools/call", {
      name: "get_fitness_chart",
      arguments: { oldest: "2024-06-01", newest: "2999-01-01" },
    });

    expect(fake.requests[fake.requests.length - 1].query).toEqual({
      oldest: "2024-06-01",
      newest: "2999-01-01",
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.count).toBe(3);
    expect(payload.series.map((p: any) => p.date)).toEqual([
      "2024-06-01",
      "2024-06-02",
      "2999-01-01",
    ]);
    // form is CTL - ATL, rounded like the values it is computed from.
    expect(payload.series[0]).toEqual({
      date: "2024-06-01",
      ctl: 49.9,
      atl: 55.1,
      form: -5.2,
    });
    expect(payload.series[1].ramp_rate).toBe(1.3);
    expect(payload.series[1].projected).toBeUndefined();
    expect(payload.series[2].projected).toBe(true);
    expect(payload.summary.oldest.date).toBe("2024-06-01");
    expect(payload.summary.newest.date).toBe("2999-01-01");
  });
});

describe("delete modes", () => {
  it("refuses a past event in the default safe mode, and sends no DELETE", async () => {
    fake.replyWith({
      body: { id: 5, start_date_local: "2020-01-01T09:00:00" },
    });
    const before = fake.requests.length;
    const res = await server.request("tools/call", {
      name: "delete_event",
      arguments: { event_id: 5 },
    });

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/dated 2020-01-01/);
    expect(res.result.content[0].text).toMatch(/INTERVALS_DELETE_MODE=full/);
    const sent = fake.requests.slice(before);
    expect(sent.map((r) => r.method)).toEqual(["GET"]);
  });

  it("deletes a future event in safe mode", async () => {
    fake.replyUsing((req) =>
      req.method === "GET"
        ? { body: { id: 6, start_date_local: "2999-01-01T09:00:00" } }
        : { body: {} }
    );
    const before = fake.requests.length;
    await server.request("tools/call", {
      name: "delete_event",
      arguments: { event_id: 6 },
    });

    const sent = fake.requests.slice(before);
    expect(sent.map((r) => r.method)).toEqual(["GET", "DELETE"]);
    expect(sent[1].path).toBe("/athlete/i1/events/6");
    fake.replyWith({ status: 200, body: {} });
  });

  it("deletes a past event in full mode, without reading it first", async () => {
    const { server: s } = await ServerProcess.start({
      INTERVALS_BASE_URL: fake.baseUrl,
      INTERVALS_DELETE_MODE: "full",
    });
    fake.replyWith({ body: {} });
    const before = fake.requests.length;
    await s.request("tools/call", {
      name: "delete_event",
      arguments: { event_id: 7 },
    });

    const sent = fake.requests.slice(before);
    expect(sent.map((r) => r.method)).toEqual(["DELETE"]);
    expect(sent[0].path).toBe("/athlete/i1/events/7");
    await s.stop();
  }, 20_000);

  it("does not register the delete tools at all in none mode", async () => {
    const { server: s } = await ServerProcess.start({
      INTERVALS_BASE_URL: fake.baseUrl,
      INTERVALS_DELETE_MODE: "none",
    });
    const res = await s.request("tools/list");
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toHaveLength(EXPECTED_TOOLS.length - 2);
    expect(names).not.toContain("delete_event");
    expect(names).not.toContain("delete_workout");
    // The rest of the server is unaffected.
    expect(names).toContain("create_event");
    await s.stop();
  }, 20_000);

  it("exits with a clear message on an unknown delete mode", async () => {
    const { code, stderr } = await runUntilExit({
      INTERVALS_API_KEY: "test-key",
      INTERVALS_ATHLETE_ID: "i1",
      INTERVALS_DELETE_MODE: "wipe-everything",
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/Invalid INTERVALS_DELETE_MODE: wipe-everything/);
    expect(stderr).toMatch(/safe, full, none/);
  }, 20_000);
});

describe("resources", () => {
  it("publishes the workout syntax reference", async () => {
    const res = await server.request("resources/list");
    const uris = res.result.resources.map((r: any) => r.uri);
    expect(uris).toContain("intervals-icu://workout-syntax");
  });

  it("serves the syntax, including the traps that fail silently", async () => {
    const res = await server.request("resources/read", {
      uri: "intervals-icu://workout-syntax",
    });
    const text = res.result.contents[0].text as string;
    expect(res.result.contents[0].uri).toBe("intervals-icu://workout-syntax");
    // The mistakes that produce a wrong workout with no error, each one
    // confirmed against the live parser:
    expect(text).toMatch(/is 400 minutes, not 400 metres/);
    expect(text).toMatch(/required on every pace target/);
    expect(text).toMatch(/with a dash is never a repeat/);
    expect(text).toMatch(/Absolute heart rate in bpm is NOT parsed/);
    expect(text).toMatch(/Clock formats are NOT parsed/);
    // The examples must not use the dashed repeat form the text warns about.
    expect(text).not.toMatch(/^ +- d+x$/m);
  });
});
