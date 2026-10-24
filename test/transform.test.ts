import { describe, expect, it } from "vitest";
import {
  DATETIME_RE,
  DATE_RE,
  decimate,
  downsampleStreams,
  isoDate,
  isoDateTime,
  project,
  projectNested,
  ATHLETE_SUMMARY_FIELDS,
  REDACTED_ATHLETE_FIELDS,
  REDACTION_MARKER,
  redact,
  compactBody,
  fitnessSeries,
  histogram,
  paceToSpeed,
} from "../src/transform.js";

/** 0..n-1, so a sampled value doubles as its index in the original. */
const ramp = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("decimate", () => {
  it("returns exactly maxPoints and keeps the first and last", () => {
    const out = decimate(ramp(10_000), 500);
    expect(out).toHaveLength(500);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(9_999);
  });

  it("keeps the endpoints for an awkward length/cap pair", () => {
    expect(decimate(ramp(7), 4)).toEqual([0, 2, 4, 6]);
  });

  it("samples at an even spacing", () => {
    const out = decimate(ramp(1_000), 100);
    const gaps = out.slice(1).map((v, i) => v - out[i]);
    // Rounding puts every gap within one sample of the ideal step.
    expect(gaps.every((g) => Math.abs(g - 999 / 99) < 1.5)).toBe(true);
  });

  it("passes the array through untouched when it is under the cap", () => {
    const input = ramp(100);
    expect(decimate(input, 500)).toBe(input);
    expect(decimate(input, 100)).toBe(input);
  });

  it("handles empty input", () => {
    expect(decimate([], 500)).toEqual([]);
    expect(decimate([], 1)).toEqual([]);
  });

  it("returns one real point for maxPoints 1 (regression: divided by zero)", () => {
    const out = decimate(ramp(10), 1);
    expect(out).toEqual([0]);
    expect(out).not.toContain(undefined);
  });

  it("returns a single point for maxPoints 1 whatever the length", () => {
    expect(decimate(ramp(2), 1)).toEqual([0]);
    expect(decimate(ramp(10_000), 1)).toEqual([0]);
  });
});

describe("downsampleStreams", () => {
  const streams = () => [
    { type: "watts", data: ramp(1_000) },
    { type: "heartrate", data: ramp(10) },
  ];

  it("reduces a long channel and reports the counts", () => {
    const out = downsampleStreams(streams(), 100) as any[];
    expect(out[0].type).toBe("watts");
    expect(out[0].data).toHaveLength(100);
    expect(out[0].downsampled).toEqual({
      original_points: 1_000,
      returned_points: 100,
    });
  });

  it("leaves a short channel untouched and unannotated", () => {
    const input = streams();
    const out = downsampleStreams(input, 100) as any[];
    expect(out[1]).toBe(input[1]);
    expect(out[1]).not.toHaveProperty("downsampled");
  });

  it("annotates nothing when every channel is under the cap", () => {
    const input = streams();
    const out = downsampleStreams(input, 5_000) as any[];
    expect(out.every((s, i) => s === input[i])).toBe(true);
  });

  it("preserves the other fields on a reduced channel", () => {
    const out = downsampleStreams(
      [{ type: "watts", name: "Power", data: ramp(1_000) }],
      10
    ) as any[];
    expect(out[0].name).toBe("Power");
  });

  it("passes a non-array payload through unharmed", () => {
    const obj = { error: "no streams" };
    expect(downsampleStreams(obj, 100)).toBe(obj);
    expect(downsampleStreams(null, 100)).toBeNull();
    expect(downsampleStreams("nope", 100)).toBe("nope");
  });

  it("passes through entries that are not stream objects", () => {
    const out = downsampleStreams([null, 7, { type: "watts" }], 10) as any[];
    expect(out).toEqual([null, 7, { type: "watts" }]);
  });
});

