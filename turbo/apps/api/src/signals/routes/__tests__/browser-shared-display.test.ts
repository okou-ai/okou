import { browserContract } from "@okouai/api-contracts/contracts/browser";
import type { BrowserDisplaySize } from "@okouai/core/browser-display";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { browserRoutes } from "../browser";
import { createSharedBrowserFixtures } from "./helpers/browser-shared-fixture";

const context = testContext();
const { fixture, open } = createSharedBrowserFixtures(context);
const display = { width: 390, height: 600, dpr: 3 };

function openViewer(threadId: string, initialDisplay?: BrowserDisplaySize) {
  return setupApp({ context, routes: browserRoutes })(browserContract).open({
    headers: { authorization: "Bearer clerk-session" },
    params: { threadId },
    body: initialDisplay ? { initialDisplay } : {},
  });
}

test("a viewer seeds the provider size and calibrates native contents before publication", async () => {
  const f = await fixture();
  f.provider.native.command = (command) => {
    if (command.method === "Target.attachToTarget") {
      return { sessionId: `page-${String(command.params.targetId)}` };
    }
    if (command.method === "Page.getLayoutMetrics") {
      // Native DPR2 and page zoom1.25 must both be accounted for.
      return {
        visualViewport: { clientWidth: 2000 },
        cssVisualViewport: { clientWidth: 800, zoom: 1.25 },
      };
    }
    throw new Error(`Unexpected CDP command: ${command.method}`);
  };
  await f.owned.run(async () => {
    const chat = await f.start();
    const result = await accept(openViewer(chat.threadId, display), [200]);
    expect(f.provider.sessionRequests).toHaveLength(1);
    expect(f.provider.sessionRequests[0]).toMatchObject({
      browserScreenWidth: 1170,
      browserScreenHeight: 1800,
    });
    expect(
      f.provider.native.contentsSizes.get(
        result.body.browser.window?.primaryWindowId ?? -1,
      ),
    ).toStrictEqual({ width: 585, height: 900 });
  });
});

test("additional chat windows receive initial bounds and existing windows ignore another viewer hint", async () => {
  const f = await fixture();
  f.provider.native.command = (command) => {
    return command.method === "Target.attachToTarget"
      ? { sessionId: "initial-display-page" }
      : {
          visualViewport: { clientWidth: 800 },
          cssVisualViewport: { clientWidth: 800 },
        };
  };
  await f.owned.run(async () => {
    const first = await f.start();
    const sibling = await f.start();
    const original = await open(first);
    const created = await accept(openViewer(sibling.threadId, display), [200]);
    expect(f.provider.sessionRequests).toHaveLength(1);
    expect(f.provider.native.commands).toContainEqual(
      expect.objectContaining({
        method: "Target.createTarget",
        params: {
          url: "about:blank",
          newWindow: true,
          width: 1170,
          height: 1800,
        },
      }),
    );
    expect(
      f.provider.native.contentsSizes.get(
        created.body.browser.window?.primaryWindowId ?? -1,
      ),
    ).toStrictEqual({ width: 1170, height: 1800 });
    const sizesBefore = [...f.provider.native.contentsSizes];
    const count = f.provider.native.commands.filter((command) => {
      return command.method === "Browser.setContentsSize";
    }).length;
    const reused = await accept(
      openViewer(first.threadId, { width: 1000, height: 700, dpr: 1 }),
      [200],
    );
    expect(reused.body.browser.window).toStrictEqual(original.window);
    expect([...f.provider.native.contentsSizes]).toStrictEqual(sizesBefore);
    expect(
      f.provider.native.commands.filter((command) => {
        return command.method === "Browser.setContentsSize";
      }),
    ).toHaveLength(count);
  });
});

