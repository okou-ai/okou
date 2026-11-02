import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { browserUserActionsContract } from "@okouai/api-contracts/contracts/browser-user-actions";
import { TEST_BROWSER_EXTENSION } from "../../../__tests__/browser-extension";
import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { browserUserActionRoutes } from "../browser-user-actions";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  createSharedBrowserFixtures,
  MINUTE,
  PROVIDER_URL,
  START,
} from "./helpers/browser-shared-fixture";

const context = testContext();
const { fixture, open, view, renew } = createSharedBrowserFixtures(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function client() {
  return setupApp({ context, routes: browserUserActionRoutes })(
    browserUserActionsContract,
  );
}

async function scenario(f: Awaited<ReturnType<typeof fixture>>) {
  await updateFeatureSwitchesForUser(context, f.featureActor, {
    [FeatureSwitchKey.BrowserNativeInput]: true,
  });
  const a = await f.start();
  installBrowserWindowContentCommands(f.provider.native);
  const first = await open(a);
  const aWindow = first.window;
  f.provider.native.windowIds.splice(0, f.provider.native.windowIds.length, 17);
  const b = await f.start();
  const bWindow = (await open(b)).window;
  if (!aWindow || !bWindow) {
    throw new Error("Expected assigned native windows");
  }
  const instance = {
    id: aWindow.instanceId,
    providerProfileId: f.provider.createdIds[0],
    providerSessionId: [...f.provider.sessionIds][0],
  };
  const aPage = f.provider.native.created[0];
  const bPage = f.provider.native.created[1];
  if (!aPage || !bPage) {
    throw new Error("Expected two admitted native pages");
  }
  aPage.url = "https://accounts.example.test/login?code=private-page-code";
  bPage.url = aPage.url;
  const state = {
    kind: "password" as "password" | "file",
    values: new Map<string, string>(),
    files: [{ name: "old.txt", type: "text/plain", size: 4 }],
    writes: 0,
    afterInspection: undefined as (() => void) | undefined,
    afterWrite: undefined as (() => void) | undefined,
  };
  function executeControl(
    command: { readonly params: Readonly<Record<string, unknown>> },
    targetId: string,
  ) {
    const declaration = String(command.params.functionDeclaration);
    const args = Array.isArray(command.params.arguments)
      ? command.params.arguments
      : [];
    const first: unknown = args[0];
    const value =
      typeof first === "object" && first !== null && "value" in first
        ? first.value
        : undefined;
    if (declaration.includes("supportedInputTypes")) {
      state.afterInspection?.();
      return {
        result: {
          value: [
            {
              tagName: "INPUT",
              inputType: state.kind,
              connected: true,
              mainDocument: true,
              writable: true,
              siteRequired: false,
              multiple: false,
              ...(state.kind === "file"
                ? { accept: "text/plain", files: state.files }
                : {}),
            },
          ],
        },
      };
    }
    if (
      declaration.includes("firstSpec") ||
      declaration.includes("new DataTransfer")
    ) {
      if (
        typeof value === "object" &&
        value !== null &&
        "verifyOnly" in value &&
        value.verifyOnly === true
      ) {
        return { result: { value: true } };
      }
      state.writes += 1;
      if (state.kind === "file") {
        state.files = [];
      } else if (
        typeof value === "object" &&
        value !== null &&
        "value" in value &&
        typeof value.value === "string"
      ) {
        state.values.set(targetId, value.value);
      }
      state.afterWrite?.();
      return { result: { value: true } };
    }
    return { result: { value: true } };
  }
  installBrowserWindowContentCommands(f.provider.native);
  const content = f.provider.native.command;
  if (!content) {
    throw new Error("Expected external native content commands");
  }
  f.provider.native.command = (command) => {
    const targetId =
      command.sessionId?.replace(/^page-/u, "") ?? aPage.targetId;
    if (command.method === "Target.attachToTarget") {
      return content(command);
    }
    if (command.method === "Page.getFrameTree") {
      return {
        frameTree: {
          frame: {
            id: "main-frame",
            loaderId: `loader-${targetId}`,
            url: aPage.url,
          },
        },
      };
    }
    if (command.method === "DOM.resolveNode") {
      return {
        object: { objectId: "input-control", type: "object", subtype: "node" },
      };
    }
    if (command.method === "Page.createIsolatedWorld") {
      return { executionContextId: 1 };
    }
    if (command.method === "Runtime.callFunctionOn") {
      return executeControl(command, targetId);
    }
    if (command.method === "Runtime.evaluate") {
      return content(command);
    }
    return {};
  };
  const ownedPageTargetId = aPage.targetId;
  async function create(chat = a, pageTargetId = ownedPageTargetId) {
    return await client().create({
      headers: { authorization: `Bearer ${okouTokenFromClaim(chat.claim)}` },
      body: {
        kind: "input",
        title: "Complete the website form",
        reason: "The website requires these values to continue the task.",
        callbackPrompt: "Continue after the website value is applied",
        pageTargetId,
        fields: [
          {
            key: "entry",
            label: "Website value",
            fieldKind: state.kind,
            required: state.kind !== "file",
            backendNodeId: 42,
          },
        ],
      },
    });
  }
  async function request() {
    const response = await accept(create(), [201]);
    expect(JSON.stringify(response.body)).not.toContain("private-page-code");
    expect(response.body.action).not.toHaveProperty("window");
    return { requestToken: response.body.action.requestToken };
  }
  return {
    a,
    b,
    instance,
    aWindow,
    bWindow,
    aPage,
    bPage,
    state,
    create,
    request,
  };
}

describe("shared-window native Browser input", () => {
  it("requires a shared window before creating input after shared mode is enabled", async () => {
    const f = await fixture(false);
    await f.owned.run(async () => {
      f.owned.ownsFeatureSwitches();
      await updateFeatureSwitchesForUser(context, f.featureActor, {
        [FeatureSwitchKey.BrowserNativeInput]: true,
        [FeatureSwitchKey.BrowserSharedOwner]: false,
      });
      const a = await f.start();
      await open(a);
      const [providerSessionId] = f.provider.sessionIds;
      const [page] = f.provider.native.targets.values();
      if (!providerSessionId || !page) {
        throw new Error("Expected a live legacy Browser");
      }
      await updateFeatureSwitchesForUser(context, f.featureActor, {
        [FeatureSwitchKey.BrowserSharedOwner]: true,
      });
      let legacyUnavailable = true;
      server.use(
        http.get(`${PROVIDER_URL}/browsers/${providerSessionId}`, () => {
          return legacyUnavailable
            ? HttpResponse.json(
                { detail: "Legacy provider unavailable" },
                { status: 503 },
              )
            : undefined;
        }),
      );
      const response = await client().create({
        headers: { authorization: `Bearer ${okouTokenFromClaim(a.claim)}` },
        body: {
          kind: "input",
          title: "Complete the website form",
          reason: "The website requires a password",
          callbackPrompt: "Continue after entering the password",
          pageTargetId: page.targetId,
          fields: [
            {
              key: "password",
              label: "Password",
              fieldKind: "password",
              required: true,
              backendNodeId: 42,
            },
          ],
        },
      });
      legacyUnavailable = false;
      expect(response).toMatchObject({
        status: 409,
        body: { error: { code: "BROWSER_USER_ACTION_BROWSER_NOT_LIVE" } },
      });
    });
  });

  it("preserves a newer window lease when input requests arrive with older timestamps", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const s = await scenario(f);
      mockNow(START + 2 * MINUTE);
      const params = await s.request();
      // Different API instances can arrive with an older captured timestamp.
      mockNow(START + MINUTE);
      await accept(client().preflight({ headers, params, body: {} }), [200]);
      expect(Date.parse(String((await view(s.a)).idleExpiresAt))).toBe(
        START + 12 * MINUTE,
      );
      await s.request();
      expect(Date.parse(String((await view(s.a)).idleExpiresAt))).toBe(
        START + 12 * MINUTE,
      );
      expect(Date.parse(String((await view(s.b)).idleExpiresAt))).toBe(
        START + 10 * MINUTE,
      );
    });
  });

  it("captures window zero and applies only the owned page without exposing sealed identities or values", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const s = await scenario(f);
      const params = await s.request();
      const preflight = await accept(
        client().preflight({ headers, params, body: {} }),
        [200],
      );
      expect(preflight.body.state).toBe("pending");
      const applied = await accept(
        client().apply({
          headers,
          params,
          body: { values: [{ key: "entry", value: "private-input-value" }] },
        }),
        [200],
      );
      expect(applied.body.state).toBe("succeeded");
      expect(s.state.values.get(s.aPage.targetId)).toBe("private-input-value");
      expect(s.state.values.has(s.bPage.targetId)).toBeFalsy();
      expect(JSON.stringify(applied.body)).not.toContain("private-");
      expect(s.state.writes).toBe(1);
      expect(
        (await accept(client().get({ headers, params }), [200])).body.state,
      ).toBe("succeeded");
      expect((await view(s.b)).window).toMatchObject({ primaryWindowId: 17 });
    });
  });

  it("rejects sibling capture and treats a moved page as stale without writing", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const s = await scenario(f);
      await expect(s.create(s.a, s.bPage.targetId)).resolves.toMatchObject({
        status: 409,
        body: { error: { code: "BROWSER_USER_ACTION_PAGE_TARGET_NOT_FOUND" } },
      });
      const params = await s.request();
      s.aPage.windowId = 17;
      expect(
        (await accept(client().preflight({ headers, params, body: {} }), [200]))
          .body.state,
      ).toBe("stale");
      expect(s.state.writes).toBe(0);
      s.aPage.windowId = 0;
      const second = await s.request();
      s.aPage.windowId = 17;
      expect(
        (
          await accept(
            client().apply({
              headers,
              params: second,
              body: { values: [{ key: "entry", value: "private-no-write" }] },
            }),
            [200],
          )
        ).body.state,
      ).toBe("stale");
      expect(s.state.writes).toBe(0);
    });
  });

  it("does not publish a request if the window expires during external validation while its sibling remains live", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const s = await scenario(f);
      mockNow(START + 9 * MINUTE);
      await renew(s.b);
      s.state.afterInspection = () => {
        mockNow(START + 11 * MINUTE);
      };
      expect((await s.create()).status).toBe(404);
      s.state.afterInspection = undefined;
      expect((await view(s.a)).status).toBe("suspended");
      expect(Date.parse(String((await view(s.b)).idleExpiresAt))).toBe(
        START + 19 * MINUTE,
      );
      expect(s.state.writes).toBe(0);
    });
  });

  it("expires A without reviving it through B's provider and accepts only a newly admitted A window", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const s = await scenario(f);
      const params = await s.request();
      mockNow(START + 9 * MINUTE);
      await renew(s.b);
      mockNow(START + 11 * MINUTE);
      expect(
        (await client().preflight({ headers, params, body: {} })).status,
      ).toBe(410);
      expect((await s.create()).status).toBe(409);
      const replacement = await open(s.a);
      const page = [...f.provider.native.targets.values()].find((target) => {
        return target.windowId === replacement.window?.primaryWindowId;
      });
      if (!page || !replacement.window) {
        throw new Error("Expected a replacement native window");
      }
      page.url = s.bPage.url;
      expect(
        (
          await client().apply({
            headers,
            params,
            body: { values: [{ key: "entry", value: "private-stale-value" }] },
          })
        ).status,
      ).toBe(410);
      const fresh = await accept(s.create(s.a, page.targetId), [201]);
      expect(
        (
          await accept(
            client().apply({
              headers,
              params: { requestToken: fresh.body.action.requestToken },
              body: { values: [{ key: "entry", value: "fresh-value" }] },
            }),
            [200],
          )
        ).body.state,
      ).toBe("succeeded");
      expect(s.state.values.get(page.targetId)).toBe("fresh-value");
      expect(s.state.values.has(s.bPage.targetId)).toBeFalsy();
      expect(Date.parse(String((await view(s.b)).idleExpiresAt))).toBe(
        START + 19 * MINUTE,
      );
    });
  });

  it("reports a move during a native write as uncertain and never replays it", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const s = await scenario(f);
      const params = await s.request();
      s.state.afterWrite = () => {
        s.aPage.windowId = 17;
      };
      expect(
        (
          await accept(
            client().apply({
              headers,
              params,
              body: {
                values: [{ key: "entry", value: "private-written-once" }],
              },
            }),
            [200],
          )
        ).body.state,
      ).toBe("uncertain");
      expect(s.state.writes).toBe(1);
      expect(
        (
          await client().apply({
            headers,
            params,
            body: { values: [{ key: "entry", value: "private-written-once" }] },
          })
        ).status,
      ).toBe(409);
      expect(s.state.writes).toBe(1);
    });
  });

  it("rejects an apply when retirement wins during its provider read", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const s = await scenario(f);
      const params = await s.request();
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      let hold = true;
      server.use(
        http.get(
          `${PROVIDER_URL}/browsers/${s.instance.providerSessionId}`,
          async () => {
            if (!hold) {
              return;
            }
            hold = false;
            entered.resolve();
            await release.promise;
            return HttpResponse.json({
              id: s.instance.providerSessionId,
              status: "active",
              startedAt: new Date(START).toISOString(),
              timeoutAt: new Date(START + 240 * MINUTE).toISOString(),
              finishedAt: null,
              cdpUrl: f.provider.native.url,
              extensions: [TEST_BROWSER_EXTENSION],
              liveUrl: "https://live.browser-use.com/owned-fixture",
            });
          },
        ),
      );
      const application = settleIncludingAbort(
        accept(
          client().apply({
            headers,
            params,
            body: {
              values: [{ key: "entry", value: "private-retired-value" }],
            },
          }),
          [200],
        ),
      );
      const retirement = await settleIncludingAbort(async () => {
        await Promise.race([
          entered.promise,
          application.then((result) => {
            if (!result.ok) {
              throw result.error;
            }
            throw new Error("The apply never reached its provider read");
          }),
        ]);
        mockNow(START + 9 * MINUTE);
        await renew(s.b);
        mockNow(START + 11 * MINUTE);
        await open(s.a);
      });
      if (!release.settled()) {
        release.resolve();
      }
      const completed = await application;
      if (!retirement.ok) {
        throw retirement.error;
      }
      if (!completed.ok) {
        throw completed.error;
      }
      expect(completed.value.body.state).toBe("stale");
      expect(s.state.writes).toBe(0);
      expect(s.state.values.size).toBe(0);
    });
  });

  it.each(["provider read", "native write"] as const)(
    "settles input before propagating application-lifetime cancellation during %s",
    async (phase) => {
      const f = await fixture();
      await f.owned.run(async () => {
        const s = await scenario(f);
        const params = await s.request();
        const controller = new AbortController();
        const cancellation = new DOMException(
          "The input application lifetime ended",
          "AbortError",
        );
        if (phase === "provider read") {
          server.use(
            http.get(
              `${PROVIDER_URL}/browsers/${s.instance.providerSessionId}`,
              () => {
                controller.abort(cancellation);
                return HttpResponse.json({
                  id: s.instance.providerSessionId,
                  status: "active",
                  startedAt: new Date(START).toISOString(),
                  timeoutAt: new Date(START + 240 * MINUTE).toISOString(),
                  finishedAt: null,
                  cdpUrl: f.provider.native.url,
                  extensions: [TEST_BROWSER_EXTENSION],
                  liveUrl: "https://live.browser-use.com/owned-fixture",
                });
              },
            ),
          );
        } else {
          s.state.afterWrite = () => {
            controller.abort(cancellation);
          };
        }
        const application = await settleIncludingAbort(
          setupApp({
            context,
            routes: browserUserActionRoutes,
            signal: AbortSignal.any([context.signal, controller.signal]),
            rethrowErrors: true,
          })(browserUserActionsContract).apply({
            headers,
            params,
            body: {
              values: [{ key: "entry", value: "private-cancelled-input" }],
            },
          }),
        );
        expect(application).toStrictEqual({ ok: false, error: cancellation });
        const observed = await accept(client().get({ headers, params }), [200]);
        expect(observed.body.state).toBe(
          phase === "provider read" ? "pending" : "uncertain",
        );
        expect(s.state.writes).toBe(phase === "provider read" ? 0 : 1);
      });
    },
  );

  it("keeps native lookup failures visible without invalidating or replaying the pending request", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const s = await scenario(f);
      const params = await s.request();
      f.provider.native.windowErrors.set(
        s.aPage.targetId,
        "private-provider-window-error",
      );
      const checked = await client().preflight({ headers, params, body: {} });
      expect(checked.status).toBe(502);
      expect(JSON.stringify(checked.body)).not.toContain("private-");
      expect(
        (await accept(client().get({ headers, params }), [200])).body.state,
      ).toBe("pending");
      expect(s.state.writes).toBe(0);
    });
  });

  it("does not adopt a replacement instance even when Chrome reuses the native window number", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const s = await scenario(f);
      const params = await s.request();
      mockNow(START + 11 * MINUTE);
      const next = await open(s.a);
      expect(next.window?.instanceId).not.toBe(s.instance.id);
      expect(f.provider.createdIds).toHaveLength(1);
      const page = [...f.provider.native.targets.values()].find((target) => {
        return target.windowId === 0;
      });
      if (!page) {
        throw new Error("Expected the new instance's page");
      }
      page.url = s.aPage.url;
      expect(
        (
          await client().apply({
            headers,
            params,
            body: { values: [{ key: "entry", value: "private-old-instance" }] },
          })
        ).status,
      ).toBe(410);
      expect((await s.create(s.a, page.targetId)).status).toBe(201);
      expect(s.state.writes).toBe(0);
    });
  });

  it("keeps shared admission gated while cancellation remains bounded and idempotent", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const s = await scenario(f);
      const params = await s.request();
      await updateFeatureSwitchesForUser(context, f.featureActor, {
        [FeatureSwitchKey.BrowserSharedOwner]: false,
      });
      expect((await s.create()).status).toBe(409);
      expect(
        (await client().preflight({ headers, params, body: {} })).status,
      ).toBe(410);
      expect(
        (await accept(client().cancel({ headers, params, body: {} }), [200]))
          .body.state,
      ).toBe("cancelled");
      mockNow(START + 11 * MINUTE);
      expect(
        (await accept(client().cancel({ headers, params, body: {} }), [200]))
          .body.state,
      ).toBe("cancelled");
      expect(s.state.writes).toBe(0);
    });
  });

  it("binds staged files and native file readback to the same window", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const s = await scenario(f);
      s.state.kind = "file";
      context.mocks.s3.getSignedUrl.mockResolvedValue(
        "https://uploads.example.test/temporary",
      );
      const params = await s.request();
      expect(
        (
          await accept(
            client().prepareFileUpload({
              headers,
              params,
              body: { key: "entry", index: 0, size: 4 },
            }),
            [200],
          )
        ).body.uploadUrl,
      ).toBe("https://uploads.example.test/temporary");
      const observed = await accept(
        client().preflight({ headers, params, body: {} }),
        [200],
      );
      const fingerprint = observed.body.fields[0]?.control.fileSetFingerprint;
      if (!fingerprint) {
        throw new Error("Expected the observed file set");
      }
      expect(
        (
          await accept(
            client().apply({
              headers,
              params,
              body: {
                values: [
                  {
                    key: "entry",
                    operation: "clear",
                    files: [],
                    observedFingerprint: fingerprint,
                  },
                ],
              },
            }),
            [200],
          )
        ).body.state,
      ).toBe("succeeded");
      expect(s.state.files).toStrictEqual([]);
      expect(s.state.writes).toBe(1);
      const expired = await s.request();
      mockNow(START + 11 * MINUTE);
      expect(
        (
          await client().prepareFileUpload({
            headers,
            params: expired,
            body: { key: "entry", index: 0, size: 4 },
          })
        ).status,
      ).toBe(410);
    });
  });

  it("exposes retired shared input as stale without touching the sibling window", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const s = await scenario(f);
      const params = await s.request();
      mockNow(START + 9 * MINUTE);
      await renew(s.b);
      mockNow(START + 11 * MINUTE);
      await open(s.a);
      expect((await client().get({ headers, params })).status).toBe(410);
      expect((await view(s.b)).status).toBe("active");
      expect(s.state.writes).toBe(0);
    });
  });
});