describe("project", () => {
  const records = [
    { id: 1, name: "a", watts: 200, hr: null },
    { id: 2, name: "b", watts: 250, hr: 140 },
  ];

  it("picks exactly the requested keys", () => {
    expect(project(records, ["id", "name"])).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
  });

  it("keeps a null-valued field rather than dropping it", () => {
    expect(project(records[0], ["hr"])).toEqual({ hr: null });
  });

  it("preserves array vs single-object shape", () => {
    expect(Array.isArray(project(records, ["id"]))).toBe(true);
    const single = project(records[0], ["id"]);
    expect(Array.isArray(single)).toBe(false);
    expect(single).toEqual({ id: 1 });
  });

  it("returns the input unchanged for a star field list", () => {
    expect(project(records, ["*"])).toBe(records);
    expect(project(records, ["*", "id"])).toBe(records);
  });

  it("throws on an unknown field and lists the valid names", () => {
    expect(() => project(records, ["id", "powr"])).toThrow(
      /Unknown field\(s\): powr/
    );
    expect(() => project(records, ["powr"])).toThrow(
      /Valid fields are: hr, id, name, watts/
    );
  });

  it("names every unknown field at once", () => {
    expect(() => project(records, ["powr", "hartrate"])).toThrow(
      /Unknown field\(s\): powr, hartrate/
    );
  });

  it("skips validation for an empty result set", () => {
    expect(project([], ["anything", "at", "all"])).toEqual([]);
  });

  it("validates against the union of keys across records", () => {
    const ragged = [{ id: 1 }, { id: 2, only_on_second: true }];
    expect(project(ragged, ["only_on_second"])).toEqual([
      {},
      { only_on_second: true },
    ]);
  });

  it("passes a non-object payload through", () => {
    expect(project("text", ["*"])).toBe("text");
  });
});

describe("projectNested", () => {
  const data = {
    id: "a1",
    name: "Ride",
    icu_intervals: [
      { id: 0, label: "1", average_watts: 200 },
      { id: 1, label: "2", average_watts: 250 },
    ],
    icu_groups: [{ id: 0, label: "G1", group_only_field: 9 }],
  };

  it("projects the nested arrays and leaves the wrapper intact", () => {
    const out = projectNested(
      data,
      ["icu_intervals", "icu_groups"],
      ["id", "label"]
    ) as any;
    expect(out.id).toBe("a1");
    expect(out.name).toBe("Ride");
    expect(out.icu_intervals).toEqual([
      { id: 0, label: "1" },
      { id: 1, label: "2" },
    ]);
    expect(out.icu_groups).toEqual([{ id: 0, label: "G1" }]);
  });

  it("does not mutate the input", () => {
    const copy = structuredClone(data);
    projectNested(copy, ["icu_intervals"], ["id"]);
    expect(copy).toEqual(data);
  });

  it("validates against the union of the targeted arrays", () => {
    // group_only_field exists only in icu_groups; it must still be accepted.
    const out = projectNested(
      data,
      ["icu_intervals", "icu_groups"],
      ["id", "group_only_field"]
    ) as any;
    expect(out.icu_intervals).toEqual([{ id: 0 }, { id: 1 }]);
    expect(out.icu_groups).toEqual([{ id: 0, group_only_field: 9 }]);
  });

  it("throws on a name in none of the targeted arrays", () => {
    expect(() =>
      projectNested(data, ["icu_intervals", "icu_groups"], ["nope"])
    ).toThrow(/Unknown field\(s\): nope/);
  });

  it("returns the input unchanged for a star field list", () => {
    expect(projectNested(data, ["icu_intervals"], ["*"])).toBe(data);
  });

  it("returns the input when no named key holds an array", () => {
    expect(projectNested(data, ["missing"], ["id"])).toBe(data);
    const scalar = { icu_intervals: "not an array" };
    expect(projectNested(scalar, ["icu_intervals"], ["id"])).toBe(scalar);
  });

  it("returns the input for a non-object or array payload", () => {
    const arr = [{ id: 1 }];
    expect(projectNested(arr, ["icu_intervals"], ["id"])).toBe(arr);
    expect(projectNested(null, ["icu_intervals"], ["id"])).toBeNull();
  });

  it("skips validation when the targeted arrays are empty", () => {
    const empty = { icu_intervals: [], icu_groups: [] };
    expect(
      projectNested(empty, ["icu_intervals", "icu_groups"], ["id"])
    ).toEqual(empty);
  });
});

