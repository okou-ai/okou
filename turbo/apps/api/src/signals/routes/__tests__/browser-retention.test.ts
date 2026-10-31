import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { cronBrowserReconcileContract } from "@okouai/api-contracts/contracts/cron";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { browserRoutes } from "../browser";
import { cronBrowserReconcileRoutes } from "../cron-browser-reconcile";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import {
  createSharedBrowserFixtures,
  MINUTE,
  PROVIDER_URL,
  START,
} from "./helpers/browser-shared-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const { fixture, open, view } = createSharedBrowserFixtures(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const cronHeaders = Object.freeze({
  authorization: "Bearer test-cron-secret",
});
const SUSPENDED_AT = START + 11 * MINUTE;
const EXPIRES_AT = SUSPENDED_AT + 7 * 24 * 60 * MINUTE;

function screenshotStorage() {
  const previous = context.mocks.s3.send.getMockImplementation();
  if (!previous) {
    throw new Error("Expected the shared storage transport");
  }
  const objects = new Map<string, Buffer>();
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (command instanceof PutObjectCommand) {
      const { Key, Body, ContentType } = command.input;
      if (
        Key &&
        ContentType === "image/webp" &&
        (typeof Body === "string" || Buffer.isBuffer(Body))
      ) {
        objects.set(Key, Buffer.from(Body));
        return { ETag: "browser-preview-etag" };
      }
    }
    if (
      command instanceof GetObjectCommand ||
      command instanceof HeadObjectCommand
    ) {
      const bytes = command.input.Key
        ? objects.get(command.input.Key)
        : undefined;
      if (bytes) {
        return {
          ETag: "browser-preview-etag",
          ContentLength: bytes.length,
          Body: Readable.from([bytes]),
        };
      }
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const { Key } of command.input.Delete?.Objects ?? []) {
        if (Key) {
          objects.delete(Key);
        }
      }
      return {};
    }
    return await previous(command);
  });
  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      if (!(command instanceof GetObjectCommand) || !command.input.Key) {
        throw new Error("Expected a Browser screenshot download");
      }
      return Promise.resolve(
        `https://screenshots.example.test/${encodeURIComponent(command.input.Key)}`,
      );
    },
  );
  return objects;
}

function screenshotKey(url: string | null) {
  if (!url) {
    throw new Error("Expected the suspended Browser's screenshot");
  }
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

test.each([false, true])(
  "retires a seven-day inactive Browser and its preview, recovering provider failure=%s",
  async (failFirstDeletion) => {
    // The real retention operator scans across owners, so select a case-owned
    // database before the public chat and Browser setup accesses it.
    const app = await setupApp({
      context,
      routes: [...browserRoutes, ...cronBrowserReconcileRoutes],
      isolatePg: true,
    });
    const browsers = app(browserContract);
    const cron = app(cronBrowserReconcileContract);
    const f = await fixture(false);
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const objects = screenshotStorage();
      const a = await f.start();
      await open(a);
      for (const page of f.provider.native.targets.values()) {
        page.url = "https://example.test/expired-browser-tab";
      }
      const request = { headers, params: { threadId: a.threadId } };
      await accept(cron.reconcile({ headers: cronHeaders }), [200]);
      await flushWaitUntilForTest();
      mockNow(SUSPENDED_AT);
      await accept(cron.reconcile({ headers: cronHeaders }), [200]);
      await flushWaitUntilForTest();
      const suspended = await view(a);
      expect(suspended.status).toBe("suspended");
      const key = screenshotKey(suspended.screenshotUrl);
      expect(objects.get(key)?.toString()).toMatch(/^preview:/u);
      const chat = createChatFilesBddApi(context);
      await chat.requestWebFileUrl(
        f.owned.actor,
        key.split("/")[1] ?? "",
        [200],
      );

      mockNow(EXPIRES_AT - 1);
      await accept(cron.reconcile({ headers: cronHeaders }), [200]);
      expect((await view(a)).screenshotUrl).toBe(suspended.screenshotUrl);
      expect(objects.get(key)?.toString()).toMatch(/^preview:/u);

      let failing = failFirstDeletion;
      const deletedProfiles: string[] = [];
      server.use(
        http.delete(`${PROVIDER_URL}/profiles/:id`, ({ params }) => {
          if (failing) {
            return HttpResponse.json(
              { detail: "Provider unavailable" },
              { status: 503 },
            );
          }
          deletedProfiles.push(String(params.id));
          return;
        }),
      );
      mockNow(EXPIRES_AT);
      const attempted = await accept(
        cron.reconcile({ headers: cronHeaders }),
        [200],
      );
      if (failFirstDeletion) {
        expect(attempted.body.errors).toBe(1);
        await expect(view(a)).resolves.toMatchObject({
          status: "suspended",
          suspensionReason: "idle",
          screenshotUrl: null,
        });
        failing = false;
        const retried = await accept(
          cron.reconcile({ headers: cronHeaders }),
          [200],
        );
        expect(retried.body.errors).toBe(0);
      } else {
        expect(attempted.body.errors).toBe(0);
      }
      const retired = await accept(browsers.get(request), [404]);
      expect(retired.body.error.code).toBe("BROWSER_NOT_FOUND");
      expect(deletedProfiles).toStrictEqual([f.provider.createdIds[0]]);
      expect(objects.get(key)).toBeUndefined();
      await chat.requestWebFileUrl(
        f.owned.actor,
        key.split("/")[1] ?? "",
        [404],
      );

      const repeated = await accept(
        cron.reconcile({ headers: cronHeaders }),
        [200],
      );
      expect(repeated.body).toMatchObject({
        checked: 0,
        stopped: 0,
        errors: 0,
      });
      const fresh = await accept(
        browsers.open({ ...request, body: {} }),
        [200],
      );
      expect(fresh.body.browser).toMatchObject({
        status: "active",
        screenshotUrl: null,
      });
      expect(f.provider.createdIds).toHaveLength(2);
      expect(
        [...f.provider.native.targets.values()].map((page) => {
          return page.url;
        }),
      ).toStrictEqual(["about:blank"]);
    });
  },
);

