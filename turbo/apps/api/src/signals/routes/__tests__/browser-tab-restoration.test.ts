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
  it.each([false, true])(
    "restores ordered blank, internal and duplicate URLs beyond 50 tabs with shared=%s",
    async (shared) => {
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
            index,
            url: urls[index]!,
          });
        }
        await accept(
          client().close({
            headers,
            params: { threadId: chat.threadId },
            body: {},
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
      });
    },
  );
});