describe("date schemas", () => {
  const dateOk = (v: string) => isoDate("d").safeParse(v).success;
  const dateTimeOk = (v: string) => isoDateTime("d").safeParse(v).success;

  it("accepts YYYY-MM-DD", () => {
    for (const v of ["2024-06-01", "1999-12-31", "2024-01-01"]) {
      expect(DATE_RE.test(v)).toBe(true);
      expect(dateOk(v)).toBe(true);
      expect(dateTimeOk(v)).toBe(true);
    }
  });

  it("rejects prose and other near-misses", () => {
    for (const v of [
      "June 1 2024",
      "1 June 2024",
      "06/01/2024",
      "2024-6-1",
      "24-06-01",
      "2024-06-01 ",
      "",
      "yesterday",
    ]) {
      expect(dateOk(v)).toBe(false);
      expect(dateTimeOk(v)).toBe(false);
    }
  });

  it("rejects a time component on isoDate but accepts it on isoDateTime", () => {
    expect(dateOk("2024-06-01T10:30:00")).toBe(false);
    expect(dateTimeOk("2024-06-01T10:30:00")).toBe(true);
    expect(dateTimeOk("2024-06-01T10:30")).toBe(true);
    expect(dateTimeOk("2024-06-01 10:30:00")).toBe(true);
    expect(DATETIME_RE.test("2024-06-01T10:30:00")).toBe(true);
  });

  it("rejects a malformed time component", () => {
    for (const v of ["2024-06-01T10", "2024-06-01T", "2024-06-01T1:30:00"]) {
      expect(dateTimeOk(v)).toBe(false);
    }
  });

  it("reports an actionable message", () => {
    const r = isoDate("Start date").safeParse("June 1 2024");
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/YYYY-MM-DD/);
    }
  });
});

describe("redact", () => {
  const athlete = {
    id: "i1",
    name: "Someone",
    icu_api_key: "a-real-secret-key",
    icu_friend_invite_token: "an-invite-token",
    email: "someone@example.com",
  };

  it("replaces credential fields with the marker", () => {
    const out = redact(athlete, REDACTED_ATHLETE_FIELDS) as Record<string, unknown>;
    expect(out.icu_api_key).toBe(REDACTION_MARKER);
    expect(out.icu_friend_invite_token).toBe(REDACTION_MARKER);
  });

  it("never lets the real secret through", () => {
    const out = JSON.stringify(redact(athlete, REDACTED_ATHLETE_FIELDS));
    expect(out).not.toContain("a-real-secret-key");
    expect(out).not.toContain("an-invite-token");
  });

  it("leaves every other field untouched", () => {
    const out = redact(athlete, REDACTED_ATHLETE_FIELDS) as Record<string, unknown>;
    expect(out.id).toBe("i1");
    expect(out.name).toBe("Someone");
    expect(out.email).toBe("someone@example.com");
  });

  it("does not mutate the input", () => {
    redact(athlete, REDACTED_ATHLETE_FIELDS);
    expect(athlete.icu_api_key).toBe("a-real-secret-key");
  });

  it("leaves an absent or null field alone rather than inventing one", () => {
    const out = redact({ id: "i1", icu_api_key: null }, REDACTED_ATHLETE_FIELDS) as Record<string, unknown>;
    expect(out.icu_api_key).toBeNull();
    expect("icu_friend_invite_token" in out).toBe(false);
  });

  it("maps over an array of records", () => {
    const out = redact([athlete, athlete], REDACTED_ATHLETE_FIELDS) as Record<string, unknown>[];
    expect(out).toHaveLength(2);
    for (const r of out) expect(r.icu_api_key).toBe(REDACTION_MARKER);
  });

  it("redacts at any depth", () => {
    const out = JSON.stringify(
      redact({ list: [{ inner: athlete }], other: athlete }, REDACTED_ATHLETE_FIELDS)
    );
    expect(out).not.toContain("a-real-secret-key");
    expect(out).not.toContain("an-invite-token");
    expect(out).toContain("someone@example.com");
  });

  it("passes non-objects through unharmed", () => {
    expect(redact(null, REDACTED_ATHLETE_FIELDS)).toBeNull();
    expect(redact("text", REDACTED_ATHLETE_FIELDS)).toBe("text");
  });

  it("survives redaction followed by an explicit fields request", () => {
    const redacted = redact(athlete, REDACTED_ATHLETE_FIELDS);
    const out = project(redacted, ["id", "icu_api_key"]) as Record<string, unknown>;
    expect(out.icu_api_key).toBe(REDACTION_MARKER);
  });

  it("keeps credentials and personal data out of the default athlete fields", () => {
    for (const f of [...REDACTED_ATHLETE_FIELDS, "email", "icu_date_of_birth"]) {
      expect(ATHLETE_SUMMARY_FIELDS).not.toContain(f);
    }
  });
});

describe("compactBody", () => {
  it("drops undefined values", () => {
    expect(compactBody({ a: 1, b: undefined, c: "x" })).toEqual({
      a: 1,
      c: "x",
    });
  });

  it("keeps an explicit null, which is how a field is cleared", () => {
    expect(compactBody({ a: null, b: undefined })).toEqual({ a: null });
  });

  it("keeps falsy values that are real values", () => {
    expect(compactBody({ zero: 0, empty: "", no: false })).toEqual({
      zero: 0,
      empty: "",
      no: false,
    });
  });
});

