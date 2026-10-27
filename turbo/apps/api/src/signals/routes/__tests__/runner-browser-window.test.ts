import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockNow } from "../../../lib/time";
import { createDeferredPromise } from "../../utils";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  createRunnerBrowserFixtures,
  MINUTE,
  START,
} from "./helpers/runner-browser-fixture";

const context = testContext();
const { fixture, allocate, accepted } = createRunnerBrowserFixtures(context);

describe("native owner Browser window admission", () => {
  it("creates a native window and reuses its current binding without another candidate", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const chat = await f.start();
      const instance = await allocate(chat);
      const first = accepted(
        await chat.request({ kind: "admit", instanceId: instance.id }),
      );
      expect(first.window).toMatchObject({
        chatThreadId: chat.threadId,
        primaryWindowId: f.provider.native.created[0]?.windowId,
        state: "active",
      });
      const repeated = accepted(
        await chat.request({ kind: "admit", instanceId: instance.id }),
      );
      expect(repeated.window).toStrictEqual(first.window);
      expect(f.provider.native.targets.size).toBe(1);
      expect(f.provider.native.created).toHaveLength(1);
      expect(JSON.stringify(repeated)).not.toMatch(/cdpUrl|liveUrl|token/u);
    });
  });

  it("reuses a registered window beyond a large sibling target inventory", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const chat = await f.start();
      const instance = await allocate(chat);
      const first = accepted(
        await chat.request({ kind: "admit", instanceId: instance.id }),
      );
      const owned = f.provider.native.created[0];
      if (!owned) {
        throw new Error("Expected the native admission candidate");
      }
      f.provider.native.targets.clear();
      for (let index = 0; index < 602; index += 1) {
        const targetId = randomUUID().replaceAll("-", "");
        f.provider.native.targets.set(targetId, {
          targetId,
          windowId: owned.windowId + index + 1,
        });
      }
      f.provider.native.targets.set(owned.targetId, owned);
      const repeated = accepted(
        await chat.request({ kind: "admit", instanceId: instance.id }),
      );
      expect(repeated.window).toStrictEqual(first.window);
      expect(f.provider.native.created).toHaveLength(1);
      expect(f.provider.native.targets.size).toBe(603);
    });
  });

  it.each([true, false])(
    "uses a confirmed native window witness and preserves unresolved lookup failures: %s",
    async (hasWitness) => {
      const f = await fixture();
      await f.owned.run(async () => {
        const chat = await f.start();
        const instance = await allocate(chat);
        const first = accepted(
          await chat.request({ kind: "admit", instanceId: instance.id }),
        );
        if (!hasWitness) {
          f.provider.native.targets.clear();
        }
        const targetId = randomUUID().replaceAll("-", "");
        f.provider.native.targets.set(targetId, { targetId, windowId: 100 });
        f.provider.native.windowErrors.set(targetId, "Provider lookup denied");
        const repeated = await chat.control({
          kind: "admit",
          instanceId: instance.id,
        });
        if (hasWitness) {
          expect(repeated.status).toBe(200);
          expect(repeated.body).toMatchObject({
            outcome: "accepted",
            instance: { window: first.window },
          });
        } else {
          expect(repeated.status).toBe(502);
        }
        expect(f.provider.native.created).toHaveLength(1);
      });
    },
  );

  it.each(["closed", "moved", "already-gone", "close-failed"] as const)(
    "arbitrates native candidates with %s loser cleanup",
    async (cleanup) => {
      const f = await fixture();
      await f.owned.run(async () => {
        const chat = await f.start();
        const instance = await allocate(chat);
        const both = createDeferredPromise<void>(context.signal);
        let arrivals = 0;
        f.provider.native.beforeCreateReply = async () => {
          if (++arrivals === 2) {
            both.resolve();
          }
          await both.promise;
        };
        const lookups = new Map<string, number>();
        f.provider.native.beforeWindowReply = async (targetId) => {
          const count = (lookups.get(targetId) ?? 0) + 1;
          lookups.set(targetId, count);
          if (count !== 2) {
            return;
          }
          if (cleanup === "already-gone") {
            f.provider.native.targets.delete(targetId);
          } else if (cleanup === "moved") {
            const winner = accepted(await chat.request({ kind: "inspect" }));
            const target = f.provider.native.targets.get(targetId);
            if (!target || !winner.window) {
              throw new Error("Expected the published native winner");
            }
            target.windowId = winner.window.primaryWindowId;
          } else if (cleanup === "close-failed") {
            f.provider.native.closeSucceeds = false;
          }
        };
        const results = await Promise.all([
          chat.control({ kind: "admit", instanceId: instance.id }),
          chat.control({ kind: "admit", instanceId: instance.id }),
        ]);
        const acceptedResults = results.filter((result) => {
          return result.status === 200 && result.body.outcome === "accepted";
        });
        expect(acceptedResults).toHaveLength(1);
        const winner = accepted(await chat.request({ kind: "inspect" }));
        expect(winner.window?.state).toBe("active");
        expect(f.provider.native.created).toHaveLength(2);
        expect(
          [...f.provider.native.targets.values()].some((target) => {
            return target.windowId === winner.window?.primaryWindowId;
          }),
        ).toBeTruthy();
        if (cleanup === "close-failed") {
          expect(
            results
              .map((result) => {
                return result.status;
              })
              .sort(),
          ).toStrictEqual([200, 502]);
          expect(f.provider.native.targets.size).toBe(2);
        } else {
          expect(
            results.every((result) => {
              return result.status === 200;
            }),
          ).toBeTruthy();
          expect(f.provider.native.targets.size).toBe(
            cleanup === "moved" ? 2 : 1,
          );
        }
        expect(f.provider.native.closed).toHaveLength(
          cleanup === "closed" ? 1 : 0,
        );
      });
    },
  );

  it("cleans its exact native candidate when final stop wins before registration", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const chat = await f.start();
      const instance = await allocate(chat);
      f.provider.native.beforeCreateReply = async () => {
        accepted(
          await chat.request({ kind: "beginStop", instanceId: instance.id }),
        );
      };
      await expect(
        chat.request({ kind: "admit", instanceId: instance.id }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      expect(f.provider.native.targets.size).toBe(0);
      expect(f.provider.native.closed).toHaveLength(1);
      expect(accepted(await chat.request({ kind: "inspect" }))).toMatchObject({
        status: "stopping",
        window: null,
      });
    });
  });

  it("does not reuse a window retired while native membership inspection was pending", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const chat = await f.start();
      const instance = await allocate(chat);
      const current = accepted(
        await chat.request({ kind: "admit", instanceId: instance.id }),
      );
      if (!current.window) {
        throw new Error("Expected a registered native window");
      }
      const primaryWindowId = current.window.primaryWindowId;
      f.provider.native.beforeWindowReply = async () => {
        accepted(
          await chat.request({
            kind: "retire",
            instanceId: instance.id,
            primaryWindowId,
            reason: "closed",
          }),
        );
      };
      await expect(
        chat.request({ kind: "admit", instanceId: instance.id }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      expect(
        accepted(await chat.request({ kind: "inspect" })).window,
      ).toMatchObject({ state: "closing", primaryWindowId });
      expect(f.provider.native.created).toHaveLength(1);
    });
  });

  it.each(["missing", "expired"] as const)(
    "requires lifecycle recovery for a %s registered window",
    async (state) => {
      const f = await fixture();
      await f.owned.run(async () => {
        const chat = await f.start();
        const instance = await allocate(chat);
        accepted(
          await chat.request({ kind: "admit", instanceId: instance.id }),
        );
        if (state === "missing") {
          f.provider.native.targets.clear();
        } else {
          mockNow(START + 10 * MINUTE);
        }
        await expect(
          chat.request({ kind: "admit", instanceId: instance.id }),
        ).resolves.toStrictEqual({ outcome: "unavailable" });
        expect(f.provider.native.created).toHaveLength(1);
      });
    },
  );

  it("reports protocol failure without publishing a window or exposing provider data", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const chat = await f.start();
      const instance = await allocate(chat);
      f.provider.native.windowError = "private native diagnostic token=secret";
      const result = await chat.control({
        kind: "admit",
        instanceId: instance.id,
      });
      expect(result.status).toBe(502);
      expect(JSON.stringify(result.body)).not.toMatch(
        /private|token=secret|wss:/u,
      );
      expect(
        accepted(await chat.request({ kind: "inspect" })).window,
      ).toBeNull();
      expect(f.provider.native.closed).toHaveLength(0);
      expect(f.provider.native.created).toHaveLength(1);
    });
  });

  it.each(["disconnect", "deadline"] as const)(
    "does not replay an uncertain native creation after %s",
    async (failure) => {
      const f = await fixture();
      await f.owned.run(async () => {
        const chat = await f.start();
        const instance = await allocate(chat);
        if (failure === "disconnect") {
          f.provider.native.createReply = "disconnect";
        } else {
          const deadline = new AbortController();
          context.mocks.abortSignal.timeout.mockReturnValueOnce(
            deadline.signal,
          );
          f.provider.native.createReply = "withhold";
          f.provider.native.beforeCreateReply = () => {
            deadline.abort(
              new DOMException("Owned native deadline", "TimeoutError"),
            );
          };
        }
        const result = await chat.control({
          kind: "admit",
          instanceId: instance.id,
        });
        context.mocks.abortSignal.timeout.mockReset();
        expect(result.status).toBe(failure === "disconnect" ? 502 : 503);
        expect(result.body).toMatchObject({
          error: {
            code:
              failure === "disconnect"
                ? "BROWSER_USE_WINDOW_CREATION_UNCERTAIN"
                : "BROWSER_USE_TIMEOUT",
          },
        });
        expect(
          accepted(await chat.request({ kind: "inspect" })).window,
        ).toBeNull();
        expect(f.provider.native.created).toHaveLength(1);
        expect(f.provider.native.targets.size).toBe(1);
        expect(f.provider.native.closed).toHaveLength(0);
      });
    },
  );

  it("rejects admission without creating native targets when the owner switch is off", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const chat = await f.start();
      const instance = await allocate(chat);
      await updateFeatureSwitchesForUser(context, f.featureActor, {
        [FeatureSwitchKey.BrowserSharedOwner]: false,
      });
      for (const instanceId of [instance.id, randomUUID()]) {
        await expect(
          chat.request({ kind: "admit", instanceId }),
        ).resolves.toStrictEqual({ outcome: "unavailable" });
      }
      expect(f.provider.native.targets.size).toBe(0);
      expect(accepted(await chat.request({ kind: "inspect" })).id).toBe(
        instance.id,
      );
    });
  });
});
