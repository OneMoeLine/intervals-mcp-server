import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServer,
  isValidTimeZone,
  localToday,
  parseDeleteMode,
} from "../src/server.js";

describe("parseDeleteMode", () => {
  it("defaults to safe and ignores case", () => {
    expect(parseDeleteMode(undefined)).toBe("safe");
    expect(parseDeleteMode("FULL")).toBe("full");
    expect(parseDeleteMode("none")).toBe("none");
  });

  it("rejects anything else", () => {
    expect(parseDeleteMode("wipe-everything")).toBeUndefined();
    expect(parseDeleteMode("")).toBeUndefined();
  });
});

describe("localToday", () => {
  afterEach(() => vi.useRealTimers());

  it("answers in the athlete's zone, not the host's", () => {
    // 03:00 UTC on 1 May is still 30 April in Chicago and already 1 May in
    // Tokyo - the case a UTC-hosted server would get wrong in the evening.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T03:00:00Z"));
    expect(localToday("America/Chicago")).toBe("2026-04-30");
    expect(localToday("Asia/Tokyo")).toBe("2026-05-01");
    expect(localToday("UTC")).toBe("2026-05-01");
  });

  it("validates zone names", () => {
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
  });
});

describe("createServer", () => {
  it("builds independent servers for different users", () => {
    // Per-request construction is what the hosted Worker does; reusing the
    // cached schemas across instances must not tie them together.
    const a = createServer({ apiKey: "a", athleteId: "i1", deleteMode: "safe" });
    const b = createServer({ apiKey: "b", athleteId: "i2", deleteMode: "none" });
    expect(a).not.toBe(b);
  });
});
