import { describe, expect, it } from "vitest";

import { piModelConfigObservation } from "../pi-model-config-observation";

// This secret-safe projection accepts historical/future captured shapes that
// current production admission cannot construct. Route tests cover new writes;
// this finite boundary matrix proves arbitrary input never becomes telemetry.
describe("Pi captured-config observation boundary", () => {
  it.each([
    [{}, 1],
    [{ schemaVersion: 2 }, 2],
    [{ schemaVersion: 3 }, 3],
    [{ schemaVersion: 4 }, 4],
    [{ schemaVersion: 5 }, "unknown"],
    [{ schemaVersion: "private-version" }, "unknown"],
  ] as const)(
    "classifies captured generation %j as %s",
    (config, generation) => {
      expect(
        piModelConfigObservation("pi", {
          ...config,
          apiKey: "private-key",
          accountId: "private-account",
          baseUrl: "https://private-gateway.test",
          headers: { Authorization: "private-token" },
          prompt: "private-prompt",
        }),
      ).toStrictEqual({ piModelConfigGeneration: generation });
    },
  );

  it.each([undefined, null, [], "private-config"])(
    "reports an unavailable captured config as unknown: %j",
    (config) => {
      expect(piModelConfigObservation("pi", config)).toStrictEqual({
        piModelConfigGeneration: "unknown",
      });
    },
  );

  it.each([undefined, "codex", "claude-code"])(
    "leaves non-Pi snapshots unclassified: %s",
    (cliAgentType) => {
      expect(piModelConfigObservation(cliAgentType, {})).toBeUndefined();
    },
  );
});
