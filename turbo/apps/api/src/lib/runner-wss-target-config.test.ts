import { describe, expect, it } from "vitest";

import {
  supportsMandatoryWssListener,
  wssOriginFromRunnerHostname,
  wssMinimumRunnerVersionSchema,
} from "./runner-wss-target-config";

describe("WSS target provisioning", () => {
  it("uses the configured Runner hostname as the canonical WSS origin", () => {
    expect(wssOriginFromRunnerHostname("runner-a.example.com")).toBe(
      "wss://runner-a.example.com:443",
    );
    expect(wssOriginFromRunnerHostname("r1.us-east.example.com")).toBe(
      "wss://r1.us-east.example.com:443",
    );
  });

  it("rejects unsafe or non-public hostname representations", () => {
    for (const hostname of [
      "",
      "localhost",
      "runner.localhost",
      "127.0.0.1",
      "RUNNER-a.example.com",
      "runner.example.com.",
      "runner.example.com:443",
      "runner.example.com/ws/id",
      "runner.example.com?ticket=x",
      "user@runner.example.com",
      "runner..example.com",
      "runner.example.com ",
      "-runner.example.com",
      `a.${"b".repeat(64)}.example.com`,
      `${"a".repeat(62)}.${"b".repeat(62)}.${"c".repeat(62)}.${"d".repeat(62)}.com`,
    ]) {
      expect(wssOriginFromRunnerHostname(hostname), hostname).toBeNull();
    }
  });

  it("compares exact safe release numbers, not lexical versions", () => {
    expect(wssMinimumRunnerVersionSchema.safeParse("0.214.0").success).toBe(
      true,
    );
    for (const version of [
      "0.214",
      "0.214.0-rc1",
      "00.214.0",
      "0.999999999999999999999.0",
      "0.214.0 ",
    ]) {
      expect(wssMinimumRunnerVersionSchema.safeParse(version).success).toBe(
        false,
      );
    }
    expect(supportsMandatoryWssListener("0.213.99", "0.214.0")).toBe(false);
    expect(supportsMandatoryWssListener("0.214.0", "0.214.0")).toBe(true);
    expect(supportsMandatoryWssListener("0.214.10", "0.214.2")).toBe(true);
    expect(supportsMandatoryWssListener("0.215.0", "0.214.2")).toBe(true);
    expect(supportsMandatoryWssListener("1.0.0", "0.214.2")).toBe(false);
    expect(supportsMandatoryWssListener("0.214.2-dev", "0.214.2")).toBe(false);
  });
});
