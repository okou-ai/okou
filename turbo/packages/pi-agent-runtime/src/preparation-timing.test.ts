import { describe, expect, it } from "vitest";

import {
  measurePiPreparation,
  type PiPreparationObservation,
} from "./preparation-timing";

describe("Pi preparation phase observations", () => {
  it("reports work that finishes after the attempt aborts as cancelled", async () => {
    const observed: PiPreparationObservation[] = [];
    const controller = new AbortController();
    const measured = measurePiPreparation(
      (observation) => {
        observed.push(observation);
      },
      "model_runtime",
      () => {
        expect(observed).toStrictEqual([]);
        controller.abort();
        return "prepared";
      },
      controller.signal,
    );
    await expect(measured).resolves.toBe("prepared");
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      phase: "model_runtime",
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
    await measurePiPreparation(observer, "launch", () => {
      return Promise.resolve("launched");
    });
    // A second preparation step that never ran has no observation. A placeholder would
    // make reconstruction read a skipped step as a step that cost nothing, so
    // the phase must be absent entirely.
    expect(
      observed.map((observation) => {
        return observation.phase;
      }),
    ).toStrictEqual(["launch"]);
  });

  it("keeps a failing step's own error and outcome authoritative", async () => {
    const observed: PiPreparationObservation[] = [];
    const failure = new Error("model runtime unavailable");
    await expect(
      measurePiPreparation(
        (observation) => {
          observed.push(observation);
          throw new Error("observer failure must stay contained");
        },
        "model_runtime",
        () => {
          return Promise.reject(failure);
        },
      ),
    ).rejects.toBe(failure);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      phase: "model_runtime",
      outcome: "error",
    });
  });
});
