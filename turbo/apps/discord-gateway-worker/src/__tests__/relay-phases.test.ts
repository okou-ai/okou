import { describe, expect, it } from "vitest";
import { createRelayPhases } from "./relay-phases";

describe("Relay test phase diagnostics", () => {
  it("records completion and preserves the awaited result", async ({
    signal,
  }) => {
    const { elapsedMs, phases, wait } = createRelayPhases(signal);
    const result = { op: 2 };
    expect(
      await wait("Identify", () => {
        return Promise.resolve(result);
      }),
    ).toBe(result);
    expect(phases).toEqual([
      {
        name: "Identify",
        startedAtMs: expect.any(Number),
        completedAtMs: expect.any(Number),
      },
    ]);
    for (const phase of phases) {
      expect(phase.startedAtMs).toBeGreaterThanOrEqual(0);
      expect(phase.completedAtMs).toBeGreaterThanOrEqual(phase.startedAtMs);
      expect(elapsedMs()).toBeGreaterThanOrEqual(phase.startedAtMs);
    }
  });

  it("propagates a failed task without completing its phase", async ({
    signal,
  }) => {
    const { phases, wait } = createRelayPhases(signal);
    const failure = new Error("Gateway closed");
    await expect(
      wait("Identify", () => {
        return Promise.reject(failure);
      }),
    ).rejects.toBe(failure);
    expect(phases).toEqual([
      {
        name: "Identify",
        startedAtMs: expect.any(Number),
        completedAtMs: null,
      },
    ]);
  });

  it("does not start or record a phase when already canceled", async () => {
    const reason = new Error("Test canceled");
    const { phases, wait } = createRelayPhases(AbortSignal.abort(reason));
    let started = false;
    await expect(
      wait("Identify", () => {
        started = true;
        return Promise.resolve(2);
      }),
    ).rejects.toBe(reason);
    expect(started).toBe(false);
    expect(phases).toEqual([]);
  });

  it("retains the canceled phase when pending I/O settles after cancellation", async () => {
    const controller = new AbortController();
    const { phases, wait } = createRelayPhases(controller.signal);
    const response = Promise.withResolvers<number>();
    const reason = new Error("Test canceled");
    let continued = false;
    const flow = async () => {
      const opcode = await wait("Identify", () => {
        return response.promise;
      });
      continued = true;
      await wait("delivery", () => {
        return Promise.resolve(opcode);
      });
    };
    const work = flow();
    const rejected = expect(work).rejects.toBe(reason);
    controller.abort(reason);
    response.resolve(2);
    await rejected;
    expect(continued).toBe(false);
    expect(phases).toEqual([
      {
        name: "Identify",
        startedAtMs: expect.any(Number),
        completedAtMs: null,
      },
    ]);
  });
});
