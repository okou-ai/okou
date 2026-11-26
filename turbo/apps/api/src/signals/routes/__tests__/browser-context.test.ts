import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { browserContract } from "@okouai/api-contracts/contracts/browser";
import {
  chatThreadByIdContract,
  chatThreadComputerUseHostContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createStore } from "ccstate";
import { http } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { browserRoutes } from "../browser";
import { chatThreadComputerUseHostRoutes } from "../chat-threads-computer-use-host";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { chatThreadDeleteRoutes } from "../chat-threads-delete";
import { logsRoutes } from "../logs";
import { webFileUrlRoutes } from "../web-file-url";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import {
  createBrowserFixtures,
  MINUTE,
  PROVIDER_URL,
} from "./helpers/browser-fixture";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface Member {
  readonly orgId: string;
  readonly userId: string;
}

async function member(ids: Partial<Member> = {}): Promise<Member> {
  const actor = {
    orgId: ids.orgId ?? `org_${randomUUID()}`,
    userId: ids.userId ?? `user_${randomUUID()}`,
  };
  if (ids.orgId === undefined) {
    await Promise.all([
      createStore().set(
        seedOrgMembership$,
        { ...actor, role: "member" },
        context.signal,
      ),
      deliverOrganizationCreated(actor),
    ]);
  } else {
    await createStore().set(
      seedOrgMembership$,
      { ...actor, role: "member" },
      context.signal,
    );
  }
  return actor;
}

async function deliverOrganizationCreated(actor: Member) {
  const data = {
    id: actor.orgId,
    createdBy: actor.userId,
    createdAt: Date.parse("2026-01-01T00:00:00Z"),
  };
  context.mocks.clerk.verifyWebhook.mockResolvedValue({
    type: "organization.created",
    data,
  });
  await accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({
      body: JSON.stringify({ type: "organization.created", data }),
      extraHeaders: {
        "svix-id": `msg_${randomUUID()}`,
        "svix-timestamp": String(Math.floor(now() / 1000)),
        "svix-signature": "v1,signed-by-clerk",
      },
    }),
    [200],
  );
}

function signIn(actor: Member) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:member",
  );
}

function browser() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

function deleteThread(id: string) {
  return accept(
    setupApp({ context, routes: chatThreadDeleteRoutes })(
      chatThreadByIdContract,
    ).delete({ headers, params: { id } }),
    [204],
  );
}

function installProvider() {
  mockEnv("OKOU_BROWSER_USE_API_KEY", "browser-context-test-key");
  const provider = createBrowserFixtures(context).profileProvider();
  server.use(...provider.handlers);
  return provider;
}

async function noRunThread(cloudBrowserEnabled: boolean) {
  const created = await accept(
    setupApp({ context, routes: chatThreadCreateRoutes })(
      chatThreadsContract,
    ).create({ headers, body: {} }),
    [201],
  );
  // A new chat inherits the member's default cloud Browser authorization.
  if (!cloudBrowserEnabled) {
    await accept(
      setupApp({ context, routes: chatThreadComputerUseHostRoutes })(
        chatThreadComputerUseHostContract,
      ).update({
        headers,
        params: { id: created.body.id },
        body: { computerUseHostId: null, cloudBrowserEnabled: false },
      }),
      [204],
    );
  }
  return created.body.id;
}

