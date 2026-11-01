import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { cronBrowserReconcileContract } from "@okouai/api-contracts/contracts/cron";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { browserRoutes } from "../browser";
import { cronBrowserReconcileRoutes } from "../cron-browser-reconcile";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import {
  createSharedBrowserFixtures,
  START,
} from "./helpers/browser-shared-fixture";

const context = testContext();
const { fixture, open, view } = createSharedBrowserFixtures(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
type Chat = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["start"]>>;

function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

function sweep() {
  return accept(
    setupApp({ context, routes: cronBrowserReconcileRoutes })(
      cronBrowserReconcileContract,
    ).reconcile({ headers: { authorization: "Bearer test-cron-secret" } }),
    [200],
  );
}

function storage() {
  const previous = context.mocks.s3.send.getMockImplementation();
  const objects = new Map<string, Buffer>();
  const uploads: string[] = [];
  const controls: {
    beforeUpload?: (key: string) => Promise<void>;
    beforeDelete?: (key: string) => Promise<void>;
    failDelete?: string;
  } = {};
  const location = (bucket: string, key: string) => {
    return `${bucket}/${key}`;
  };
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (command instanceof PutObjectCommand) {
      const { Bucket, Key, Body, ContentType } = command.input;
      if (
        Bucket &&
        Key &&
        (typeof Body === "string" || Buffer.isBuffer(Body))
      ) {
        objects.set(location(Bucket, Key), Buffer.from(Body));
        if (ContentType === "image/webp") {
          uploads.push(Key);
          await controls.beforeUpload?.(Key);
        }
        return { ETag: "fixture-etag" };
      }
    }
    if (
      command instanceof GetObjectCommand ||
      command instanceof HeadObjectCommand
    ) {
      const { Bucket, Key } = command.input;
      const bytes = objects.get(`${Bucket}/${Key}`);
      if (!bytes) {
        throw Object.assign(new Error("Object missing"), { name: "NoSuchKey" });
      }
      return {
        ETag: "fixture-etag",
        ContentLength: bytes.length,
        Body: Readable.from([bytes]),
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const { Key } of command.input.Delete?.Objects ?? []) {
        if (Key && command.input.Bucket) {
          await controls.beforeDelete?.(Key);
          if (controls.failDelete === Key) {
            return { Errors: [{ Key, Code: "InternalError" }] };
          }
          objects.delete(location(command.input.Bucket, Key));
        }
      }
      return {};
    }
    return previous ? await previous(command) : {};
  });
  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      if (!(command instanceof GetObjectCommand) || !command.input.Key) {
        throw new Error("Expected an object download");
      }
      return Promise.resolve(
        `https://screenshots.example.test/${encodeURIComponent(command.input.Key)}`,
      );
    },
  );
  return {
    uploads,
    controls,
    bytes: (key: string) => {
      return objects.get(location("test-private-artifacts", key));
    },
    remove: (key: string) => {
      return objects.delete(location("test-private-artifacts", key));
    },
  };
}

async function capture(chat: Chat) {
  await accept(
    client().close({ headers, params: { threadId: chat.threadId }, body: {} }),
    [200],
  );
  const browser = await view(chat);
  if (!browser.screenshotUrl) {
    throw new Error("Expected a published screenshot URL");
  }
  return decodeURIComponent(new URL(browser.screenshotUrl).pathname.slice(1));
}

test("publishes legacy Browser captures with their ready private file through the existing cron", async () => {
  await setupApp({
    context,
    routes: cronBrowserReconcileRoutes,
    isolatePg: true,
  });
  const f = await fixture(false);
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    await open(a);
    const s3 = storage();
    await sweep();
    await flushWaitUntilForTest();
    const browser = await view(a);
    if (!browser.screenshotUrl) {
      throw new Error("Expected the legacy Browser's published screenshot");
    }
    const key = decodeURIComponent(
      new URL(browser.screenshotUrl).pathname.slice(1),
    );
    expect(s3.bytes(key)?.toString()).toMatch(/^preview:/u);
    await createChatFilesBddApi(context).requestWebFileUrl(
      f.owned.actor,
      key.split("/")[1] ?? "",
      [200],
    );
  });
});

test("reclaims replaced screenshots and their file access while the current preview remains usable", async () => {
  await setupApp({
    context,
    routes: cronBrowserReconcileRoutes,
    isolatePg: true,
  });
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    await open(a);
    const s3 = storage();
    const first = await capture(a);
    mockNow(START + 1000);
    const latest = await capture(a);
    const chat = createChatFilesBddApi(context);
    await chat.requestWebFileUrl(
      f.owned.actor,
      first.split("/")[1] ?? "",
      [200],
    );
    await sweep();
    expect(s3.bytes(first)).toBeUndefined();
    expect(s3.bytes(latest)?.toString()).toMatch(/^preview:/u);
    expect((await view(a)).screenshotUrl).toBe(
      `https://screenshots.example.test/${encodeURIComponent(latest)}`,
    );
    await chat.requestWebFileUrl(
      f.owned.actor,
      first.split("/")[1] ?? "",
      [404],
    );
    await chat.requestWebFileUrl(
      f.owned.actor,
      latest.split("/")[1] ?? "",
      [200],
    );
  });
});

