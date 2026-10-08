import { describe, expect, it } from "vitest";

import { wssOriginFromRunnerHostname } from "./runner-wss-target-config";

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
      "runner.local",
      "runner.internal",
      "runner.home.arpa",
      "runner.invalid",
      "runner.test",
      "runner.example",
      "127.0.0.1",
      "127.1",
      "0x7f.1",
      "0177.1",
      "0x7f.0x1",
      "1.2.3",
      "example.123",
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
});
