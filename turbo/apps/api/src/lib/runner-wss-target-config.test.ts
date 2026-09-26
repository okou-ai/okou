import { describe, expect, it } from "vitest";

import {
  supportsMandatoryWssListener,
  wssHostOriginsSchema,
  wssMinimumRunnerVersionSchema,
} from "./runner-wss-target-config";

describe("WSS target provisioning", () => {
  it("accepts only a canonical, explicitly ported DNS WSS origin", () => {
    const mapping = [
      {
        inventoryHostname: "runner-a.example.com",
        publicOrigin: "wss://runner-a-wss.example.com:443",
      },
    ];
    expect(wssHostOriginsSchema.parse(mapping)).toStrictEqual(mapping);
    for (const origin of [
      "ws://runner-a-wss.example.com:443",
      "wss://runner-a-wss.example.com",
      "wss://runner-a-wss.example.com:8443",
      "wss://runner-a-wss.example.com:443/ws/id",
      "wss://runner-a-wss.example.com:443?ticket=x",
      "wss://user@runner-a-wss.example.com:443",
      "wss://127.0.0.1:443",
      "wss://localhost:443",
      "wss://RUNNER-a.example.com:443",
      "wss://runner-a.example.com.:443",
      "wss://runner-a.example.com:443#fragment",
      `wss://${"a".repeat(62)}.${"b".repeat(62)}.${"c".repeat(62)}.${"d".repeat(62)}.com:443`,
    ]) {
      expect(
        wssHostOriginsSchema.safeParse([
          { inventoryHostname: "runner-a.example.com", publicOrigin: origin },
        ]).success,
        origin,
      ).toBe(false);
    }
  });

  it("rejects duplicate and ambiguous inventory keys", () => {
    expect(wssHostOriginsSchema.safeParse("{").success).toBe(false);
    expect(
      wssHostOriginsSchema.safeParse([
        {
          inventoryHostname: "runner-a.example.com",
          publicOrigin: "wss://a.example.com:443",
        },
        {
          inventoryHostname: "runner-a.example.com",
          publicOrigin: "wss://b.example.com:443",
        },
      ]).success,
    ).toBe(false);
    for (const inventoryHostname of [
      "../runner",
      "runner..example.com",
      "Runner.example.com",
      "runner.example.com ",
    ]) {
      expect(
        wssHostOriginsSchema.safeParse([
          { inventoryHostname, publicOrigin: "wss://a.example.com:443" },
        ]).success,
      ).toBe(false);
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