test("preserves a Browser resumed just before its retention deadline", async () => {
  const app = await setupApp({
    context,
    routes: [...browserRoutes, ...cronBrowserReconcileRoutes],
    isolatePg: true,
  });
  const browsers = app(browserContract);
  const cron = app(cronBrowserReconcileContract);
  const f = await fixture(false);
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    await open(a);
    for (const page of f.provider.native.targets.values()) {
      page.url = "https://example.test/resumable-tab";
    }
    mockNow(SUSPENDED_AT);
    await accept(cron.reconcile({ headers: cronHeaders }), [200]);
    expect((await view(a)).status).toBe("suspended");
    mockNow(EXPIRES_AT - 1);
    const request = { headers, params: { threadId: a.threadId } };
    await accept(browsers.open({ ...request, body: {} }), [200]);
    mockNow(EXPIRES_AT);
    const reconciled = await accept(
      cron.reconcile({ headers: cronHeaders }),
      [200],
    );
    expect(reconciled.body.errors).toBe(0);
    expect((await view(a)).status).toBe("active");
    expect(f.provider.createdIds).toHaveLength(1);
    expect(
      [...f.provider.native.targets.values()].map((page) => {
        return page.url;
      }),
    ).toStrictEqual(["https://example.test/resumable-tab"]);
    await accept(browsers.viewerConnection(request), [200]);
  });
});

test("protects pre-cutover previews after shared ownership persists with admission disabled", async () => {
  const app = await setupApp({
    context,
    routes: [...browserRoutes, ...cronBrowserReconcileRoutes],
    isolatePg: true,
  });
  const browsers = app(browserContract);
  const cron = app(cronBrowserReconcileContract);
  const f = await fixture(false);
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const objects = screenshotStorage();
    const a = await f.start();
    await open(a);
    await accept(cron.reconcile({ headers: cronHeaders }), [200]);
    await flushWaitUntilForTest();
    mockNow(SUSPENDED_AT);
    await accept(cron.reconcile({ headers: cronHeaders }), [200]);
    await flushWaitUntilForTest();
    const key = screenshotKey((await view(a)).screenshotUrl);
    f.owned.ownsFeatureSwitches();
    await updateFeatureSwitchesForUser(context, f.featureActor, {
      [FeatureSwitchKey.BrowserSharedOwner]: true,
    });
    const opened = await accept(
      browsers.open({ headers, params: { threadId: a.threadId }, body: {} }),
      [200],
    );
    expect(opened.body.browser.window).toBeDefined();
    await updateFeatureSwitchesForUser(context, f.featureActor, {
      [FeatureSwitchKey.BrowserSharedOwner]: false,
    });
    mockNow(EXPIRES_AT);
    const reconciled = await accept(
      cron.reconcile({ headers: cronHeaders }),
      [200],
    );
    expect(reconciled.body.errors).toBe(0);
    expect((await view(a)).status).toBe("suspended");
    expect(objects.get(key)?.toString()).toMatch(/^preview:/u);
    await createChatFilesBddApi(context).requestWebFileUrl(
      f.owned.actor,
      key.split("/")[1] ?? "",
      [200],
    );
  });
});
