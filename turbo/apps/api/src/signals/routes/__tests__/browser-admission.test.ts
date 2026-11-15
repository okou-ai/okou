import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { describe, expect, it } from "vitest";
import { http } from "msw";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { browserRoutes } from "../browser";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import { okouTokenFromExecution } from "./helpers/chat-events-fixture";
import {
  createBrowserFixtures,
  MINUTE,
  PROVIDER_URL,
  START,
} from "./helpers/browser-fixture";

const context = testContext();
const { fixture, view } = createBrowserFixtures(context);
type Chat = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["start"]>>;
function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}
function runHeaders(chat: Chat) {
  return { authorization: `Bearer ${okouTokenFromExecution(chat.execution)}` };
}
async function use(chat: Chat) {
  return (
    await accept(client().use({ headers: runHeaders(chat), body: {} }), [200])
  ).body;
}

describe("shared Browser public consumers", () => {
  it("bounds a silent initial-window lookup and recovers through confirmed instance cleanup", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      f.provider.native.windowReply = "withhold";
      await expect(
        client().use({ headers: runHeaders(a), body: {} }),
      ).resolves.toMatchObject({
        status: 503,
        body: { error: { code: "BROWSER_USE_TIMEOUT" } },
      });
      expect(f.provider.sessionRequests).toHaveLength(1);
      expect(f.provider.stoppedSessionIds.size).toBe(0);

      f.provider.native.windowReply = "reply";
      const retry = await client().use({ headers: runHeaders(a), body: {} });
      expect({
        status: retry.status,
        windows: new Set(
          [...f.provider.native.targets.values()].map((target) => {
            return target.windowId;
          }),
        ).size,
      }).toStrictEqual({ status: 409, windows: 1 });
      expect(f.provider.sessionRequests).toHaveLength(1);
      mockNow(START + 2 * MINUTE);
      const recovered = await use(a);
      expect(recovered.browser.status).toBe("active");
      expect((await view(a)).window).toStrictEqual(recovered.browser.window);
      expect(f.provider.createdIds).toHaveLength(1);
      expect(f.provider.sessionRequests).toHaveLength(2);
      expect(f.provider.stoppedSessionIds.size).toBe(1);
      expect([...f.provider.native.targets.values()]).toMatchObject([
        { windowId: recovered.browser.window?.primaryWindowId },
      ]);
    });
  }, 20_000);

  it("waits for the first window before admitting a sibling into a newly published instance", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      let hold = true;
      server.use(
        http.get(`${PROVIDER_URL}/browsers/:id`, async ({ params }) => {
          if (hold && f.provider.sessionIds.has(String(params.id))) {
            hold = false;
            entered.resolve();
            await release.promise;
          }
          return;
        }),
      );
      const opening = settleIncludingAbort(
        accept(client().use({ headers: runHeaders(a), body: {} }), [200]),
      );
      const waiting = await settleIncludingAbort(async () => {
        await Promise.race([
          entered.promise,
          opening.then((result) => {
            if (!result.ok) {
              throw result.error;
            }
            throw new Error("The first open never reached its provider read");
          }),
        ]);
        expect(
          (await client().use({ headers: runHeaders(b), body: {} })).status,
        ).toBe(409);
        expect([...f.provider.native.targets.values()]).toHaveLength(1);
        expect(f.provider.sessionRequests).toHaveLength(1);
      });
      if (!release.settled()) {
        release.resolve();
      }
      const completed = await opening;
      if (!waiting.ok) {
        throw waiting.error;
      }
      if (!completed.ok) {
        throw completed.error;
      }
      const first = completed.value.body.browser;
      const sibling = (await use(b)).browser;
      expect(sibling.window?.instanceId).toBe(first.window?.instanceId);
      expect(sibling.window?.primaryWindowId).not.toBe(
        first.window?.primaryWindowId,
      );
      expect(
        new Set(
          [...f.provider.native.targets.values()].map((target) => {
            return target.windowId;
          }),
        ),
      ).toStrictEqual(
        new Set([
          first.window?.primaryWindowId,
          sibling.window?.primaryWindowId,
        ]),
      );
      expect(f.provider.createdIds).toHaveLength(1);
      expect(f.provider.sessionRequests).toHaveLength(1);
    });
  });
});
