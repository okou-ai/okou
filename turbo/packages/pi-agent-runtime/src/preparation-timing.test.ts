import { describe, expect, it } from "vitest";

import {
  measurePiPreparation,
  type PiPreparationObservation,
} from "./preparation-timing";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let settleHeldWork: (() => void) | undefined;
  // The executor runs synchronously, so the holder is set before any caller
  // can release it.
  const promise = new Promise<void>((settle) => {
    settleHeldWork = () => {
      settle();
    };
  });
  return {
    promise,
    resolve: () => {
      settleHeldWork?.();
    },
  };
}

describe("Pi preparation phase observations", () => {
  it("reports work that finishes after the attempt aborts as cancelled", async () => {
    const observed: PiPreparationObservation[] = [];
    const controller = new AbortController();
    const release = deferred();
    const measured = measurePiPreparation(
      (observation) => {
        observed.push(observation);
      },
      "credentials_revalidate",
      async () => {
        await release.promise;
        return "revalidated";
      },
      controller.signal,
    );
    // Work in flight is not a completion, so nothing may be reported yet.
    expect(observed).toStrictEqual([]);

    controller.abort();
    release.resolve();

    await expect(measured).resolves.toBe("revalidated");
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      phase: "credentials_revalidate",
      outcome: "cancelled",
    });
    expect(observed[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(observed[0]?.finishedAt).toBeGreaterThanOrEqual(
      observed[0]?.startedAt ?? Number.POSITIVE_INFINITY,
    );
  });

  it("leaves a step that never ran without any observation", async () => {
    const observed: PiPreparationObservation[] = [];
    const observer = (observation: PiPreparationObservation) => {
      observed.push(observation);
    };
    await measurePiPreparation(observer, "activation_authorize", () => {
      return Promise.resolve("authorized");
    });
    // The second step is skipped, as native-input/large-history transfer and an
    // earlier failure skip it in production. A zero-duration placeholder would
    // make reconstruction read a skipped step as a step that cost nothing, so
    // the phase must be absent entirely.
    expect(
      observed.map((observation) => {
        return observation.phase;
      }),
    ).toStrictEqual(["activation_authorize"]);
  });

  it("keeps a failing step's own error and outcome authoritative", async () => {
    const observed: PiPreparationObservation[] = [];
    const failure = new Error("credential source unavailable");
    await expect(
      measurePiPreparation(
        (observation) => {
          observed.push(observation);
          throw new Error("observer failure must stay contained");
        },
        "credentials_revalidate",
        () => {
          return Promise.reject(failure);
        },
      ),
    ).rejects.toBe(failure);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      phase: "credentials_revalidate",
      outcome: "error",
    });
  });
});
