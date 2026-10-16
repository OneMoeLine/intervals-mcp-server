import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServerProcess, runUntilExit } from "./helpers/mcp-client.js";
import { startFakeServer, type FakeServer } from "./helpers/fake-server.js";
import { ACTIVITY_SUMMARY_FIELDS } from "../src/transform.js";

/** The tools the server is contracted to expose, in registration order. */
const EXPECTED_TOOLS = [
  "get_athlete",
  "get_athlete_profile",
  "list_activities",
  "get_activity",
  "search_activities",
  "get_activity_intervals",
  "get_activity_streams",
  "get_activity_power_curve",
  "get_activity_best_efforts",
  "get_activity_weather",
  "get_power_curves",
  "list_wellness",
  "get_wellness",
  "update_wellness",
  "list_events",
  "get_event",
  "create_event",
  "list_workouts",
  "get_workout",
  "list_gear",
  "list_routes",
  "get_route",
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
  it("exposes all 22 tools", () => {
    expect(tools).toHaveLength(22);
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

  it("offers a fields parameter on each of the eight trimming tools", () => {
    const withFields = tools
      .filter((t) => "fields" in t.inputSchema.properties)
      .map((t) => t.name)
      .sort();
    expect(withFields).toEqual([
      "get_activity",
      "get_activity_intervals",
      "get_athlete",
      "get_event",
      "get_power_curves",
      "list_activities",
      "list_events",
      "list_wellness",
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
