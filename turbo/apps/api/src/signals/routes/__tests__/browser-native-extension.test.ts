import { randomUUID } from "node:crypto";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { expect, test } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { browserRoutes } from "../browser";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import {
  createSharedBrowserFixtures,
  MINUTE,
  START,
} from "./helpers/browser-shared-fixture";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";

const context = testContext();
const { fixture, open, renew, view } = createSharedBrowserFixtures(context);
function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Chat = Awaited<ReturnType<Fixture["start"]>>;
function use(chat: Chat) {
  return client().use({
    headers: { authorization: `Bearer ${okouTokenFromClaim(chat.claim)}` },
    body: {},
  });
}

test("keeps public window health traffic constant as sibling tabs grow", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    const a = await f.start();
    const b = await f.start();
    await open(a);
    const sibling = await open(b);
    const windowId = sibling.window?.primaryWindowId;
    if (windowId === undefined) {
      throw new Error("Expected B's native window");
    }
    const before = f.provider.native.commands.length;
    await renew(a);
    const small = f.provider.native.commands.length - before;
    for (let index = 0; index < 50; index++) {
      const targetId = randomUUID();
      f.provider.native.targets.set(targetId, {
        targetId,
        windowId,
        url: `https://b.example.test/${index}`,
      });
    }
    const expanded = f.provider.native.commands.length;
    await renew(a);
    expect(f.provider.native.commands.length - expanded).toBe(small);
    expect(small).toBeGreaterThan(0);
    expect((await view(b)).window).toStrictEqual(sibling.window);
  });
});

test.each(["empty closing-window snapshot", "unavailable bridge"] as const)(
  "preserves scoped recovery after a native %s",
  async (failure) => {
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
      page.url = "https://a.example.test/native-recovery";
      mockNow(START + 9 * MINUTE);
      await renew(b);
      mockNow(START + 11 * MINUTE);
      if (failure === "empty closing-window snapshot") {
        f.provider.native.emptySnapshot = true;
      } else {
        f.provider.native.bridgeAvailable = false;
      }
      expect((await use(a)).status).toBe(409);
      expect((await view(b)).window).toStrictEqual(sibling.window);
      expect(f.provider.sessionRequests).toHaveLength(1);
      f.provider.native.emptySnapshot = false;
      f.provider.native.bridgeAvailable = true;
      const reopened = await open(a);
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
      ).toStrictEqual(["https://a.example.test/native-recovery"]);
      expect((await view(b)).window).toStrictEqual(sibling.window);
      expect(f.provider.sessionRequests).toHaveLength(1);
    });
  },
);

test.each([
  "unfinished window close",
  "lost close reply",
  "seed close error",
] as const)(
  "restores accepted URLs and eventually stops the Browser after %s",
  async (failure) => {
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
      const saved = "https://a.example.test/accepted";
      page.url = saved;
      mockNow(START + 9 * MINUTE);
      await renew(b);
      mockNow(START + 11 * MINUTE);
      if (failure === "unfinished window close") {
        f.provider.native.closeSucceeds = false;
      } else if (failure === "lost close reply") {
        f.provider.native.closeReply = "disconnect";
      } else {
        f.provider.native.seedCloseError = "Seed cleanup unavailable";
      }
      const reopened = await open(a);
      expect(reopened.window?.instanceId).toBe(first.window?.instanceId);
      expect(reopened.window?.primaryWindowId).not.toBe(
        first.window?.primaryWindowId,
      );
      if (failure === "unfinished window close") {
        expect(f.provider.native.targets.get(page.targetId)).toStrictEqual(
          page,
        );
        // A retired window can continue changing; its URLs are not a restore source.
        page.url = "https://orphan.example.test/do-not-restore";
      }
      expect(
        [...f.provider.native.targets.values()]
          .filter((target) => {
            return target.windowId === reopened.window?.primaryWindowId;
          })
          .map((target) => {
            return target.url;
          })
          .filter((url) => {
            return url !== "about:blank";
          }),
      ).toStrictEqual([saved]);
      expect((await view(b)).window).toStrictEqual(sibling.window);
      expect(f.provider.sessionRequests).toHaveLength(1);

      f.provider.native.closeSucceeds = true;
      f.provider.native.closeReply = "reply";
      f.provider.native.seedCloseError = undefined;
      mockNow(START + 30 * MINUTE);
      const restored = await open(a);
      expect(restored.window?.instanceId).not.toBe(first.window?.instanceId);
      expect(f.provider.stoppedSessionIds.size).toBe(1);
      expect(f.provider.sessionRequests).toHaveLength(2);
      expect(
        [...f.provider.native.targets.values()].map((target) => {
          return target.url;
        }),
      ).toStrictEqual([saved]);
      expect((await view(b)).status).toBe("suspended");
    });
  },
);

test("restores A's URLs while sibling native events advance the global sequence", async () => {
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
    if (!page || sibling.window === undefined) {
      throw new Error("Expected both native windows");
    }
    page.url = "https://a.example.test/busy-sibling";
    mockNow(START + 9 * MINUTE);
    await renew(b);
    f.provider.native.snapshotEventWindowId = sibling.window.primaryWindowId;
    mockNow(START + 11 * MINUTE);
    const reopened = await open(a);
    expect(reopened.window?.instanceId).toBe(first.window?.instanceId);
    expect(
      [...f.provider.native.targets.values()]
        .filter((target) => {
          return target.windowId === reopened.window?.primaryWindowId;
        })
        .map((target) => {
          return target.url;
        }),
    ).toStrictEqual(["https://a.example.test/busy-sibling"]);
    expect((await view(b)).window).toStrictEqual(sibling.window);
  });
});