describe("chat-owned Browser context", () => {
  it("browser-context-002 a no-Run chat without cloud Browser authorization cannot open a Browser", async () => {
    const provider = installProvider();
    signIn(await member());
    const threadId = await noRunThread(false);

    const response = await accept(
      browser().open({ headers, params: { threadId }, body: {} }),
      [403],
    );

    expect(response.body.error.code).toBe("BROWSER_AUTHORIZATION_REQUIRED");
    expect(provider.createdIds).toStrictEqual([]);
    expect(provider.sessionRequests).toStrictEqual([]);
  });

  async function ownerWithOpenedBrowser() {
    const provider = installProvider();
    const owner = await member();
    signIn(owner);
    const threadId = await noRunThread(true);
    await accept(
      browser().open({ headers, params: { threadId }, body: {} }),
      [200],
    );
    expect(provider.sessionRequests).toHaveLength(1);
    return { provider, owner, threadId };
  }

  async function expectEveryThreadRequestMissing(threadId: string) {
    const params = { threadId };
    const responses = [
      await accept(browser().get({ headers, params }), [404]),
      await accept(browser().open({ headers, params, body: {} }), [404]),
      await accept(
        browser().get({ headers, params, query: { viewer: "native" } }),
        [404],
      ),
      await accept(
        browser().leaseByThread({ headers, params, body: {} }),
        [404],
      ),
      await accept(
        browser().resizeByThread({ headers, params, body: { aspectRatio: 2 } }),
        [404],
      ),
      await accept(browser().close({ headers, params, body: {} }), [404]),
    ];
    for (const response of responses) {
      expect(response.body.error.code).toBe("BROWSER_NOT_FOUND");
    }
  }

  it("browser-context-003 (1/2) another member of the workspace cannot use the owner's no-Run chat Browser", async () => {
    const { provider, owner, threadId } = await ownerWithOpenedBrowser();

    signIn(await member({ orgId: owner.orgId }));
    await expectEveryThreadRequestMissing(threadId);

    expect(provider.sessionRequests).toHaveLength(1);
  });

  it("browser-context-003 (2/2) the owner signed into another workspace cannot use the no-Run chat Browser", async () => {
    const { provider, owner, threadId } = await ownerWithOpenedBrowser();

    signIn(await member({ userId: owner.userId }));
    await expectEveryThreadRequestMissing(threadId);

    expect(provider.sessionRequests).toHaveLength(1);
  });

  const MINUTE_MS = 60 * 1000;
  const LAST_PAGE_URL = "https://docs.example.test/page";

  function requireActiveWindow(
    session: Extract<
      Awaited<ReturnType<ReturnType<typeof browser>["open"]>>,
      { readonly status: 200 }
    >["body"]["browser"],
  ) {
    if (session.status !== "active") {
      throw new Error("Expected an active Browser session");
    }
    return session.window;
  }

  function mockS3ForBrowserCloseAndCleanup() {
    const uploads = new Map<string, Uint8Array>();
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof PutObjectCommand) {
        const key = command.input.Key;
        const body = command.input.Body;
        if (typeof key === "string") {
          if (body instanceof Uint8Array) {
            uploads.set(key, body);
          } else if (typeof body === "string") {
            uploads.set(key, Buffer.from(body));
          }
        }
        return Promise.resolve({});
      }
      if (command instanceof HeadObjectCommand) {
        const key = command.input.Key;
        const stored = typeof key === "string" ? uploads.get(key) : undefined;
        if (stored) {
          return Promise.resolve({
            ETag: '"test-etag"',
            ContentLength: stored.byteLength,
            ContentType: "image/webp",
          });
        }
        return Promise.reject(
          Object.assign(new Error("NotFound"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      if (command instanceof GetObjectCommand) {
        const key = command.input.Key;
        const stored = typeof key === "string" ? uploads.get(key) : undefined;
        if (stored) {
          return Promise.resolve({
            ETag: '"test-etag"',
            ContentLength: stored.byteLength,
            Body: Readable.from([stored]),
          });
        }
        return Promise.reject(
          Object.assign(new Error("NoSuchKey"), {
            name: "NoSuchKey",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      return Promise.resolve({});
    });
    return { uploads };
  }

  async function givenTwoOpenedChats(startMs: number) {
    mockNow(startMs);
    mockEnv("OKOU_BROWSER_USE_API_KEY", "browser-context-test-key");
    mockS3ForBrowserCloseAndCleanup();
    const provider = createBrowserFixtures(context).profileProvider(
      undefined,
      "wss:",
    );
    installBrowserWindowContentCommands(provider.native);
    server.use(...provider.handlers);
    const owner = await member();
    signIn(owner);
    const [threadA, threadB] = await Promise.all([
      noRunThread(true),
      noRunThread(true),
    ]);
    const openedA = await accept(
      browser().open({ headers, params: { threadId: threadA }, body: {} }),
      [200],
    );
    const openedB = await accept(
      browser().open({ headers, params: { threadId: threadB }, body: {} }),
      [200],
    );
    const windowA = requireActiveWindow(openedA.body.browser);
    const windowB = requireActiveWindow(openedB.body.browser);
    return { provider, owner, threadA, threadB, windowA, windowB };
  }

  async function closeLeaseAndRecover(startMs: number) {
    const setup = await givenTwoOpenedChats(startMs);
    const targetA = [...setup.provider.native.targets.values()].find(
      (target) => {
        return target.windowId === setup.windowA.primaryWindowId;
      },
    );
    if (!targetA) {
      throw new Error("Expected a provider target for chat A");
    }
    targetA.url = LAST_PAGE_URL;
    await accept(
      browser().close({
        headers,
        params: { threadId: setup.threadA },
        body: {},
      }),
      [200],
    );
    mockNow(startMs + 9 * MINUTE_MS);
    const leasedB = await accept(
      browser().leaseByThread({
        headers,
        params: { threadId: setup.threadB },
        body: {},
      }),
      [200],
    );
    mockNow(startMs + 11 * MINUTE_MS);
    const recoveredA = await accept(
      browser().open({
        headers,
        params: { threadId: setup.threadA },
        body: {},
      }),
      [200],
    );
    return { ...setup, leasedB, recoveredA };
  }

  it("browser-context-001 (1/4) opens two chats in one shared Browser and keeps the same window across reopen, read, and native viewer", async () => {
    const startMs = Date.parse("2026-10-01T12:00:00Z");
    const { provider, threadA, windowA, windowB } =
      await givenTwoOpenedChats(startMs);

    const [reopenedA, readA, nativeA] = await Promise.all([
      accept(
        browser().open({ headers, params: { threadId: threadA }, body: {} }),
        [200],
      ),
      accept(browser().get({ headers, params: { threadId: threadA } }), [200]),
      accept(
        browser().get({
          headers,
          params: { threadId: threadA },
          query: { viewer: "native" },
        }),
        [200],
      ),
    ]);

    expect(windowA.primaryWindowId).toBe(0);
    expect(windowB.instanceId).toBe(windowA.instanceId);
    expect(windowB.primaryWindowId).not.toBe(windowA.primaryWindowId);
    expect(requireActiveWindow(reopenedA.body.browser)).toStrictEqual(windowA);
    expect(requireActiveWindow(readA.body.browser)).toStrictEqual(windowA);
    expect(nativeA.body.viewer).toMatchObject({
      cdpUrl: provider.cdpUrl,
      browser: { window: windowA },
    });
  });

  it("browser-context-001 (2/4) resizes chat A to 1440x720, closes it, and extends chat B lease to minute 19", async () => {
    const startMs = Date.parse("2026-10-01T12:00:00Z");
    const { provider, threadA, threadB, windowA } =
      await givenTwoOpenedChats(startMs);

    const resizedA = await accept(
      browser().resizeByThread({
        headers,
        params: { threadId: threadA },
        body: { aspectRatio: 2 },
      }),
      [200],
    );
    await accept(
      browser().close({ headers, params: { threadId: threadA }, body: {} }),
      [200],
    );
    mockNow(startMs + 9 * MINUTE_MS);
    const leasedB = await accept(
      browser().leaseByThread({
        headers,
        params: { threadId: threadB },
        body: {},
      }),
      [200],
    );

    expect(requireActiveWindow(resizedA.body.browser)).toStrictEqual(windowA);
    expect(
      provider.native.contentsSizes.get(windowA.primaryWindowId),
    ).toStrictEqual({ width: 1440, height: 720 });
    expect(Date.parse(leasedB.body.browser.idleExpiresAt ?? "")).toBe(
      startMs + 19 * MINUTE_MS,
    );
  });

  it("browser-context-001 (3/4) recovers chat A at minute 11 at its last URL, keeps one Browser and session, and leaves chat B and logs unchanged", async () => {
    const startMs = Date.parse("2026-10-01T12:00:00Z");
    const { provider, threadB, windowA, windowB, recoveredA } =
      await closeLeaseAndRecover(startMs);

    const [readB, logs] = await Promise.all([
      accept(browser().get({ headers, params: { threadId: threadB } }), [200]),
      accept(
        setupApp({ context, routes: logsRoutes })(logsListContract).list({
          headers,
          query: {},
        }),
        [200],
      ),
    ]);
    const recoveredWindow = requireActiveWindow(recoveredA.body.browser);
    const recoveredTarget = [...provider.native.targets.values()].find(
      (target) => {
        return target.windowId === recoveredWindow.primaryWindowId;
      },
    );

    expect(recoveredWindow.instanceId).toBe(windowA.instanceId);
    expect(recoveredWindow.primaryWindowId).not.toBe(windowA.primaryWindowId);
    expect(recoveredTarget?.url).toBe(LAST_PAGE_URL);
    expect(requireActiveWindow(readB.body.browser)).toStrictEqual(windowB);
    expect(Date.parse(readB.body.browser.idleExpiresAt ?? "")).toBe(
      startMs + 19 * MINUTE_MS,
    );
    expect(provider.createdIds).toHaveLength(1);
    expect(provider.sessionIds.size).toBe(1);
    expect(logs.body.data).toStrictEqual([]);
  });

  it("browser-context-001 (4/4) keeps the provider session after deleting chat A and stops it after deleting chat B", async () => {
    const startMs = Date.parse("2026-10-01T12:00:00Z");
    const { provider, threadA, threadB } = await givenTwoOpenedChats(startMs);
    const [sessionId] = [...provider.sessionIds];
    if (!sessionId) {
      throw new Error("Expected a live provider session");
    }

    await deleteThread(threadA);
    expect(provider.stoppedSessionIds.has(sessionId)).toBeFalsy();

    await deleteThread(threadB);
    expect(provider.stoppedSessionIds.has(sessionId)).toBeTruthy();
  });

  async function setupSharedBrowserWithUnavailableBridge() {
    const provider = installProvider();
    signIn(await member());
    const [threadA, threadB] = await Promise.all([
      noRunThread(true),
      noRunThread(true),
    ]);
    await accept(
      browser().open({ headers, params: { threadId: threadA }, body: {} }),
      [200],
    );
    const openedB = await accept(
      browser().open({ headers, params: { threadId: threadB }, body: {} }),
      [200],
    );
    const initialWindowB = requireActiveWindow(openedB.body.browser);
    provider.native.bridgeAvailable = false;
    return { provider, threadA, threadB, initialWindowB };
  }

  it("browser-expiry-009 (1/2) keeps sibling window and provider session after deleting the first chat with an unavailable bridge", async () => {
    const { provider, threadA, threadB, initialWindowB } =
      await setupSharedBrowserWithUnavailableBridge();

    await deleteThread(threadA);
    const viewedB = await accept(
      browser().get({ headers, params: { threadId: threadB } }),
      [200],
    );

    expect(requireActiveWindow(viewedB.body.browser)).toStrictEqual(
      initialWindowB,
    );
    expect(provider.sessionIds.size).toBe(1);
  });

  it("browser-expiry-009 (2/2) stops the single provider session after deleting the last chat with an unavailable bridge", async () => {
    const { provider, threadA, threadB } =
      await setupSharedBrowserWithUnavailableBridge();

    await deleteThread(threadA);
    await deleteThread(threadB);

    expect(provider.sessionIds.size).toBe(0);
    expect(provider.stoppedSessionIds.size).toBe(1);
    expect(provider.createdIds).toHaveLength(1);
  });

  async function setupSharedBrowserWithActiveBPage() {
    const provider = installProvider();
    signIn(await member());
    const [threadA, threadB] = await Promise.all([
      noRunThread(true),
      noRunThread(true),
    ]);
    const openedA = await accept(
      browser().open({ headers, params: { threadId: threadA }, body: {} }),
      [200],
    );
    const openedB = await accept(
      browser().open({ headers, params: { threadId: threadB }, body: {} }),
      [200],
    );
    const windowA = requireActiveWindow(openedA.body.browser);
    const windowB = requireActiveWindow(openedB.body.browser);
    expect(windowB.instanceId).toBe(windowA.instanceId);

    const pageB = [...provider.native.targets.values()].find((target) => {
      return target.windowId === windowB.primaryWindowId;
    });
    if (!pageB) {
      throw new Error("Expected a page target in window B");
    }
    pageB.url = "https://b.example.test/active";

    return {
      provider,
      threadA,
      threadB,
      windowAId: windowA.primaryWindowId,
      windowBId: windowB.primaryWindowId,
    };
  }

  it("browser-reclaim-013 (1/2) closes chat A's window while preserving chat B's active page and provider session", async () => {
    const { provider, threadA, windowAId, windowBId } =
      await setupSharedBrowserWithActiveBPage();

    await deleteThread(threadA);

    const pagesInA = [...provider.native.targets.values()].filter((target) => {
      return target.windowId === windowAId;
    });
    const pagesInB = [...provider.native.targets.values()].filter((target) => {
      return target.windowId === windowBId;
    });
    expect(pagesInA).toStrictEqual([]);
    expect(pagesInB).toHaveLength(1);
    expect(pagesInB[0]?.url).toBe("https://b.example.test/active");
    expect(provider.sessionIds.size).toBe(1);
  });

  it("browser-reclaim-013 (2/2) closes all pages and stops the single provider session after deleting the last chat", async () => {
    const { provider, threadA, threadB } =
      await setupSharedBrowserWithActiveBPage();

    await deleteThread(threadA);
    await deleteThread(threadB);

    expect(provider.native.targets.size).toBe(0);
    expect(provider.sessionIds.size).toBe(0);
    expect(provider.createdIds).toHaveLength(1);
  });

  it("browser-reuse-002 reuses a healthy chat Browser with one provider read and native socket", async () => {
    const start = Date.parse("2026-02-01T10:00:00.000Z");
    mockNow(start);
    mockEnv("OKOU_BROWSER_USE_API_KEY", "browser-reuse-test-key");
    const provider = createBrowserFixtures(context).profileProvider();
    let watching = false;
    let providerSessionReads = 0;
    server.use(
      http.get(`${PROVIDER_URL}/browsers/:id`, () => {
        if (watching) {
          providerSessionReads++;
        }
        return undefined;
      }),
      ...provider.handlers,
    );
    signIn(await member());

    const [threadA, threadB] = await Promise.all([
      noRunThread(true),
      noRunThread(true),
    ]);
    const openedA = await accept(
      browser().open({ headers, params: { threadId: threadA }, body: {} }),
      [200],
    );
    const openedB = await accept(
      browser().open({ headers, params: { threadId: threadB }, body: {} }),
      [200],
    );
    const windowA = requireActiveWindow(openedA.body.browser);
    const windowB = requireActiveWindow(openedB.body.browser);
    const idleExpiryB = openedB.body.browser.idleExpiresAt;

    provider.native.nativeWindowErrors.set(
      windowB.primaryWindowId,
      "Window B health check failed",
    );
    mockNow(start + MINUTE);

    const connectionsBefore = provider.native.connections;
    const commandsBefore = provider.native.commands.length;
    watching = true;
    const reopenedA = await accept(
      browser().open({ headers, params: { threadId: threadA }, body: {} }),
      [200],
    );
    watching = false;

    const commandsDuringOpen = provider.native.commands.slice(commandsBefore);
    const connectionsDuringOpen =
      provider.native.connections - connectionsBefore;

    const viewedB = await accept(
      browser().get({ headers, params: { threadId: threadB } }),
      [200],
    );

    mockNow(start + 11 * MINUTE);
    const expectedIdleExpiryA = nowDate().toISOString();

    expect(requireActiveWindow(reopenedA.body.browser)).toStrictEqual(windowA);
    expect(reopenedA.body.browser.idleExpiresAt).toBe(expectedIdleExpiryA);
    expect(providerSessionReads).toBe(1);
    expect(connectionsDuringOpen).toBe(1);
    expect(commandsDuringOpen).toHaveLength(1);
    expect(commandsDuringOpen[0]).toMatchObject({
      method: "Browser.getWindowBounds",
      params: { windowId: windowA.primaryWindowId },
    });
    expect(provider.sessionRequests).toHaveLength(1);

    expect(requireActiveWindow(viewedB.body.browser)).toStrictEqual(windowB);
    expect(viewedB.body.browser.idleExpiresAt).toBe(idleExpiryB);
  });

  it("browser-screenshot-publication-001 keeps the accepted screenshot downloadable after the shared provider retires", async () => {
    const startMs = Date.parse("2026-10-01T12:00:00Z");
    mockNow(startMs);
    mockEnv("OKOU_BROWSER_USE_API_KEY", "browser-screenshot-test-key");
    const { uploads } = mockS3ForBrowserCloseAndCleanup();
    const provider = createBrowserFixtures(context).profileProvider(
      undefined,
      "wss:",
    );
    installBrowserWindowContentCommands(provider.native);
    server.use(...provider.handlers);
    signIn(await member());

    const threadId = await noRunThread(true);
    const opened = await accept(
      browser().open({ headers, params: { threadId }, body: {} }),
      [200],
    );
    const window = requireActiveWindow(opened.body.browser);
    const target = [...provider.native.targets.values()].find((entry) => {
      return entry.windowId === window.primaryWindowId;
    });
    if (!target) {
      throw new Error("Expected a provider target for the chat window");
    }

    await accept(
      browser().close({ headers, params: { threadId }, body: {} }),
      [200],
    );
    const publishedView = await accept(
      browser().get({ headers, params: { threadId } }),
      [200],
    );
    const publishedUrl = publishedView.body.browser.screenshotUrl;
    expect(publishedUrl).toBeTruthy();

    const uploadedEntry = [...uploads.entries()].find(([key]) => {
      return key.startsWith("private-artifacts/");
    });
    if (!uploadedEntry) {
      throw new Error("Expected screenshot bytes to be uploaded to storage");
    }
    const [uploadedKey, uploadedBytes] = uploadedEntry;
    expect(Buffer.from(uploadedBytes).toString("utf8")).toBe(
      `preview:${target.targetId}`,
    );
    const fileId = uploadedKey.split("/")[1];
    if (!fileId) {
      throw new Error("Expected file ID in uploaded screenshot key");
    }

    for (const sessionId of provider.sessionIds) {
      provider.sessionIds.delete(sessionId);
      provider.stoppedSessionIds.add(sessionId);
    }
    provider.native.targets.clear();

    const leaseResponse = await accept(
      browser().leaseByThread({ headers, params: { threadId }, body: {} }),
      [409],
    );
    expect(leaseResponse.body.error.code).toBe("BROWSER_RECLAIMING");

    const retiredView = await accept(
      browser().get({ headers, params: { threadId } }),
      [200],
    );
    expect(retiredView.body.browser.status).toBe("suspended");
    expect("window" in retiredView.body.browser).toBeFalsy();
    expect(retiredView.body.browser.screenshotUrl).toBe(publishedUrl);

    const fileUrlResponse = await accept(
      setupApp({ context, routes: webFileUrlRoutes })(webFilesContract).fileUrl(
        {
          headers,
          query: { file_id: fileId },
        },
      ),
      [200],
    );
    expect(fileUrlResponse.body.downloadUrl).toBeTruthy();
  });
});
