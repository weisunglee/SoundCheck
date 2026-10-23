// Which streaming software a connection attempt tries, and in what order.
import { describe, expect, it } from "vitest";
import { type SoftwarePresence, connectionOrder } from "./connection";

const seen = (obs: [boolean, boolean], streamlabs: [boolean, boolean]): SoftwarePresence => ({
  obs: { running: obs[0], ready: obs[1] },
  streamlabs: { running: streamlabs[0], ready: streamlabs[1] },
});

describe("connectionOrder", () => {
  it("tries only the software the user picked", () => {
    expect(connectionOrder("streamlabs", seen([true, true], [false, false]))).toEqual(["streamlabs"]);
    expect(connectionOrder("obs", seen([false, false], [true, true]))).toEqual(["obs"]);
  });
  it("in auto mode, tries OBS when Streamlabs isn't ready, so the guide points at OBS", () => {
    expect(connectionOrder("auto", seen([false, false], [false, false]))).toEqual(["obs"]);
    expect(connectionOrder("auto", seen([false, false], [true, false]))).toEqual(["obs"]);
  });
  it("in auto mode, goes straight to Streamlabs when only it is running", () => {
    expect(connectionOrder("auto", seen([false, false], [true, true]))).toEqual(["streamlabs"]);
  });
  it("in auto mode, prefers OBS when both are running", () => {
    expect(connectionOrder("auto", seen([true, false], [true, true]))).toEqual(["obs", "streamlabs"]);
  });
});