test("retains the accepted screenshot after the shared owner and window retire", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    await open(a);
    const s3 = storage();
    await capture(a);
    const [providerId] = f.provider.sessionIds;
    if (!providerId) {
      throw new Error("Expected the shared owner's live provider");
    }
    f.provider.sessionIds.delete(providerId);
    f.provider.stoppedSessionIds.add(providerId);
    f.provider.native.targets.clear();
    await accept(
      client().leaseByThread({
        headers,
        params: { threadId: a.threadId },
        body: {},
      }),
      [409],
    );
    const inactive = await view(a);
    expect(inactive.window).toBeUndefined();
    if (!inactive.screenshotUrl) {
      throw new Error("Expected the inactive chat's accepted screenshot");
    }
    const key = decodeURIComponent(
      new URL(inactive.screenshotUrl).pathname.slice(1),
    );
    await sweep();
    expect(s3.bytes(key)?.toString()).toMatch(/^preview:/u);
    expect((await view(a)).screenshotUrl).toBe(inactive.screenshotUrl);
    await createChatFilesBddApi(context).requestWebFileUrl(
      f.owned.actor,
      key.split("/")[1] ?? "",
      [200],
    );
  });
});

test("reclaims a deleted chat's final screenshot without removing an active sibling", async () => {
  await setupApp({
    context,
    routes: cronBrowserReconcileRoutes,
    isolatePg: true,
  });
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    const b = await f.start();
    await open(a);
    const sibling = await open(b);
    const s3 = storage();
    const removed = await capture(a);
    const retained = await capture(b);
    await createChatFilesBddApi(context).deleteThread(
      f.owned.actor,
      a.threadId,
    );
    await sweep();
    expect(s3.bytes(removed)).toBeUndefined();
    expect(s3.bytes(retained)?.toString()).toMatch(/^preview:/u);
    expect((await view(b)).window).toStrictEqual(sibling.window);
    expect((await view(b)).screenshotUrl).toBe(
      `https://screenshots.example.test/${encodeURIComponent(retained)}`,
    );
  });
});

test("fences obsolete file access before a delayed storage deletion without fencing the accepted preview", async () => {
  await setupApp({
    context,
    routes: cronBrowserReconcileRoutes,
    isolatePg: true,
  });
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    await open(a);
    const s3 = storage();
    const obsolete = await capture(a);
    mockNow(START + 1000);
    const accepted = await capture(a);
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    s3.controls.beforeDelete = async (key) => {
      if (key === obsolete) {
        entered.resolve();
        await release.promise;
      }
    };
    const cleaning = settleIncludingAbort(sweep());
    const observed = await settleIncludingAbort(async () => {
      await Promise.race([
        entered.promise,
        cleaning.then(() => {
          throw new Error("Expected storage deletion to be held");
        }),
      ]);
      const chat = createChatFilesBddApi(context);
      await chat.requestWebFileUrl(
        f.owned.actor,
        obsolete.split("/")[1] ?? "",
        [404],
      );
      await chat.requestWebFileUrl(
        f.owned.actor,
        accepted.split("/")[1] ?? "",
        [200],
      );
      expect(s3.bytes(obsolete)?.toString()).toMatch(/^preview:/u);
      expect((await view(a)).screenshotUrl).toBe(
        `https://screenshots.example.test/${encodeURIComponent(accepted)}`,
      );
    });
    release.resolve();
    const cleaned = await cleaning;
    if (!observed.ok) {
      throw observed.error;
    }
    if (!cleaned.ok) {
      throw cleaned.error;
    }
    expect(s3.bytes(obsolete)).toBeUndefined();
    expect(s3.bytes(accepted)?.toString()).toMatch(/^preview:/u);
  });
});

