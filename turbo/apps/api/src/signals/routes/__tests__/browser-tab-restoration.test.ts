import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { cronBrowserReconcileContract } from "@okouai/api-contracts/contracts/cron";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { browserRoutes } from "../browser";
import { cronBrowserReconcileRoutes } from "../cron-browser-reconcile";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  createSharedBrowserFixtures,
  MINUTE,
  START,
} from "./helpers/browser-shared-fixture";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";

const context = testContext();
const { fixture } = createSharedBrowserFixtures(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

describe("complete Browser tab snapshots", () => {
  it.each(["malformed", "missing"])(
    "retains the accepted snapshot when a live tab child identity is %s",
    async (fault) => {
      await setupApp({ context, routes: browserRoutes, isolatePg: true });
      const f = await fixture();
      await f.owned.run(async () => {
        installBrowserWindowContentCommands(f.provider.native);
        const chat = await f.start();
        const use = async () => {
          return (
            await accept(
              client().use({
                headers: {
                  authorization: `Bearer ${okouTokenFromClaim(chat.claim)}`,
                },
                body: {},
              }),
              [200],
            )
          ).body;
        };
        const first = await use();
        const windowId = first.browser.window!.primaryWindowId;
        const page = [...f.provider.native.targets.values()].find((target) => {
          return target.windowId === windowId;
        })!;
        const close = (status: 200 | 502 = 200) => {
          return accept(
            client().close({
              headers,
              params: { threadId: chat.threadId },
              body: {},
            }),
            [status],
          );
        };
        page.url = "https://accepted.example.test/";
        await close();
        page.url = "https://unconfirmed.example.test/";
        if (fault === "malformed") {
          f.provider.native.tabChildInfo = { targetId: 42, type: "page" };
        } else {
          f.provider.native.omitTabChild = true;
        }
        await close(502);
        for (const [id, target] of f.provider.native.targets) {
          if (target.windowId === windowId) {
            f.provider.native.targets.delete(id);
          }
        }
        await accept(
          client().use({
            headers: {
              authorization: `Bearer ${okouTokenFromClaim(chat.claim)}`,
            },
            body: {},
          }),
          [502],
        );
        expect([...f.provider.native.targets.values()]).toHaveLength(0);
        f.provider.native.tabChildInfo = undefined;
        f.provider.native.omitTabChild = false;
        mockNow(START + 11 * MINUTE);
        await accept(
          setupApp({ context, routes: cronBrowserReconcileRoutes })(
            cronBrowserReconcileContract,
          ).reconcile({
            headers: { authorization: "Bearer test-cron-secret" },
          }),
          [200],
        );
        await flushWaitUntilForTest();
        const reopened = await use();
        expect(reopened.browser.window).not.toStrictEqual(first.browser.window);
        expect(
          [...f.provider.native.targets.values()]
            .filter((target) => {
              return (
                target.windowId === reopened.browser.window!.primaryWindowId
              );
            })
            .map((target) => {
              return target.url;
            }),
        ).toStrictEqual(["https://accepted.example.test/"]);
      });
    },
  );

  it.each([false, true])(
    "appends heartbeat order atomically without reordering existing tabs with shared=%s",
    async (shared) => {
      const f = await fixture(shared);
      await f.owned.run(async () => {
        const chat = await f.start();
        const first = (
          await accept(
            client().use({
              headers: {
                authorization: `Bearer ${okouTokenFromClaim(chat.claim)}`,
              },
              body: {},
            }),
            [200],
          )
        ).body;
        const binding = (
          await accept(
            client().viewerConnection({
              headers,
              params: { threadId: chat.threadId },
            }),
            [200],
          )
        ).body.tabOrder!;
        const target = (id: string) => {
          return {
            targetId: id,
            windowId: first.browser.window?.primaryWindowId ?? 0,
            url: "https://same.example.test/",
          };
        };
        for (const id of ["own-b", "own-a", "own-c", "own-d"]) {
          f.provider.native.targets.set(id, target(id));
        }
        const report = (targetIds: string[]) => {
          return accept(
            client().leaseByThread({
              headers,
              params: { threadId: chat.threadId },
              body: { tabOrder: { ...binding, targetIds } },
            }),
            [200],
          );
        };
        await report(["own-b", "own-a", "own-b"]);
        const read = async () => {
          return (
            await accept(
              client().viewerConnection({
                headers,
                params: { threadId: chat.threadId },
              }),
              [200],
            )
          ).body.tabOrder!;
        };
        expect(
          (await read()).targetIds.filter((id) => {
            return id.startsWith("own-");
          }),
        ).toStrictEqual(["own-b", "own-a"]);
        await Promise.all([
          report(["own-b", "own-a", "own-c"]),
          report(["own-b", "own-a", "own-c", "own-d"]),
        ]);
        await report(["own-d", "own-c", "own-a", "own-b"]);
        expect(
          (await read()).targetIds.filter((id) => {
            return id.startsWith("own-");
          }),
        ).toStrictEqual(["own-b", "own-a", "own-c", "own-d"]);
        const saved = await read();
        await accept(
          client().leaseByThread({
            headers,
            params: { threadId: chat.threadId },
            body: {
              tabOrder: {
                ...binding,
                instanceId: "99999999-9999-4999-8999-999999999999",
                targetIds: ["foreign-order"],
              },
            },
          }),
          [200],
        );
        await expect(read()).resolves.toStrictEqual(saved);
      });
    },
  );

  it.each([false, true])(
    "restores ordered blank, internal and duplicate URLs beyond 50 tabs with shared=%s",
    async (shared) => {
      await setupApp({ context, routes: browserRoutes, isolatePg: true });
      const f = await fixture(shared);
      await f.owned.run(async () => {
        installBrowserWindowContentCommands(f.provider.native);
        const chat = await f.start();
        const runHeaders = {
          authorization: `Bearer ${okouTokenFromClaim(chat.claim)}`,
        };
        const use = async () => {
          return (
            await accept(client().use({ headers: runHeaders, body: {} }), [200])
          ).body;
        };
        const first = await use();
        if (shared) {
          const sibling = await f.start();
          await accept(
            client().use({
              headers: {
                authorization: `Bearer ${okouTokenFromClaim(sibling.claim)}`,
              },
              body: {},
            }),
            [200],
          );
        }
        const originalWindowId = first.browser.window?.primaryWindowId ?? 0;
        const viewer = (
          await accept(
            client().viewerConnection({
              headers,
              params: { threadId: chat.threadId },
            }),
            [200],
          )
        ).body;
        expect(viewer.tabOrder).toBeDefined();
        const urls = [
          "about:blank",
          "chrome://newtab/",
          "https://duplicate.example.test/",
          "https://duplicate.example.test/",
          ...Array.from({ length: 55 }, (_, index) => {
            return `https://ordered.example.test/${index}`;
          }),
          "chrome://version/",
          "data:text/plain,restored",
          "about:blank",
        ];
        for (const [id, target] of f.provider.native.targets) {
          if (target.windowId === originalWindowId) {
            f.provider.native.targets.delete(id);
          }
        }
        // Provider enumeration deliberately differs from the native strip positions.
        const positions = urls
          .map((_, index) => {
            return index;
          })
          .reverse();
        for (const index of positions) {
          const targetId = `snapshot-page-${index}`;
          f.provider.native.targets.set(targetId, {
            targetId,
            windowId: originalWindowId,
            // Both provider enumeration and native positions disagree with our sequence.
            index: urls.length - 1 - index,
            url: urls[index]!,
          });
        }
        await accept(
          client().close({
            headers,
            params: { threadId: chat.threadId },
            body: {
              tabOrder: {
                ...viewer.tabOrder!,
                targetIds: urls.map((_, index) => {
                  return `snapshot-page-${index}`;
                }),
              },
            },
          }),
          [200],
        );
        if (shared) {
          for (const [id, target] of f.provider.native.targets) {
            if (target.windowId === originalWindowId) {
              f.provider.native.targets.delete(id);
            }
          }
          const reopened = await use();
          expect(reopened.browser.window?.instanceId).toBe(
            first.browser.window?.instanceId,
          );
          const reopenedId = reopened.browser.window?.primaryWindowId;
          expect(reopenedId).not.toBe(originalWindowId);
          const recovered = (
            await accept(
              client().viewerConnection({
                headers,
                params: { threadId: chat.threadId },
              }),
              [200],
            )
          ).body.tabOrder;
          await accept(
            client().leaseByThread({
              headers,
              params: { threadId: chat.threadId },
              body: {
                tabOrder: {
                  ...viewer.tabOrder!,
                  targetIds: ["stale-window-target"],
                },
              },
            }),
            [200],
          );
          expect(
            (
              await accept(
                client().viewerConnection({
                  headers,
                  params: { threadId: chat.threadId },
                }),
                [200],
              )
            ).body.tabOrder,
          ).toStrictEqual(recovered);
          expect(
            [...f.provider.native.targets.values()]
              .filter((target) => {
                return target.windowId === reopenedId;
              })
              .map((target) => {
                return target.url;
              }),
          ).toStrictEqual(urls);
        }
        // The live snapshot already has native identities, so a discarded page
        // retains its position even when CDP no longer lists its page target.
        const discarded = [...f.provider.native.targets.values()].filter(
          (target) => {
            return target.url === "https://duplicate.example.test/";
          },
        )[1];
        expect(discarded).toBeDefined();
        if (shared) {
          discarded!.discarded = true;
        }
        mockNow(START + 11 * MINUTE);
        // Idle reconciliation is the production owner of legacy snapshot capture.
        const retired = await accept(
          setupApp({ context, routes: cronBrowserReconcileRoutes })(
            cronBrowserReconcileContract,
          ).reconcile({
            headers: { authorization: "Bearer test-cron-secret" },
          }),
          [200],
        );
        expect(retired.body.stopped).toBeGreaterThan(0);
        await flushWaitUntilForTest();
        const reconstructed = await use();
        expect(reconstructed.cdpUrl).toBeTruthy();
        expect(f.provider.sessionRequests).toHaveLength(2);
        expect(
          [...f.provider.native.targets.values()].map((target) => {
            return target.url;
          }),
        ).toStrictEqual(urls);
        const restoredViewer = (
          await accept(
            client().viewerConnection({
              headers,
              params: { threadId: chat.threadId },
            }),
            [200],
          )
        ).body;
        const savedOrder = restoredViewer.tabOrder!;
        expect(
          savedOrder.targetIds.map((id) => {
            return f.provider.native.targets.get(id)?.url;
          }),
        ).toStrictEqual(urls);
        // A delayed heartbeat from the retired physical Browser cannot change it.
        await accept(
          client().leaseByThread({
            headers,
            params: { threadId: chat.threadId },
            body: {
              tabOrder: { ...viewer.tabOrder!, targetIds: ["stale-target"] },
            },
          }),
          [200],
        );
        const afterStale = (
          await accept(
            client().viewerConnection({
              headers,
              params: { threadId: chat.threadId },
            }),
            [200],
          )
        ).body;
        expect(afterStale.tabOrder).toStrictEqual(savedOrder);
        // After reconstruction both modes have native bindings. A later
        // discarded page must not change the saved URL array's positions.
        const restoredDiscarded = f.provider.native.targets.get(
          savedOrder.targetIds[3]!,
        );
        expect(restoredDiscarded).toBeDefined();
        f.provider.native.discard(restoredDiscarded!.targetId);
        mockNow(START + 22 * MINUTE);
        await accept(
          setupApp({ context, routes: cronBrowserReconcileRoutes })(
            cronBrowserReconcileContract,
          ).reconcile({
            headers: { authorization: "Bearer test-cron-secret" },
          }),
          [200],
        );
        await flushWaitUntilForTest();
        await use();
        expect(
          [...f.provider.native.targets.values()].map((target) => {
            return target.url;
          }),
        ).toStrictEqual(urls);
      });
    },
  );
});
