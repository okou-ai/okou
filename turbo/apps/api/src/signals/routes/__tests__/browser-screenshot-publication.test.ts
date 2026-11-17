import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { browserContract } from "@okouai/api-contracts/contracts/browser";

import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";

import { browserRoutes } from "../browser";

import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import { createBrowserFixtures } from "./helpers/browser-fixture";

const context = testContext();
const { fixture, open, view } = createBrowserFixtures(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
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

test("deletes retired sibling previews without losing the surviving Browser recovery", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const s3 = storage();
    const chat = createChatFilesBddApi(context);
    const previews = [];
    for (let index = 0; index < 3; index++) {
      // Cleanup needs a thread-owned Browser, without a Run lifecycle.
      const thread = await chat.createThread(f.owned.actor, {
        agentId: f.owned.agentId,
        model: f.owned.model,
      });
      const current = { threadId: thread.id };
      const opened = await accept(
        client().open({ headers, params: current, body: {} }),
        [200],
      );
      const browser = opened.body.browser;
      const page = [...f.provider.native.targets.values()].find((target) => {
        return target.windowId === browser.window?.primaryWindowId;
      });
      if (!page) {
        throw new Error("Expected the chat's native page");
      }
      const url = `https://recovery.example.test/${current.threadId}`;
      page.url = url;
      await accept(
        client().close({
          headers,
          params: { threadId: current.threadId },
          body: {},
        }),
        [200],
      );
      const { screenshotUrl } = await view(current);
      if (!screenshotUrl) {
        throw new Error("Expected the chat's accepted preview");
      }
      const key = decodeURIComponent(new URL(screenshotUrl).pathname.slice(1));
      previews.push({ current, key, screenshotUrl, url });
    }
    const [providerId] = f.provider.sessionIds;
    if (!providerId) {
      throw new Error("Expected the shared provider instance");
    }
    f.provider.sessionIds.delete(providerId);
    f.provider.stoppedSessionIds.add(providerId);
    f.provider.native.targets.clear();
    const first = previews[0];
    if (!first) {
      throw new Error("Expected a chat with an accepted preview");
    }
    await accept(
      client().leaseByThread({ headers, params: first.current, body: {} }),
      [409],
    );
    for (const { current, screenshotUrl } of previews) {
      await expect(view(current)).resolves.toMatchObject({
        status: "suspended",
        screenshotUrl,
      });
    }

    const deleted = previews.slice(0, 2);
    const survivor = previews[2];
    if (!survivor) {
      throw new Error("Expected a retained chat");
    }
    await Promise.all([
      ...deleted.map(({ current }) => {
        return chat.deleteThread(f.owned.actor, current.threadId);
      }),
      accept(
        client().leaseByThread({ headers, params: survivor.current, body: {} }),
        [404],
      ),
    ]);
    for (const { key } of deleted) {
      expect(s3.bytes(key)).toBeUndefined();
    }
    await expect(view(survivor.current)).resolves.toMatchObject({
      status: "suspended",
      screenshotUrl: survivor.screenshotUrl,
    });
    expect(s3.bytes(survivor.key)?.toString()).toMatch(/^preview:/u);
    const reopened = await accept(
      client().open({
        headers,
        params: { threadId: survivor.current.threadId },
        body: {},
      }),
      [200],
    );
    const restored = [...f.provider.native.targets.values()]
      .filter((target) => {
        return (
          target.windowId === reopened.body.browser.window?.primaryWindowId
        );
      })
      .map((target) => {
        return target.url;
      });
    expect(restored).toStrictEqual([survivor.url]);
  });
}, 20_000);
