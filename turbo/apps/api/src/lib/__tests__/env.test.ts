import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { stubTestEnvSnapshotInputs } from "../../__tests__/env-stub";

async function loadEnvironment() {
  // A module reload models a replacement instance with new startup inputs.
  vi.resetModules();
  return await import("../env");
}

afterEach(() => {
  vi.resetModules();
});

describe("API environment lifetime", () => {
  it("keeps validated and optional startup inputs until the instance is replaced", async () => {
    onTestFinished(
      stubTestEnvSnapshotInputs({ debug: "startup", optional: "startup" }),
    );
    const original = await loadEnvironment();

    onTestFinished(
      stubTestEnvSnapshotInputs({
        debug: "replacement",
        optional: "replacement",
      }),
    );
    expect(original.env("OKOU_DEBUG")).toBe("startup");
    expect(original.optionalEnv("OPTIONAL_ENV_SNAPSHOT")).toBe("startup");

    const replacement = await loadEnvironment();
    expect(replacement.env("OKOU_DEBUG")).toBe("replacement");
    expect(replacement.optionalEnv("OPTIONAL_ENV_SNAPSHOT")).toBe(
      "replacement",
    );
  });

  it.each([
    { processValue: "process", packedValue: "packed", expected: "process" },
    { processValue: "", packedValue: "packed", expected: "packed" },
    { processValue: undefined, packedValue: "packed", expected: "packed" },
    { processValue: "", packedValue: "", expected: undefined },
    { processValue: undefined, packedValue: "", expected: undefined },
  ])(
    "preserves optional precedence for process=$processValue and packed=$packedValue",
    async ({ processValue, packedValue, expected }) => {
      onTestFinished(
        stubTestEnvSnapshotInputs({
          optional: processValue,
          packed: packedValue,
        }),
      );
      const environment = await loadEnvironment();
      expect(environment.optionalEnv("OPTIONAL_ENV_SNAPSHOT")).toBe(expected);
    },
  );

  it("isolates derived values with supported env overrides and clearing", async () => {
    onTestFinished(
      stubTestEnvSnapshotInputs({ debug: "startup", optional: "startup" }),
    );
    const environment = await loadEnvironment();
    const configuration = environment.envSingleton(() => {
      return {
        debug: environment.env("OKOU_DEBUG"),
        optional: environment.optionalEnv("OPTIONAL_ENV_SNAPSHOT"),
      };
    });
    const original = configuration();
    expect(configuration()).toBe(original);

    environment.mockEnv("OKOU_DEBUG", "override");
    const overridden = configuration();
    expect(overridden).toStrictEqual({
      debug: "override",
      optional: "startup",
    });
    expect(overridden).not.toBe(original);

    environment.mockOptionalEnv("OPTIONAL_ENV_SNAPSHOT", undefined);
    expect(configuration()).toStrictEqual({
      debug: "override",
      optional: undefined,
    });

    environment.clearMockedEnv();
    expect(configuration()).toStrictEqual({
      debug: "startup",
      optional: "startup",
    });
    expect(configuration()).not.toBe(original);
  });

  it("retains an absent derived configuration until its scope is replaced", async () => {
    const environment = await loadEnvironment();
    let reads = 0;
    const configuration = environment.envSingleton(() => {
      reads += 1;
      return undefined;
    });
    expect(configuration()).toBeUndefined();
    expect(configuration()).toBeUndefined();
    expect(reads).toBe(1);

    environment.clearMockedEnv();
    expect(configuration()).toBeUndefined();
    expect(reads).toBe(2);
  });
});
