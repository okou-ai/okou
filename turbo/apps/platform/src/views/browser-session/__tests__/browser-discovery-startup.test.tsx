import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { click, fill } from "../../../__tests__/page-helper.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();
const first = Object.freeze({
  targetId: "one",
  title: "First",
  url: "https://first.example.com",
  windowId: 9,
});
const later = Object.freeze({
  targetId: "two",
  title: "Later",
  url: "https://later.example.com",
  windowId: 9,
});
const sibling = Object.freeze({
  targetId: "outside",
  title: "Sibling 19",
  url: "https://sibling-19.example.com",
  windowId: 19,
});
function arrange() {
  return arrangeNativePage(
    context,
    { targets: [first, later, sibling] },
    first.windowId,
  );
}
function input() {
  return screen.getByLabelText("Remote browser input");
}
async function textTo(
  cdp: ReturnType<typeof arrange>["cdp"],
  target: string,
  text: string,
) {
  await userEvent.click(input());
  fireEvent.input(input(), {
    inputType: "insertText",
    data: text,
    target: { value: text },
  });
  await waitFor(() => {
    return expect(cdp.inputForTarget(target)).toContainEqual(
      expect.objectContaining({
        method: "Input.insertText",
        params: expect.objectContaining({ text }),
      }),
    );
  });
  for (const other of cdp.targets.filter((t) => {
    return t.targetId !== target;
  })) {
    expect(cdp.inputForTarget(other.targetId)).not.toContainEqual(
      expect.objectContaining({ params: expect.objectContaining({ text }) }),
    );
  }
}
test("browser-discovery-startup-001 The second Enter navigates First after its membership is confirmed", async () => {
  const { cdp, openPage } = arrange();
  const admission = cdp.holdNextMembership(first.targetId);
  await openPage();
  await admission.received;
  const address = screen.getByRole("textbox", { name: "Address" });
  const draft = "initial-draft.example/path";
  await fill(address, draft);
  await userEvent.keyboard("{Enter}");
  await screen.findByText("The browser is not ready. Try again shortly.");
  expect(cdp.targets[0]?.url).toBe(first.url);
  await admission.release();
  await waitFor(() => {
    return expect(input()).toBeEnabled();
  });
  expect(address).toHaveFocus();
  expect(address).toHaveValue(draft);
  expect(cdp.targets[0]?.url).toBe(first.url);
  await userEvent.keyboard("{Enter}");
  await expectStreamingAt("http://" + draft);
  expect(
    cdp.targets.find((t) => {
      return t.targetId === first.targetId;
    })?.url,
  ).toBe("http://" + draft);
});
test("browser-discovery-startup-004 Selecting Later during discovery directs subsequent text to Later", async () => {
  const { cdp, openPage } = arrange();
  await openPage();
  await expectStreamingAt(first.url);
  const lookup = cdp.holdNextMembership(later.targetId);
  cdp.duplicate(first.targetId);
  await lookup.received;
  await userEvent.click(
    screen.getByLabelText("Later", { selector: '[role="tab"]' }),
  );
  expect(input()).toBeDisabled();
  await lookup.release();
  await expectStreamingAt(later.url);
  await textTo(cdp, later.targetId, "new selection after proof");
});
test("browser-discovery-startup-029 Image quality set before admission reaches the capture on First", async () => {
  const { cdp, openPage } = arrange();
  const admission = cdp.holdNextMembership(first.targetId);
  await openPage();
  await admission.received;
  await userEvent.click(screen.getByLabelText("Browser settings"));
  await userEvent.hover(await screen.findByText("Image quality"));
  const quality = await screen.findByRole("textbox", { name: "Image quality" });
  await fill(quality, "60");
  await userEvent.keyboard("{Enter}");
  expect(input()).toBeDisabled();
  await admission.release();
  await expectStreamingAt(first.url);
  await waitFor(() => {
    return expect(cdp.captures.at(-1)).toMatchObject({ quality: 60 });
  });
});
test("browser-discovery-startup-032 Moving targets during an unresolved refresh updates the window's choices", async () => {
  const arriving = {
    ...sibling,
    title: "Sibling 0",
    url: "https://sibling-0.example.com",
  };
  const { cdp, openPage } = arrangeNativePage(
    context,
    { targets: [first, later, arriving] },
    first.windowId,
  );
  await openPage();
  await expectStreamingAt(first.url);
  const proof = cdp.holdNextMembership(first.targetId);
  cdp.duplicate(first.targetId);
  await proof.received;
  cdp.move(first.targetId, sibling.windowId);
  cdp.move(arriving.targetId, first.windowId);
  cdp.duplicate(later.targetId);
  expect(input()).toBeDisabled();
  await proof.release();
  await userEvent.click(
    await screen.findByLabelText(arriving.title, { selector: '[role="tab"]' }),
  );
  await expectStreamingAt(arriving.url);
  expect(
    screen.queryByLabelText(first.title, { selector: '[role="tab"]' }),
  ).toBeNull();
  expect(
    screen.getByLabelText(arriving.title, { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
});

function selected(title: string) {
  expect(
    screen.getByLabelText(title, { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
}

function inventoryScan() {
  const neighbors = Array.from({ length: 4 }, (_, index) => {
    return {
      ...sibling,
      targetId: "neighbor-" + index,
      title: index === 0 ? "Sibling 19" : "Neighbor " + index,
    };
  });
  return arrangeNativePage(
    context,
    { targets: [first, ...neighbors, later] },
    first.windowId,
  );
}
function newTab() {
  return screen.getByLabelText("New tab", { selector: "button" });
}
test("browser-discovery-startup-002 First accepts text before Later appears", async () => {
  const { cdp, openPage } = inventoryScan();
  const background = cdp.holdNextMembership(later.targetId);
  await openPage();
  await background.received;
  await expectStreamingAt(first.url);
  expect(screen.queryByLabelText(later.title)).toBeNull();
  await textTo(cdp, first.targetId, "first frame input");
  await background.release();
  await screen.findByLabelText(later.title);
  expect(screen.queryByLabelText("Sibling 19")).toBeNull();
});
test("browser-discovery-startup-036 A tab created during a sibling lookup survives the completed scan", async () => {
  const { cdp, openPage } = inventoryScan();
  const inventory = cdp.holdNextMembership("neighbor-3");
  await openPage();
  await inventory.received;
  await expectStreamingAt(first.url);
  click(newTab());
  await inventory.release();
  await screen.findByLabelText("New tab", { selector: '[role="tab"]' });
  await screen.findByLabelText(later.title);
  expect(screen.queryByLabelText("Neighbor 3")).toBeNull();
  await waitFor(() => {
    return expect(input()).toBeEnabled();
  });
});
test("browser-discovery-startup-038 Destroying First leaves the viewer connecting until Later is discovered", async () => {
  const { cdp, openPage } = inventoryScan();
  const inventory = cdp.holdNextMembership(later.targetId);
  await openPage();
  await inventory.received;
  await expectStreamingAt(first.url);
  cdp.event("Target.targetDestroyed", { targetId: first.targetId });
  await screen.findByText("Connecting to browser…");
  expect(input()).toBeDisabled();
  expect(newTab()).toBeDisabled();
  await inventory.release();
  await expectStreamingAt(later.url);
  selected(later.title);
});
test("browser-discovery-startup-047 An unsupported membership check disables the admitted viewer", async () => {
  const { cdp, openPage } = inventoryScan();
  const inventory = cdp.holdNextMembership(later.targetId);
  await openPage();
  await inventory.received;
  await expectStreamingAt(first.url);
  await inventory.releaseFailure(
    "Browser.getWindowForTarget not supported",
    -32601,
  );
  await screen.findByText("The browser does not support this operation.");
  expect(input()).toBeDisabled();
  expect(screen.queryByLabelText(later.title)).toBeNull();
});
test("browser-discovery-startup-048 Publishing Later cannot enable input while First is still opening", async () => {
  const { cdp, openPage } = inventoryScan();
  const selection = cdp.holdNext("Page.enable");
  const inventory = cdp.holdNextMembership(later.targetId);
  await openPage();
  await Promise.all([selection.received, inventory.received]);
  await inventory.release();
  await screen.findByLabelText(later.title);
  expect(input()).toBeDisabled();
  await selection.release();
  await expectStreamingAt(first.url);
  selected(first.title);
});
test("browser-discovery-startup-033 Closing First waits for the background survivor", async () => {
  const { cdp, openPage } = arrangeNativePage(
    context,
    { targets: [first] },
    first.windowId,
  );
  await openPage();
  await expectStreamingAt(first.url);
  const background = cdp.holdNextMembership("created-1");
  cdp.duplicate(first.targetId);
  await background.received;
  const close = screen.getByLabelText("Close First");
  await waitFor(() => {
    return expect(close).toBeEnabled();
  });
  click(close);
  await background.release();
  await waitFor(() => {
    return selected("New tab");
  });
  await expectStreamingAt(first.url);
  expect(screen.queryByLabelText(first.title)).toBeNull();
  expect(
    cdp.targets
      .filter((page) => {
        return page.windowId === first.windowId;
      })
      .map((page) => {
        return page.targetId;
      }),
  ).toEqual(["created-1"]);
});
test("browser-discovery-startup-046 Moving Later during its lookup leaves First selected", async () => {
  const { cdp, openPage } = inventoryScan();
  const pending = cdp.holdNextMembership(later.targetId);
  await openPage();
  await pending.received;
  await expectStreamingAt(first.url);
  const moved = cdp.holdNextMembership(later.targetId);
  cdp.move(later.targetId, sibling.windowId);
  await pending.release();
  await moved.received;
  await moved.release();
  await expectStreamingAt(first.url);
  selected(first.title);
  expect(screen.queryByLabelText(later.title)).toBeNull();
});
test.each([
  ["009", "input-proof-frame"],
  ["015", ""],
  ["017", "retained static picture"],
])(
  "browser-discovery-startup-%s Readiness joins the first picture, input and membership",
  async (id, typed) => {
    const { cdp, openPage } = arrange();
    const setup = cdp.holdNext("Page.getLayoutMetrics");
    const picture = cdp.holdTargetFrames(first.targetId);
    await openPage();
    await Promise.all([setup.received, picture.received]);
    if (id === "015") {
      picture.release();
      cdp.holdTargetFrames(first.targetId);
    }
    const membership = cdp.holdNextMembership(first.targetId);
    const nextMembership = cdp.holdNextMembership(later.targetId);
    cdp.duplicate(first.targetId);
    await membership.received;
    expect(input()).toBeDisabled();
    if (id === "017") {
      picture.release();
      cdp.holdTargetFrames(first.targetId);
    }
    await setup.release();
    expect(input()).toBeDisabled();
    await membership.release();
    await nextMembership.received;
    await nextMembership.release();
    if (id === "009") {
      expect(input()).toBeDisabled();
      picture.release();
    }
    await expectStreamingAt(first.url);
    if (typed) await textTo(cdp, first.targetId, typed);
  },
);
test("browser-discovery-startup-049 Leaving the viewer cancels the close awaiting Later's inventory", async () => {
  const owner = createTestRuntime(context);
  const { cdp, openPage } = inventoryScan();
  const inventory = cdp.holdNextMembership(later.targetId);
  await openPage(owner);
  await inventory.received;
  await expectStreamingAt(first.url);
  click(screen.getByLabelText("Close First"));
  owner.dispose();
  await waitFor(() => {
    return expect(cdp.activeConnections()).toBe(0);
  });
  await inventory.release();
  expect(screen.queryByLabelText("Remote browser input")).toBeNull();
  expect(
    cdp.targets.filter((page) => {
      return page.windowId === first.windowId;
    }),
  ).toEqual([first, later]);
});
test("browser-discovery-startup-056 A reopened viewer selects the tab still in its window", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const { cdp, openPage } = arrange();
  await openPage();
  await expectStreamingAt(first.url);
  visibility.changeTo("hidden");
  await screen.findByText("Viewing paused");
  cdp.move(first.targetId, sibling.windowId);
  window.history.pushState(null, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await waitFor(() => {
    return expect(cdp.activeConnections()).toBe(0);
  });
  expect(screen.queryByLabelText("Remote browser input")).toBeNull();
  visibility.changeTo("visible");
  window.history.back();
  await expectStreamingAt(later.url);
  selected(later.title);
  expect(screen.queryByLabelText(first.title)).toBeNull();
});
test("browser-discovery-startup-021 Moving First retires its picture and directs input to Later", async () => {
  const { cdp, openPage } = arrange();
  const image = cdp.holdTargetFrames(first.targetId);
  await openPage();
  await image.received;
  const proof = cdp.holdNextMembership(first.targetId);
  cdp.duplicate(first.targetId);
  await proof.received;
  image.release();
  cdp.move(first.targetId, sibling.windowId);
  await proof.release();
  await expectStreamingAt(later.url);
  selected(later.title);
  expect(screen.queryByLabelText(first.title)).toBeNull();
  await textTo(cdp, later.targetId, "surviving selection");
});
test("browser-discovery-startup-051 First can navigate on resume while Later is still being checked", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const { cdp, openPage } = arrange();
  await openPage();
  await expectStreamingAt(first.url);
  visibility.changeTo("hidden");
  await screen.findByText("Viewing paused");
  const chosen = cdp.holdNextMembership(first.targetId);
  const other = cdp.holdNextMembership(later.targetId);
  cdp.duplicate(first.targetId);
  visibility.changeTo("visible");
  await chosen.received;
  expect(screen.getByLabelText("Live browser view")).toBeVisible();
  expect(input()).toBeDisabled();
  await chosen.release();
  await other.received;
  await expectStreamingAt(first.url);
  selected(first.title);
  const destination = "https://navigation.example.test/first";
  await fill(screen.getByLabelText("Address"), destination);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    return expect(
      cdp.targets.find((target) => {
        return target.targetId === first.targetId;
      })?.url,
    ).toBe(destination);
  });
  await other.release();
});
test("browser-discovery-startup-053 A second resume waits for the surviving Later tab", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const { cdp, openPage } = inventoryScan();
  const pending = cdp.holdNextMembership(later.targetId);
  await openPage();
  await pending.received;
  await expectStreamingAt(first.url);
  visibility.changeTo("hidden");
  await screen.findByText("Viewing paused");
  cdp.move(first.targetId, sibling.windowId);
  visibility.changeTo("visible");
  await waitFor(() => {
    return expect(screen.queryByText("Viewing paused")).toBeNull();
  });
  visibility.changeTo("hidden");
  await screen.findByText("Viewing paused");
  const resumed = cdp.holdNextMembership(later.targetId);
  await pending.release();
  visibility.changeTo("visible");
  await resumed.received;
  expect(input()).toBeDisabled();
  await resumed.release();
  await expectStreamingAt(later.url);
  selected(later.title);
  expect(screen.queryByLabelText(first.title)).toBeNull();
});
test("browser-discovery-startup-041 A foreign candidate resolves to an empty assigned window", async () => {
  const { cdp, openPage } = arrange();
  await openPage();
  await expectStreamingAt(first.url);
  await screen.findByLabelText(later.title);
  const candidate = cdp.holdNextMembership("created-1");
  cdp.duplicate(sibling.targetId);
  await candidate.received;
  cdp.event("Target.targetDestroyed", { targetId: first.targetId });
  cdp.event("Target.targetDestroyed", { targetId: later.targetId });
  await screen.findByText("Connecting to browser…");
  expect(input()).toBeDisabled();
  expect(newTab()).toBeDisabled();
  await candidate.release();
  await screen.findByText("No tabs open");
  click(screen.getByText("New tab", { selector: "button" }));
  await waitFor(() => {
    return expect(input()).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("");
  selected("New tab");
});
test.each([
  ["044", true],
  ["045", false],
] as const)(
  "browser-discovery-startup-%s Closing both visible tabs preserves the correct final page",
  async (_id, survives) => {
    const neighbors = Array.from({ length: 8 }, (_, i) => {
      return {
        ...sibling,
        targetId: "neighbor-" + i,
        title: "Neighbor " + i,
      };
    });
    const { cdp, openPage } = arrangeNativePage(
      context,
      { targets: [first, sibling, ...neighbors, ...(survives ? [later] : [])] },
      first.windowId,
    );
    const scanning = cdp.holdNextMembership("neighbor-3");
    await openPage();
    await scanning.received;
    await expectStreamingAt(first.url);
    cdp.move(sibling.targetId, first.windowId);
    const lastProof = cdp.holdNextMembership("neighbor-3");
    await scanning.release();
    await lastProof.received;
    const closeMoved = await screen.findByLabelText("Close Sibling 19");
    expect(screen.queryByLabelText(later.title)).toBeNull();
    click(screen.getByLabelText("Close First"));
    click(closeMoved);
    await lastProof.release();
    await waitFor(() => {
      return selected(survives ? later.title : "New tab");
    });
    expect(
      cdp.targets
        .filter((t) => {
          return t.windowId === first.windowId;
        })
        .map((t) => {
          return t.url;
        }),
    ).toEqual([survives ? later.url : "about:blank"]);
  },
);
test("browser-discovery-startup-030 The recovered quality setting survives a second membership check", async () => {
  const { cdp, openPage } = arrange();
  await openPage();
  await expectStreamingAt(first.url);
  click(screen.getByLabelText("Browser settings"));
  await userEvent.hover(await screen.findByText("Image quality"));
  const quality = await screen.findByRole("textbox", { name: "Image quality" });
  cdp.failNext("Page.startScreencast", "temporary capture failure");
  await fill(quality, "60");
  await userEvent.keyboard("{Enter}");
  const proof = cdp.holdNextMembership(first.targetId);
  cdp.duplicate(first.targetId);
  await proof.received;
  const image = cdp.holdNext("Page.startScreencast");
  await proof.release();
  await image.received;
  const confirmation = cdp.holdNextMembership(first.targetId);
  cdp.duplicate(first.targetId);
  await confirmation.received;
  await image.release();
  expect(input()).toBeDisabled();
  await confirmation.release();
  await expectStreamingAt(first.url);
  expect(cdp.captures.at(-1)).toMatchObject({ quality: 60 });
});
