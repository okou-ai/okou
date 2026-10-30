import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { object, uuid } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { browserRoutes } from "../browser";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import {
  createSharedBrowserFixtures,
  MINUTE,
  PROVIDER_URL,
  START,
} from "./helpers/browser-shared-fixture";

const context = testContext();
const { fixture, profileProvider, open, view, renew } =
  createSharedBrowserFixtures(context);
type Chat = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["start"]>>;
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
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
  it("bounds a silent native close and reopens without stopping its active sibling", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      const first = await open(a);
      const sibling = await open(b);
      const page = [...f.provider.native.targets.values()].find((target) => {
        return target.windowId === first.window?.primaryWindowId;
      });
      if (!page) {
        throw new Error("Expected A's native page");
      }
      page.url = "https://a.example.test/native-close-recovery";
      mockNow(START + 9 * MINUTE);
      const leased = await renew(b);
      mockNow(START + 11 * MINUTE);
      f.provider.native.closeReply = "withhold";
      const reopened = await open(a);
      expect(f.provider.native.targets.get(page.targetId)).toStrictEqual(page);
      expect((await view(b)).window).toStrictEqual(sibling.window);
      expect((await view(b)).idleExpiresAt).toBe(leased.idleExpiresAt);
      expect(f.provider.stoppedSessionIds.size).toBe(0);
      expect(f.provider.sessionRequests).toHaveLength(1);

      f.provider.native.closeReply = "reply";
      expect(reopened.window?.instanceId).toBe(first.window?.instanceId);
      expect(reopened.window?.primaryWindowId).not.toBe(
        first.window?.primaryWindowId,
      );
      expect(
        [...f.provider.native.targets.values()]
          .filter((target) => {
            return target.windowId === reopened.window?.primaryWindowId;
          })
          .map((target) => {
            return target.url;
          }),
      ).toStrictEqual(["https://a.example.test/native-close-recovery"]);
      expect((await view(b)).window).toStrictEqual(sibling.window);
      expect((await view(b)).idleExpiresAt).toBe(leased.idleExpiresAt);
      expect(f.provider.sessionRequests).toHaveLength(1);
    });
  }, 20_000);

  it("preserves an accepted profile on lookup failure and replaces it only after confirmed deletion", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      await open(a);
      const [profileId] = f.provider.createdIds;
      const page = [...f.provider.native.targets.values()][0];
      if (!profileId || !page) {
        throw new Error("Expected an accepted provider profile and page");
      }
      page.url = "https://a.example.test/restored";
      let deleted = false;
      server.use(
        http.get(`${PROVIDER_URL}/profiles/${profileId}`, () => {
          return HttpResponse.json(
            { detail: "Profile unavailable" },
            { status: deleted ? 404 : 503 },
          );
        }),
      );
      mockNow(START + 11 * MINUTE);
      expect((await use(a)).status).toBe(502);
      expect(f.provider.createdIds).toHaveLength(1);
      expect(f.provider.sessionRequests).toHaveLength(1);
      deleted = true;
      await open(a);
      expect(f.provider.createdIds).toHaveLength(2);
      expect(f.provider.sessionRequests[1]).toMatchObject({
        profileId: f.provider.createdIds[1],
      });
      expect(
        [...f.provider.native.targets.values()].map((target) => {
          return target.url;
        }),
      ).toStrictEqual(["https://a.example.test/restored"]);
    });
  });

  it("preserves another owner's accepted profile when the provider repeats its identity", async () => {
    const provider = profileProvider();
    const first = await fixture(true, provider);
    installBrowserWindowContentCommands(provider.native);
    const a = await first.start();
    await first.owned.run(() => {
      return open(a);
    });
    const [profileId] = provider.createdIds;
    if (!profileId) {
      throw new Error("Expected the first owner's profile");
    }
    const second = await fixture(true, provider);
    server.use(
      http.post(`${PROVIDER_URL}/profiles`, () => {
        return HttpResponse.json(provider.profile(profileId), { status: 201 });
      }),
    );
    await second.owned.run(async () => {
      const b = await second.start();
      await expect(use(b)).resolves.toMatchObject({
        status: 502,
        body: { error: { code: "BROWSER_USE_INVALID_RESPONSE" } },
      });
      expect(
        (await fetch(`${PROVIDER_URL}/profiles/${profileId}`)).status,
      ).toBe(200);
      expect(provider.stoppedSessionIds.size).toBe(0);
    });
    await first.owned.run(async () => {
      expect((await open(a)).status).toBe("active");
    });
  });

  it("preserves an accepted legacy instance when provider correlation repeats its ID", async () => {
    const provider = profileProvider();
    installBrowserWindowContentCommands(provider.native);
    const legacy = await fixture(false, provider);
    const legacyChat = await legacy.start();
    await legacy.owned.run(() => {
      return open(legacyChat);
    });
    const [legacyId] = provider.sessionIds;
    if (!legacyId) {
      throw new Error("Expected the legacy instance");
    }
    const shared = await fixture(true, provider);
    await shared.owned.run(async () => {
      const a = await shared.start();
      let instanceId: string | null = null;
      server.use(
        http.post(`${PROVIDER_URL}/browsers`, async ({ request }) => {
          const input: unknown = await request.json();
          instanceId = object({
            metadata: object({ okouInstanceId: uuid() }),
          }).parse(input).metadata.okouInstanceId;
          return HttpResponse.error();
        }),
        http.get(`${PROVIDER_URL}/browsers`, () => {
          return HttpResponse.json({
            items: [{ id: legacyId, metadata: { okouInstanceId: instanceId } }],
            totalItems: 1,
          });
        }),
      );
      expect((await use(a)).status).toBe(502);
      mockNow(START + 2 * MINUTE);
      expect((await use(a)).status).toBe(409);
      expect(provider.sessionIds.has(legacyId)).toBeTruthy();
      expect(provider.stoppedSessionIds.size).toBe(0);
    });
    await legacy.owned.run(async () => {
      expect((await open(legacyChat)).status).toBe("active");
    });
  });

  it("finishes snapshot-ready final retirement through confirmed provider stop when native close fails", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const first = await open(a);
      const page = [...f.provider.native.targets.values()][0];
      if (!page) {
        throw new Error("Expected the initial page");
      }
      page.url = "https://a.example.test/first";
      const secondId = randomUUID();
      f.provider.native.targets.set(secondId, {
        targetId: secondId,
        windowId: page.windowId,
        url: "https://a.example.test/second",
      });
      f.provider.native.closeSucceeds = false;
      server.use(
        http.patch(`${PROVIDER_URL}/browsers/:id`, () => {
          f.provider.native.closeSucceeds = true;
          return;
        }),
      );
      mockNow(START + 11 * MINUTE);
      const reopened = await open(a);
      expect(reopened.window?.instanceId).not.toBe(first.window?.instanceId);
      expect(f.provider.stoppedSessionIds.size).toBe(1);
      expect(f.provider.sessionRequests).toHaveLength(2);
      expect(
        [...f.provider.native.targets.values()].map((target) => {
          return target.url;
        }),
      ).toStrictEqual([
        "https://a.example.test/first",
        "https://a.example.test/second",
      ]);
    });
  });

  it("recovers a lost create response only after finding its exact provider identity", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const lostId = randomUUID();
      let loseResponse = true;
      let visible = false;
      server.use(
        http.post(`${PROVIDER_URL}/browsers`, async ({ request }) => {
          if (!loseResponse) {
            return;
          }
          loseResponse = false;
          const input: unknown = await request.json();
          const { metadata } = object({
            metadata: object({ okouInstanceId: uuid() }),
          }).parse(input);
          f.provider.sessionRequests.push(input);
          f.provider.sessionIds.add(lostId);
          f.provider.sessionMetadata.set(lostId, metadata);
          return HttpResponse.error();
        }),
        http.get(`${PROVIDER_URL}/browsers`, () => {
          if (visible) {
            return;
          }
          return HttpResponse.json({
            items: [],
            totalItems: 0,
            pageNumber: 1,
            pageSize: 2,
          });
        }),
      );
      expect((await use(a)).status).toBe(502);
      expect((await use(a)).status).toBe(409);
      mockNow(START + 2 * MINUTE);
      expect((await use(a)).status).toBe(409);
      expect(f.provider.sessionRequests).toHaveLength(1);
      expect(f.provider.stoppedSessionIds.size).toBe(0);
      visible = true;
      const recovered = await open(a);
      expect(f.provider.stoppedSessionIds.has(lostId)).toBeTruthy();
      expect(f.provider.createdIds).toHaveLength(1);
      expect(f.provider.sessionRequests).toHaveLength(2);
      expect(f.provider.sessionRequests[1]).toMatchObject({
        profileId: f.provider.createdIds[0],
        metadata: { okouInstanceId: recovered.window?.instanceId },
      });
      expect(recovered.window?.instanceId).not.toBe(
        f.provider.sessionMetadata.get(lostId)?.okouInstanceId,
      );
    });
  });

  it("rejects ambiguous provider correlation without stopping an unrelated Browser", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start();
      let creates = 0;
      server.use(
        http.post(`${PROVIDER_URL}/browsers`, () => {
          creates += 1;
          return HttpResponse.error();
        }),
        http.get(`${PROVIDER_URL}/browsers`, () => {
          return HttpResponse.json({
            items: [
              { id: randomUUID(), metadata: { okouInstanceId: randomUUID() } },
            ],
            totalItems: 1,
          });
        }),
      );
      expect((await use(a)).status).toBe(502);
      mockNow(START + 2 * MINUTE);
      expect((await use(a)).status).toBe(409);
      expect(creates).toBe(1);
      expect(f.provider.stoppedSessionIds.size).toBe(0);
    });
  });

  it("does not renew a missing native window and restores it without disturbing its sibling", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      const first = await open(a);
      const sibling = await open(b);
      const page = [...f.provider.native.targets.values()].find((target) => {
        return target.windowId === first.window?.primaryWindowId;
      });
      if (!page) {
        throw new Error("Expected A's native page");
      }
      page.url = "https://a.example.test/recovered";
      await accept(
        client().close({ headers, params: { threadId: a.threadId }, body: {} }),
        [200],
      );
      f.provider.native.targets.delete(page.targetId);
      mockNow(START + MINUTE);
      const lease = await client().leaseByThread({
        headers,
        params: { threadId: a.threadId },
        body: {},
      });
      expect(lease.status).toBe(409);
      expect((await view(a)).status).toBe("suspended");
      const recovered = await open(a);
      expect(recovered.window?.instanceId).toBe(first.window?.instanceId);
      expect(recovered.window?.primaryWindowId).not.toBe(
        first.window?.primaryWindowId,
      );
      expect((await view(b)).idleExpiresAt).toBe(sibling.idleExpiresAt);
      expect(f.provider.sessionRequests).toHaveLength(1);
      expect(
        [...f.provider.native.targets.values()]
          .filter((target) => {
            return target.windowId === recovered.window?.primaryWindowId;
          })
          .map((target) => {
            return target.url;
          }),
      ).toStrictEqual(["https://a.example.test/recovered"]);
    });
  });

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