describe("histogram", () => {
  it("returns nothing for an activity without the data", () => {
    expect(histogram([])).toEqual({ total_secs: 0, buckets: [] });
    expect(histogram(null)).toEqual({ total_secs: 0, buckets: [] });
  });

  it("keeps an open-ended bucket and skips malformed ones", () => {
    expect(
      histogram([{ min: 400, secs: 30 }, "junk", { min: 0, max: 100, secs: "x" }])
    ).toEqual({ total_secs: 30, buckets: [{ min: 400, max: null, secs: 30 }] });
  });
});

describe("paceToSpeed", () => {
  it("converts per km, per mile and per 100 m to m/s", () => {
    expect(paceToSpeed("3:56/km")).toBe(4.2373);
    expect(paceToSpeed("6:20 / mi")).toBe(4.2351);
    expect(paceToSpeed("2:00/100m")).toBe(0.8333);
  });

  it("rejects anything that is not minutes:seconds per unit", () => {
    expect(() => paceToSpeed("236")).toThrow(/not a pace/);
    expect(() => paceToSpeed("3:75/km")).toThrow(/not a pace/);
    expect(() => paceToSpeed("0:00/km")).toThrow(/0:00/);
  });
});

describe("fitnessSeries", () => {
  const record = (
    id: string,
    ctl: number | null,
    atl: number | null,
    extra: Record<string, unknown> = {}
  ) => ({ id, ctl, atl, ...extra });

  it("computes form as CTL - ATL and rounds to one decimal", () => {
    const { series } = fitnessSeries(
      [record("2024-06-01", 50.44, 60.46)],
      "2024-06-10"
    );
    expect(series).toEqual([
      { date: "2024-06-01", ctl: 50.4, atl: 60.5, form: -10 },
    ]);
  });

  it("sorts ascending by date whatever order it is given", () => {
    const { series } = fitnessSeries(
      [
        record("2024-06-03", 3, 1),
        record("2024-06-01", 1, 1),
        record("2024-06-02", 2, 1),
      ],
      "2024-06-10"
    );
    expect(series.map((p) => p.date)).toEqual([
      "2024-06-01",
      "2024-06-02",
      "2024-06-03",
    ]);
  });

  it("drops days with no fitness data rather than zero-filling them", () => {
    const { count, series } = fitnessSeries(
      [
        record("2024-06-01", 50, 40),
        record("2024-06-02", null, null),
        record("2024-06-03", null, 30),
      ],
      "2024-06-10"
    );
    expect(count).toBe(2);
    expect(series.map((p) => p.date)).toEqual(["2024-06-01", "2024-06-03"]);
    // One half of the model present: reported, but no form to compute.
    expect(series[1]).toEqual({ date: "2024-06-03", atl: 30 });
  });

  it("flags days after today as projected and leaves the rest unmarked", () => {
    const { series } = fitnessSeries(
      [
        record("2024-06-09", 50, 40),
        record("2024-06-10", 51, 41),
        record("2024-06-11", 52, 42),
      ],
      "2024-06-10"
    );
    expect(series.map((p) => p.projected)).toEqual([
      undefined,
      undefined,
      true,
    ]);
  });

  it("summarises the ends of the range, and today when it is in range", () => {
    const { summary } = fitnessSeries(
      [
        record("2024-06-01", 50, 40),
        record("2024-06-10", 55, 45),
        record("2024-06-20", 60, 50),
      ],
      "2024-06-10"
    );
    expect(summary.oldest).toMatchObject({ date: "2024-06-01" });
    expect(summary.today).toMatchObject({ date: "2024-06-10", form: 10 });
    expect(summary.newest).toMatchObject({ date: "2024-06-20" });
  });

  it("omits today from the summary when the range does not reach it", () => {
    const { summary } = fitnessSeries(
      [record("2024-06-01", 50, 40)],
      "2024-06-10"
    );
    expect(summary).not.toHaveProperty("today");
  });

  it("returns an empty series for a payload that is not a list", () => {
    expect(fitnessSeries(null, "2024-06-10")).toEqual({
      count: 0,
      series: [],
      summary: {},
    });
  });

  it("carries the load pair through when present", () => {
    const { series } = fitnessSeries(
      [record("2024-06-01", 50, 40, { ctlLoad: 70.44, atlLoad: 80.46 })],
      "2024-06-10"
    );
    expect(series[0]).toMatchObject({ ctl_load: 70.4, atl_load: 80.5 });
  });
});