test.each([
  {
    name: "high-density landscape",
    display: { width: 5000, height: 3000, dpr: 3 },
    screen: { width: 3717, height: 2229 },
    contents: { width: 3717, height: 2229 },
  },
  {
    name: "high-density portrait",
    display: { width: 400, height: 1600, dpr: 3 },
    screen: { width: 1023, height: 3456 },
    contents: { width: 1023, height: 4095 },
  },
  {
    name: "a small panel",
    display: { width: 200, height: 100, dpr: 1 },
    screen: { width: 320, height: 320 },
    contents: { width: 200, height: 100 },
  },
])(
  "$name respects provider launch limits and the viewer raster budget",
  async ({ display, screen, contents }) => {
    const f = await fixture();
    f.provider.native.command = (command) => {
      return command.method === "Target.attachToTarget"
        ? { sessionId: "initial-display-page" }
        : {
            visualViewport: { clientWidth: 800 },
            cssVisualViewport: { clientWidth: 800 },
          };
    };
    await f.owned.run(async () => {
      const chat = await f.start();
      const result = await accept(openViewer(chat.threadId, display), [200]);
      // Shared raster policy constrains both physical edge and total area.
      expect(f.provider.sessionRequests[0]).toMatchObject({
        browserScreenWidth: screen.width,
        browserScreenHeight: screen.height,
      });
      expect(
        f.provider.native.contentsSizes.get(
          result.body.browser.window?.primaryWindowId ?? -1,
        ),
      ).toStrictEqual(contents);
    });
  },
);

test("a preparation target moved into another chat cannot resize that chat", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    const first = await f.start();
    const sibling = await f.start();
    const original = await open(first);
    f.provider.native.command = (command) => {
      if (command.method === "Target.attachToTarget") {
        return { sessionId: `page-${String(command.params.targetId)}` };
      }
      if (command.method === "Page.getLayoutMetrics") {
        const target = f.provider.native.targets.get(
          command.sessionId?.slice(5) ?? "",
        );
        if (!target || !original.window) {
          throw new Error("Missing exact target or original window");
        }
        target.windowId = original.window.primaryWindowId;
        return {
          visualViewport: { clientWidth: 800 },
          cssVisualViewport: { clientWidth: 800 },
        };
      }
      throw new Error(`Unexpected CDP command: ${command.method}`);
    };
    await accept(openViewer(sibling.threadId, display), [502]);
    expect(
      f.provider.native.contentsSizes.get(
        original.window?.primaryWindowId ?? -1,
      ),
    ).toStrictEqual({ width: 1440, height: 900 });
    expect(
      f.provider.native.commands.filter((command) => {
        return command.method === "Browser.setContentsSize";
      }),
    ).toHaveLength(1);
  });
});

test("opens without viewer geometry retain the provider and contents defaults", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    const chat = await f.start();
    const result = await accept(openViewer(chat.threadId), [200]);
    expect(f.provider.sessionRequests[0]).toMatchObject({
      browserScreenWidth: 1440,
      browserScreenHeight: 900,
    });
    expect(
      f.provider.native.contentsSizes.get(
        result.body.browser.window?.primaryWindowId ?? -1,
      ),
    ).toStrictEqual({ width: 1440, height: 900 });
  });
});

test("failed native calibration cleans only the unpublished candidate window", async () => {
  const f = await fixture();
  f.provider.native.command = (command) => {
    return command.method === "Target.attachToTarget"
      ? { sessionId: "initial-display-page" }
      : new Error("Native scale unavailable");
  };
  await f.owned.run(async () => {
    const first = await f.start();
    const sibling = await f.start();
    const original = await open(first);
    await accept(openViewer(sibling.threadId, display), [502]);
    const candidate = f.provider.native.created.at(-1);
    expect(candidate).toBeDefined();
    expect(f.provider.native.closed).toContain(candidate?.targetId);
    expect(
      [...f.provider.native.targets.values()].map((target) => {
        return target.windowId;
      }),
    ).toStrictEqual([original.window?.primaryWindowId]);
  });
});
