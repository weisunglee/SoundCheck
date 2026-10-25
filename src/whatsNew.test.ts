// Which "what's new" notice shows: the newest one not closed yet, and only one at a time.
import { describe, expect, it } from "vitest";
import { type Notice, NOTICES, compareVersions, pickNotice } from "./whatsNew";

const notice = (version: string): Notice => ({ version, title: version, body: "" });

describe("compareVersions", () => {
  it("compares numerically, part by part", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.4.0", "0.5.0")).toBeLessThan(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });
});

describe("pickNotice", () => {
  const list = [notice("0.5.0"), notice("0.6.0")];
  it("shows the newest one when nothing was seen (0.4.0 stored nothing, fresh installs too)", () => {
    expect(pickNotice(list, null)?.version).toBe("0.6.0");
  });
  it("shows a newer one after an older one was closed", () => {
    expect(pickNotice(list, "0.5.0")?.version).toBe("0.6.0");
  });
  it("shows nothing once the newest was closed", () => {
    expect(pickNotice(list, "0.6.0")).toBeNull();
    expect(pickNotice([], null)).toBeNull();
  });
  it("starts with the voice tuning notice", () => {
    expect(pickNotice(NOTICES, null)?.action).toBe("voiceTuning");
  });
});
