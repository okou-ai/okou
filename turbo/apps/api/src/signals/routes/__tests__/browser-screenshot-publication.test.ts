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
import { flushWaitUntilForTest } from "../../context/wait-until";
import { browserRoutes } from "../browser";
import { cronBrowserReconcileRoutes } from "../cron-browser-reconcile";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import { createSharedBrowserFixtures } from "./helpers/browser-shared-fixture";

const context = testContext();
const { fixture, open, view } = createSharedBrowserFixtures(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

function reconcile() {
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
  const location = (bucket: string, key: string) => {
    return `${bucket}/${key}`;
  };
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (command instanceof PutObjectCommand) {
      const { Bucket, Key, Body } = command.input;
      if (
        Bucket &&
        Key &&
        (typeof Body === "string" || Buffer.isBuffer(Body))
      ) {
        objects.set(location(Bucket, Key), Buffer.from(Body));
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
    bytes: (key: string) => {
      return objects.get(location("test-private-artifacts", key));
    },
  };
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
    await reconcile();
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

test("keeps the accepted screenshot downloadable after the shared provider retires", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    await open(a);
    const s3 = storage();
    await accept(
      client().close({ headers, params: { threadId: a.threadId }, body: {} }),
      [200],
    );
    const published = await view(a);
    if (!published.screenshotUrl) {
      throw new Error("Expected the chat's accepted screenshot");
    }
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
    expect(s3.bytes(key)?.toString()).toMatch(/^preview:/u);
    expect(inactive.screenshotUrl).toBe(published.screenshotUrl);
    await createChatFilesBddApi(context).requestWebFileUrl(
      f.owned.actor,
      key.split("/")[1] ?? "",
      [200],
    );
  });
});