test("retains partial deletion failures, continues other objects, and recovers an already-missing object", async () => {
  await setupApp({
    context,
    routes: cronBrowserReconcileRoutes,
    isolatePg: true,
  });
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    await open(a);
    const s3 = storage();
    const failed = await capture(a);
    mockNow(START + 1000);
    const other = await capture(a);
    mockNow(START + 2000);
    const latest = await capture(a);
    s3.controls.failDelete = failed;
    await sweep();
    expect(s3.bytes(failed)?.toString()).toMatch(/^preview:/u);
    expect(s3.bytes(other)).toBeUndefined();
    expect(s3.bytes(latest)?.toString()).toMatch(/^preview:/u);
    const chat = createChatFilesBddApi(context);
    await chat.requestWebFileUrl(
      f.owned.actor,
      failed.split("/")[1] ?? "",
      [404],
    );
    // Model an external deletion whose reply was lost before local retirement.
    s3.remove(failed);
    s3.controls.failDelete = undefined;
    await sweep();
    await chat.requestWebFileUrl(
      f.owned.actor,
      failed.split("/")[1] ?? "",
      [404],
    );
    await chat.requestWebFileUrl(
      f.owned.actor,
      latest.split("/")[1] ?? "",
      [200],
    );
  });
});

test("reclaims an upload abandoned after an uncertain storage response", async () => {
  await setupApp({
    context,
    routes: cronBrowserReconcileRoutes,
    isolatePg: true,
  });
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    await open(a);
    const s3 = storage();
    const accepted = await capture(a);
    s3.controls.beforeUpload = () => {
      return Promise.reject(new Error("Upload response lost"));
    };
    await accept(
      client().close({ headers, params: { threadId: a.threadId }, body: {} }),
      [200],
    );
    const abandoned = s3.uploads[1];
    if (!abandoned) {
      throw new Error("Expected the uncertain upload");
    }
    await sweep();
    expect(s3.bytes(abandoned)).toBeUndefined();
    expect(s3.bytes(accepted)?.toString()).toMatch(/^preview:/u);
    expect((await view(a)).screenshotUrl).toBe(
      `https://screenshots.example.test/${encodeURIComponent(accepted)}`,
    );
    await createChatFilesBddApi(context).requestWebFileUrl(
      f.owned.actor,
      abandoned.split("/")[1] ?? "",
      [404],
    );
  });
});

test("preserves a concurrently published preview while the sweep is deleting its predecessor", async () => {
  await setupApp({
    context,
    routes: cronBrowserReconcileRoutes,
    isolatePg: true,
  });
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    await open(a);
    const s3 = storage();
    const obsolete = await capture(a);
    mockNow(START + 1000);
    await capture(a);
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    s3.controls.beforeDelete = async (key) => {
      if (key === obsolete) {
        entered.resolve();
        await release.promise;
      }
    };
    const cleaning = settleIncludingAbort(sweep());
    const publication = await settleIncludingAbort(async () => {
      await Promise.race([
        entered.promise,
        cleaning.then(() => {
          throw new Error("Expected deletion to reach storage");
        }),
      ]);
      mockNow(START + 2000);
      return await capture(a);
    });
    release.resolve();
    const cleaned = await cleaning;
    if (!publication.ok) {
      throw publication.error;
    }
    if (!cleaned.ok) {
      throw cleaned.error;
    }
    await sweep();
    expect(s3.bytes(obsolete)).toBeUndefined();
    expect(s3.bytes(publication.value)?.toString()).toMatch(/^preview:/u);
    expect((await view(a)).screenshotUrl).toBe(
      `https://screenshots.example.test/${encodeURIComponent(publication.value)}`,
    );
  });
});

test("reclaims a rejected older capture while retaining the newer accepted preview", async () => {
  await setupApp({
    context,
    routes: cronBrowserReconcileRoutes,
    isolatePg: true,
  });
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    await open(a);
    const s3 = storage();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let stale: string | undefined;
    s3.controls.beforeUpload = async (key) => {
      if (!stale) {
        stale = key;
        entered.resolve();
        await release.promise;
      }
    };
    const earlier = settleIncludingAbort(
      accept(
        client().close({ headers, params: { threadId: a.threadId }, body: {} }),
        [200],
      ),
    );
    const newer = await settleIncludingAbort(async () => {
      await Promise.race([
        entered.promise,
        earlier.then(() => {
          throw new Error("Expected the older screenshot upload");
        }),
      ]);
      mockNow(START + 1000);
      return await capture(a);
    });
    release.resolve();
    const completed = await earlier;
    if (!newer.ok) {
      throw newer.error;
    }
    if (!completed.ok) {
      throw completed.error;
    }
    if (!stale) {
      throw new Error("Expected the rejected upload identity");
    }
    await sweep();
    expect(s3.bytes(stale)).toBeUndefined();
    expect(s3.bytes(newer.value)?.toString()).toMatch(/^preview:/u);
    expect((await view(a)).screenshotUrl).toBe(
      `https://screenshots.example.test/${encodeURIComponent(newer.value)}`,
    );
    await createChatFilesBddApi(context).requestWebFileUrl(
      f.owned.actor,
      stale.split("/")[1] ?? "",
      [404],
    );
  });
});
