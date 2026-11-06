import { once } from "node:events";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { object, uuid } from "zod";
import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { browserRoutes } from "../browser";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import {
  createSharedBrowserFixtures,
  PROVIDER_URL,
} from "./helpers/browser-shared-fixture";

const context = testContext();
const { fixture, profileProvider, view } = createSharedBrowserFixtures(context);
type Chat = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["start"]>>;
function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}
function use(chat: Chat) {
  return client().use({
    headers: { authorization: `Bearer ${okouTokenFromClaim(chat.claim)}` },
    body: {},
  });
}

describe("server-owned shared Browser recovery", () => {
  it("publishes one owner instance and cleans only the losing profile during concurrent first opens", async () => {
    const both = createDeferredPromise<void>(context.signal);
    let arrivals = 0;
    const f = await fixture(
      true,
      profileProvider(async () => {
        if (++arrivals === 2) {
          both.resolve();
        }
        await both.promise;
      }),
    );
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      const results = await Promise.all([use(a), use(b)]);
      expect(
        results
          .map((result) => {
            return result.status;
          })
          .sort(),
      ).toStrictEqual([200, 409]);
      expect(f.provider.createdIds).toHaveLength(2);
      expect(f.provider.sessionRequests).toHaveLength(1);
      const { profileId } = object({ profileId: uuid() }).parse(
        f.provider.sessionRequests[0],
      );
      for (const id of f.provider.createdIds) {
        expect((await fetch(`${PROVIDER_URL}/profiles/${id}`)).status).toBe(
          id === profileId ? 200 : 404,
        );
      }
    });
  });

  it("cancels a losing profile cleanup at its real deadline without deleting the winner", async () => {
    const both = createDeferredPromise<void>(context.signal);
    const deleting = createDeferredPromise<string>(context.signal);
    const cancelled = createDeferredPromise<void>(context.signal);
    let arrivals = 0;
    const f = await fixture(
      true,
      profileProvider(async () => {
        if (++arrivals === 2) {
          both.resolve();
        }
        await both.promise;
      }),
    );
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      server.use(
        http.delete(
          `${PROVIDER_URL}/profiles/:id`,
          async ({ params, request }) => {
            deleting.resolve(String(params.id));
            if (!request.signal.aborted) {
              await once(request.signal, "abort", { signal: context.signal });
            }
            cancelled.resolve();
            return HttpResponse.error();
          },
        ),
      );
      const opening = settleIncludingAbort(Promise.all([use(a), use(b)]));
      const checks = await settleIncludingAbort(async () => {
        const [result, deletedProfileId] = await Promise.all([
          opening,
          deleting.promise,
          cancelled.promise,
        ]);
        if (!result.ok) {
          throw result.error;
        }
        const results = result.value;
        expect(
          results
            .map((response) => {
              return response.status;
            })
            .sort(),
        ).toStrictEqual([200, 502]);
        expect(results).toContainEqual(
          expect.objectContaining({
            status: 502,
            body: expect.objectContaining({
              error: expect.objectContaining({ code: "BROWSER_USE_TIMEOUT" }),
            }),
          }),
        );
        const winner = results.find((response) => {
          return response.status === 200;
        });
        if (!winner || winner.status !== 200) {
          throw new Error("Expected one successful Browser open");
        }
        expect(f.provider.createdIds).toHaveLength(2);
        expect(f.provider.sessionRequests).toHaveLength(1);
        const { profileId } = object({ profileId: uuid() }).parse(
          f.provider.sessionRequests[0],
        );
        expect(deletedProfileId).not.toBe(profileId);
        expect(
          (await fetch(`${PROVIDER_URL}/profiles/${profileId}`)).status,
        ).toBe(200);
        await expect(
          view(results[0].status === 200 ? a : b),
        ).resolves.toMatchObject({
          status: "active",
          window: winner.body.browser.window,
        });
      });
      await opening;
      if (!checks.ok) {
        throw checks.error;
      }
    });
  }, 20_000);

  it("cleans an unadopted profile after the Run ends during preparation", async () => {
    const created = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const f = await fixture(
      true,
      profileProvider(async () => {
        created.resolve();
        await release.promise;
      }),
    );
    await f.owned.run(async () => {
      const a = await f.start();
      const opening = settleIncludingAbort(use(a));
      const ended = await settleIncludingAbort(async () => {
        await created.promise;
        await createWebhookCallbackApi(context).requestAgentComplete(
          {
            runId: a.runId,
            exitCode: 1,
            error: "Run ended during preparation",
          },
          { authorization: `Bearer ${a.claim.sandboxToken}` },
          [200],
        );
      });
      release.resolve();
      const result = await opening;
      if (!ended.ok) {
        throw ended.error;
      }
      if (!result.ok) {
        throw result.error;
      }
      expect(result.value.status).toBe(409);
      expect(f.provider.sessionRequests).toHaveLength(0);
      for (const id of f.provider.createdIds) {
        expect((await fetch(`${PROVIDER_URL}/profiles/${id}`)).status).toBe(
          404,
        );
      }
    });
  });
});
