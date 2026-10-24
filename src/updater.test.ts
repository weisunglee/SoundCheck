// What the update prompt shows and when the check at start asks.
import { describe, expect, it } from "vitest";
import { notesSummary, promptAtStart, releasePage } from "./updater";

describe("promptAtStart", () => {
  it("asks about a version unless the user skipped that one", () => {
    expect(promptAtStart("0.4.0", null)).toBe(true);
    expect(promptAtStart("0.4.0", "0.4.0")).toBe(false);
  });
  it("asks again when a newer version than the skipped one comes out", () => {
    expect(promptAtStart("0.4.1", "0.4.0")).toBe(true);
  });
});

describe("notesSummary", () => {
  it("keeps short notes whole, without extra blank lines", () => {
    expect(notesSummary("Fixes\r\n\r\n\r\n\r\nMore fixes\n")).toBe("Fixes\n\nMore fixes");
    expect(notesSummary(undefined)).toBe("");
  });
  it("cuts long notes at a line end", () => {
    const notes = `${"a".repeat(30)}\n${"b".repeat(30)}\n${"c".repeat(30)}`;
    expect(notesSummary(notes, 70)).toBe(`${"a".repeat(30)}\n${"b".repeat(30)}…`);
  });
  it("cuts a long single line mid-way", () => {
    expect(notesSummary("x".repeat(100), 10)).toBe(`${"x".repeat(10)}…`);
  });
});

describe("releasePage", () => {
  it("points at the version's tag, or the latest release", () => {
    expect(releasePage("0.4.0")).toBe("https://github.com/weisunglee/SoundCheck/releases/tag/v0.4.0");
    expect(releasePage()).toBe("https://github.com/weisunglee/SoundCheck/releases/latest");
  });
});
