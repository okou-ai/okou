import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect, vi } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";
import { fill, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";

const context = testContext();
const home = "https://example.com";
const other = "https://other.example.com";
const primary = Object.freeze({
  targetId: "main",
  title: "Example",
  url: home,
  windowId: 0,
});
const sibling = Object.freeze({
  targetId: "notes",
  title: "Other",
  url: other,
  windowId: 1,
});
function field() {
  return screen.getByRole<HTMLInputElement>("textbox", { name: "Address" });
}
function input() {
  return screen.getByLabelText("Remote browser input");
}
function tab(label: string) {
  const result = queryAllByRoleFast("tab").find((el) => {
    return el.getAttribute("aria-label") === label;
  });
  if (!result) {
    throw new Error("Missing browser tab " + label);
  }
  return result;
}
async function replaceDraft(value: string) {
  const editor = field();
  await fill(editor, value);
  expect(editor).toHaveValue(value);
}
async function editingRemote(draft: string) {
  const session = arrangeNativePage(context);
  await session.openPage();
  await expectStreamingAt(home);
  await replaceDraft(draft);
  return session.cdp;
}
type Remote = Awaited<ReturnType<typeof editingRemote>>;
async function refreshMembership(remote: Remote) {
  const proof = remote.holdNextMembership("example-page");
  remote.duplicate("example-page");
  await proof.received;
  return proof;
}
async function submitAfterAdmission(
  remote: Remote,
  proof: Awaited<ReturnType<typeof refreshMembership>>,
  submitted: string,
) {
  const editor = field();
  await userEvent.keyboard("{Enter}");
  await screen.findByText("The browser is not ready. Try again shortly.");
  expect(editor).toHaveFocus();
  expect(editor).toHaveValue(submitted);
  expect(remote.targets[0]?.url).toBe(home);
  await proof.release();
  await waitFor(() => {
    expect(input()).toBeEnabled();
  });
  expect(remote.targets[0]?.url).toBe(home);
  await userEvent.keyboard("{Enter}");
  await expectStreamingAt("http://" + submitted);
  expect(remote.targets[0]?.url).toBe("http://" + submitted);
}
test("browser-viewer-interaction-002 The pending proof preserves the draft and insertion point", async () => {
  const remote = await editingRemote("draft.example/path");
  const editor = field();
  editor.setSelectionRange(2, 2);
  const proof = await refreshMembership(remote);
  expect(editor).toHaveFocus();
  expect(editor).toHaveValue("draft.example/path");
  expect(editor.selectionStart).toBe(2);
  await userEvent.keyboard("x");
  expect(editor.selectionStart).toBe(3);
  await submitAfterAdmission(remote, proof, "drxaft.example/path");
});
test("browser-viewer-interaction-003 Deferred membership explains a refused navigation until the next submission", async () => {
  const draft = "native-admission.example/path";
  const remote = await editingRemote(draft);
  const proof = await refreshMembership(remote);
  expect(field()).toHaveFocus();
  await submitAfterAdmission(remote, proof, draft);
});

test("browser-viewer-interaction-031 Fallback frame decoding preserves navigation and the sibling page", async () => {
  const s = arrangeNativePage(
    context,
    { nativeBase64: false, targets: [primary, sibling] },
    0,
  );
  await s.openPage();
  await expectStreamingAt(home);
  await replaceDraft("example.test/path");
  await userEvent.keyboard("{Enter}");
  await expectStreamingAt("http://example.test/path");
  expect(s.cdp.targets).toStrictEqual([
    expect.objectContaining({
      targetId: "main",
      url: "http://example.test/path",
    }),
    sibling,
  ]);
});

test("browser-viewer-interaction-038 A tab admitted from a different window leaves Example selected", async () => {
  const s = arrangeNativePage(context, { targets: [primary, sibling] }, 0);
  await s.openPage();
  await expectStreamingAt(home);
  const proof = s.cdp.holdNextMembership("main");
  s.cdp.move("notes", 0);
  await proof.received;
  await waitFor(() => {
    return expect(input()).toBeDisabled();
  });
  expect(tab("Example")).toHaveAttribute("aria-selected", "true");
  await proof.release();
  await expectStreamingAt(home);
  await waitFor(() => {
    return expect(tab("Other")).toHaveAttribute("aria-selected", "false");
  });
  expect(tab("Example")).toHaveAttribute("aria-selected", "true");
});

test("browser-viewer-interaction-015 Closing the only local tab creates a navigable blank replacement", async () => {
  const s = arrangeNativePage(context, { targets: [primary, sibling] }, 0);
  await s.openPage();
  await expectStreamingAt(home);
  await userEvent.click(screen.getByLabelText("Close Example"));
  await expectStreamingAt("");
  expect(tab("New tab")).toHaveAttribute("aria-selected", "true");
  expect(s.cdp.targets).toStrictEqual([
    sibling,
    expect.objectContaining({ windowId: 0, url: "about:blank" }),
  ]);
  const url = "https://continued.example.com/ready";
  await replaceDraft(url);
  await userEvent.keyboard("{Enter}");
  await expectStreamingAt(url);
  expect(s.cdp.targets).toStrictEqual([
    sibling,
    expect.objectContaining({ windowId: 0, url }),
  ]);
});

async function selectBeforeFirstFrame(name: string, url: string) {
  const s = arrangeNativePage(
    context,
    {
      targets: [
        primary,
        {
          targetId: "waiting",
          title: name === "New tab" ? "about:blank" : name,
          url,
          windowId: 0,
        },
      ],
    },
    0,
  );
  await s.openPage();
  await expectStreamingAt(home);
  const frame = s.cdp.holdTargetFrames("waiting");
  await userEvent.click(tab(name));
  await frame.received;
  expect(input()).toBeDisabled();
  expect(tab(name)).toHaveAttribute("aria-selected", "true");
  return { frame, remote: s.cdp };
}
test("browser-viewer-interaction-021 The blank tab covers Example before its first image", async () => {
  const { frame, remote } = await selectBeforeFirstFrame(
    "New tab",
    "about:blank",
  );
  expect(screen.getByText("Nothing open yet")).toBeVisible();
  frame.release();
  await expectStreamingAt("");
  const dest = "https://new.example.com/page";
  await replaceDraft(dest);
  await userEvent.keyboard("{Enter}");
  await expectStreamingAt(dest);
  expect(screen.queryByText("Nothing open yet")).toBeNull();
  expect(remote.targets[1]?.url).toBe(dest);
});
test("browser-viewer-interaction-028 Other is selected before its first frame enables browser actions", async () => {
  const { frame } = await selectBeforeFirstFrame("Other", other);
  expect(screen.getByLabelText("New tab")).toBeDisabled();
  expect(field()).toBeEnabled();
  frame.release();
  await expectStreamingAt(other);
  expect(screen.getByLabelText("New tab")).toBeEnabled();
});

async function openWindow(
  windowId = 0,
  targets: NonNullable<
    NonNullable<Parameters<typeof arrangeNativePage>[1]>["targets"]
  > = [primary, sibling],
) {
  const fixture = arrangeNativePage(context, { targets }, windowId);
  await fixture.openPage();
  const first = targets.find((page) => {
    return page.windowId === windowId;
  });
  if (first) {
    await expectStreamingAt(first.url);
  } else {
    await screen.findByText("No tabs open");
  }
  return fixture.cdp;
}

function newTabButton() {
  return screen.getByLabelText("New tab", {
    selector: "button[data-browser-new-tab]",
  });
}
function selected(label: string) {
  expect(tab(label)).toHaveAttribute("aria-selected", "true");
}
function created(remote: Remote) {
  const page = remote.targets.find((target) => {
    return target.targetId.startsWith("created-");
  });
  if (!page) {
    throw new Error("No created remote page");
  }
  return page;
}
async function startCreation(remote: Remote) {
  const receipt = remote.holdNextNative("createTab");
  await userEvent.click(newTabButton());
  await receipt.received;
  expect(field()).toHaveFocus();
  expect(field()).toHaveValue("");
  return receipt;
}
async function failMovedCreation(
  remote: Remote,
  receipt: Awaited<ReturnType<typeof startCreation>>,
) {
  remote.move(created(remote).targetId, 42);
  await receipt.release();
  await screen.findByText(
    "The browser action could not be completed. Check the browser before trying again.",
  );
  await waitFor(() => {
    selected("Example");
    expect(input()).toBeEnabled();
  });
  expect(
    remote.targets.find((t) => {
      return t.targetId === primary.targetId;
    })?.url,
  ).toBe(home);
}
async function navigateFromEditor(
  remote: Remote,
  targetId: string,
  draft: string,
) {
  await replaceDraft(draft);
  await userEvent.keyboard("{Enter}");
  const url = "http://" + draft;
  await waitFor(() => {
    return selected(new URL(url).hostname);
  });
  expect(
    remote.targets.find((page) => {
      return page.targetId === targetId;
    })?.url,
  ).toBe(url);
}
async function documentArrives(remote: Remote, targetId: string, url: string) {
  remote.navigate(remote.pageSession(targetId), url);
  await waitFor(() => {
    return selected(new URL(url).hostname);
  });
}

test("browser-viewer-interaction-005 Escape selects the restored address through a background navigation", async () => {
  const remote = await editingRemote("discarded.example/path");
  await userEvent.keyboard("{Escape}");
  const address = field();
  expect(address).toHaveFocus();
  expect(address).toHaveValue(home);
  expect([address.selectionStart, address.selectionEnd]).toStrictEqual([
    0,
    home.length,
  ]);
  await documentArrives(remote, "example-page", "https://background.example/");
  expect(address).toHaveFocus();
  expect(address).toHaveValue(home);
  await userEvent.click(input());
  expect(address).toHaveValue("https://background.example/");
});

test("browser-viewer-interaction-008 The focused empty editor survives a moved creation", async () => {
  const remote = await openWindow();
  const receipt = await startCreation(remote);
  await userEvent.click(field());
  await failMovedCreation(remote, receipt);
  expect(field()).toHaveFocus();
  expect(field()).toHaveValue("");
  await userEvent.click(input());
  await navigateFromEditor(remote, "main", "after-failure.example/path");
});

test("browser-viewer-interaction-011 Escape from a failed creation lets the user address Example again", async () => {
  const remote = await openWindow();
  const receipt = await startCreation(remote);
  await replaceDraft("retained.example/path");
  await failMovedCreation(remote, receipt);
  await userEvent.keyboard("{Enter}");
  expect(field()).toHaveFocus();
  expect(field()).toHaveValue("retained.example/path");
  expect(
    remote.targets.find((t) => {
      return t.targetId === "main";
    })?.url,
  ).toBe(home);
  await userEvent.keyboard("{Escape}");
  expect(field()).toHaveValue(home);
  await navigateFromEditor(remote, "main", "chosen.example/path");
});

test("browser-viewer-interaction-012 A failed draft cannot navigate the first subsequently admitted tab", async () => {
  const remote = await openWindow(0, [sibling]);
  const receipt = await startCreation(remote);
  await replaceDraft("failed-intent.example/path");
  remote.move(created(remote).targetId, 42);
  await receipt.release();
  await screen.findByText(
    "The browser action could not be completed. Check the browser before trying again.",
  );
  await screen.findByText("No tabs open");
  remote.move("notes", 0);
  await waitFor(() => {
    selected("Other");
    expect(input()).toBeEnabled();
  });
  expect(field()).toHaveValue("failed-intent.example/path");
  expect(field()).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(
    remote.targets.find((t) => {
      return t.targetId === "notes";
    })?.url,
  ).toBe(other);
  expect(field()).toHaveValue("failed-intent.example/path");
  await userEvent.keyboard("{Escape}");
  expect(field()).toHaveValue(other);
});

test.each([
  ["013", 0, primary],
  ["014", 1, sibling],
] as const)(
  "browser-viewer-interaction-%s An early address stays with the new blank in window %i",
  async (_id, owner, original) => {
    const remote = await openWindow(owner);
    const receipt = await startCreation(remote);
    const copy = created(remote);
    const firstFrame = remote.holdTargetFrames(copy.targetId);
    await replaceDraft("draft.example/path");
    await userEvent.keyboard("{Enter}");
    await screen.findByText("The browser is not ready. Try again shortly.");
    expect(field()).toHaveValue("draft.example/path");
    await receipt.release();
    await firstFrame.received;
    firstFrame.release();
    await waitFor(() => {
      selected("New tab");
      expect(input()).toBeEnabled();
    });
    expect(field()).toHaveValue("draft.example/path");
    expect(copy).toMatchObject({ url: "about:blank", windowId: owner });
    await userEvent.click(screen.getByLabelText("Close New tab"));
    await waitFor(() => {
      selected(original.title);
      expect(input()).toBeEnabled();
    });
    expect(remote.targets).toStrictEqual([primary, sibling]);
  },
);

test("browser-viewer-interaction-018 The last page stays open until its replacement navigation finishes", async () => {
  const remote = await openWindow();
  const preparation = remote.holdNext("Page.navigate");
  await userEvent.click(screen.getByLabelText("Close Example"));
  await preparation.received;
  expect(screen.getByLabelText("Close Example")).toBeDisabled();
  expect(remote.targets).toContainEqual(primary);
  await preparation.release();
  await expectStreamingAt("");
  selected("New tab");
  expect(remote.targets).toStrictEqual([
    sibling,
    expect.objectContaining({ url: "about:blank", windowId: 0 }),
  ]);
});
test("browser-viewer-interaction-022 Selecting Other during creation preserves its focused draft", async () => {
  const remote = await openWindow(0, [primary, { ...sibling, windowId: 0 }]);
  const receipt = await startCreation(remote);
  const id = created(remote).targetId;
  await userEvent.click(tab("Other"));
  await expectStreamingAt(other);
  await replaceDraft("later-choice.example/draft");
  await receipt.release();
  await waitFor(() => {
    return expect(
      remote.targets.some((t) => {
        return t.targetId === id;
      }),
    ).toBeFalsy();
  });
  selected("Other");
  expect(field()).toHaveFocus();
  expect(field()).toHaveValue("later-choice.example/draft");
  expect(screen.queryByText("Browser view unavailable")).toBeNull();
});
test("browser-viewer-interaction-023 Dismissing settings keeps its focus when the first new-tab frame arrives", async () => {
  const remote = await openWindow();
  const receipt = await startCreation(remote);
  const frame = remote.holdTargetFrames(created(remote).targetId);
  const settings = screen.getByLabelText("Browser settings");
  await userEvent.click(settings);
  await screen.findByText("Image format");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(settings).toHaveFocus();
  });
  await receipt.release();
  await frame.received;
  frame.release();
  await expectStreamingAt("");
  selected("New tab");
  expect(settings).toHaveFocus();
  expect(newTabButton()).toBeEnabled();
});
test.each([
  ["026", false],
  ["027", true],
] as const)(
  "browser-viewer-interaction-%s Focused new-tab address tracks documents according to user interaction (%s)",
  async (_id, touched) => {
    const remote = await openWindow();
    const receipt = await startCreation(remote);
    const id = created(remote).targetId;
    if (touched) {
      await userEvent.click(field());
    }
    await receipt.release();
    await expectStreamingAt("");
    selected("New tab");
    for (const url of ["https://first.example/", "https://second.example/"]) {
      await documentArrives(remote, id, url);
      expect(field()).toHaveFocus();
      expect(field()).toHaveValue(touched ? "" : url);
    }
    await userEvent.click(input());
    expect(field()).toHaveValue("https://second.example/");
  },
);
test.each(["032", "034", "035"])(
  "browser-viewer-interaction-%s Editing the caret while a navigation receipt is held preserves the local draft",
  async (id) => {
    const draft = "submitted.example/path";
    const remote = await editingRemote(draft);
    const receipt = remote.holdNext("Page.navigate");
    await userEvent.keyboard("{Enter}");
    await receipt.received;
    const address = field();
    if (id === "035") {
      await userEvent.click(screen.getByLabelText("Browser settings"));
      await screen.findByText("Image format");
      await userEvent.keyboard("{Escape}");
      await userEvent.click(address);
    }
    expect(address).toHaveAttribute("aria-busy", "true");
    if (id === "032") {
      await userEvent.keyboard("{Home}{ArrowRight}{ArrowRight}");
    } else {
      address.setSelectionRange(2, 2);
    }
    if (id === "034") {
      fireEvent.compositionStart(address);
    }
    await receipt.release();
    await waitFor(() => {
      return expect(address).toHaveAttribute("aria-busy", "false");
    });
    await waitFor(() => {
      return selected("submitted.example");
    });
    expect(address).toHaveFocus();
    expect(address).toHaveValue(draft);
    expect([address.selectionStart, address.selectionEnd]).toStrictEqual([
      2, 2,
    ]);
    if (id === "034") {
      fireEvent.compositionEnd(address);
    }
    await userEvent.click(input());
    await expectStreamingAt("http://" + draft);
    expect(remote.targets[0]?.url).toBe("http://" + draft);
  },
);
test("browser-viewer-interaction-037 A held receipt rejects the second submit until its alert clears", async () => {
  const remote = await editingRemote("first-choice.example/path");
  const receipt = remote.holdNext("Page.navigate");
  await userEvent.keyboard("{Enter}");
  await receipt.received;
  await replaceDraft("second-choice.example/path");
  await userEvent.keyboard("{Enter}");
  const warning = "A page is still opening. Try again shortly.";
  await screen.findByText(warning);
  expect(remote.targets[0]?.url).toBe("http://first-choice.example/path");
  await receipt.release();
  await waitFor(() => {
    return expect(screen.queryByText(warning)).toBeNull();
  });
  expect(field()).toHaveFocus();
  expect(field()).toHaveValue("second-choice.example/path");
  await userEvent.keyboard("{Enter}");
  await expectStreamingAt("http://second-choice.example/path");
  expect(remote.targets[0]?.url).toBe("http://second-choice.example/path");
});
test("browser-viewer-interaction-043 The first tab belongs to the empty assigned window", async () => {
  const remote = await openWindow(0, [sibling]);
  await userEvent.click(newTabButton());
  await expectStreamingAt("");
  selected("New tab");
  expect(field()).toHaveFocus();
  expect(remote.targets).toStrictEqual([
    sibling,
    expect.objectContaining({ url: "about:blank", windowId: 0 }),
  ]);
});
test("browser-viewer-interaction-165 Selecting PNG changes capture and disables Lossless quality", async () => {
  const remote = await openWindow();
  const settings = screen.getByLabelText("Browser settings");
  await userEvent.click(settings);
  await userEvent.click(await screen.findByText("Image format"));
  await userEvent.click(await screen.findByText("PNG"));
  await waitFor(() => {
    return expect(remote.captures.at(-1)).toMatchObject({ format: "png" });
  });
  if (!screen.queryByText("Lossless")) {
    await userEvent.click(settings);
  }
  const lossless = await screen.findByText("Lossless");
  expect(lossless.closest('[role="menuitem"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(input()).toBeEnabled();
});

test("browser-viewer-interaction-166 The remote viewport follows the measured 900 by 600 panel", async () => {
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, 900, 600));
  const session = arrangeNativePage(context);
  expect(session.cdp.viewport).toStrictEqual({ width: 1440, height: 900 });
  await session.openPage();
  await expectStreamingAt(home);
  await userEvent.click(screen.getByLabelText("Browser settings"));
  await userEvent.hover(await screen.findByText("Window size"));
  const mode = await screen.findByText("Follow panel");
  expect(mode.closest('[role="menuitemradio"]')).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await waitFor(() => {
    expect(session.cdp.viewport).toStrictEqual({ width: 900, height: 600 });
  });
  expect(input()).toBeEnabled();
  expect(field()).toHaveValue(home);
});
test("browser-viewer-interaction-017 Closing two established tabs never adopts the abandoned creation", async () => {
  const remote = await openWindow();
  const outstanding = await startCreation(remote);
  const abandoned = created(remote).targetId;
  await userEvent.click(screen.getByLabelText("Close Example"));
  await expectStreamingAt("");
  selected("New tab");
  expect(
    remote.targets.some((t) => {
      return t.targetId === "main";
    }),
  ).toBeFalsy();
  const replacement = remote.targets.find((t) => {
    return t.targetId !== abandoned && t.windowId === 0;
  });
  if (!replacement || replacement.url !== "about:blank") {
    throw new Error("Missing prepared blank");
  }
  await userEvent.click(
    screen.getByLabelText("Close New tab", {
      selector: `[data-close-target="${replacement.targetId}"]`,
    }),
  );
  await waitFor(() => {
    expect(remote.targets).not.toContain(replacement);
    expect(input()).toBeEnabled();
    selected("New tab");
  });
  await outstanding.release();
  await waitFor(() => {
    return expect(remote.targets).toStrictEqual([
      sibling,
      expect.objectContaining({ url: "about:blank", windowId: 0 }),
    ]);
  });
  expect(
    remote.targets.some((t) => {
      return t.targetId === abandoned;
    }),
  ).toBeFalsy();
  await expectStreamingAt("");
  selected("New tab");
});
test("browser-viewer-interaction-019 Concurrent closes leave one usable blank in the original window", async () => {
  const remote = await openWindow(0, [primary, { ...sibling, windowId: 0 }]);
  const first = remote.holdClose("main");
  await userEvent.click(screen.getByLabelText("Close Example"));
  await first.received;
  const second = remote.holdClose("notes");
  await userEvent.click(screen.getByLabelText("Close Other"));
  await second.received;
  expect(remote.targets).toStrictEqual(
    expect.arrayContaining([
      primary,
      { ...sibling, windowId: 0 },
      expect.objectContaining({ url: "about:blank", windowId: 0 }),
    ]),
  );
  await second.release();
  await first.release();
  await expectStreamingAt("");
  selected("New tab");
  expect(remote.targets).toStrictEqual([
    expect.objectContaining({ windowId: 0, url: "about:blank" }),
  ]);
});
test("browser-viewer-interaction-042 A late Other attachment cannot enable the disconnected viewer", async () => {
  const trace = context.mocks.sentry();
  const reopened = context.mocks.deferred<void>();
  let closing = false;
  const session = arrangeNativePage(
    context,
    {
      targets: [primary, { ...sibling, windowId: 0 }],
      onConnecting: () => {
        if (closing) {
          reopened.resolve();
        }
      },
    },
    0,
  );
  await session.openPage();
  await expectStreamingAt(home);
  const remote = session.cdp;
  const attachment = remote.holdNext("Target.attachToTarget", "notes");
  await userEvent.click(tab("Other"));
  await attachment.received;
  selected("Other");
  remote.move("notes", 51);
  await waitFor(() => {
    return expect(
      queryAllByRoleFast("tab").find((t) => {
        return t.getAttribute("aria-label") === "Other";
      }) ?? null,
    ).toBeNull();
  });
  remote.setAutoOpen(false);
  closing = true;
  remote.disconnect({ code: 1006, wasClean: false });
  expect(trace.breadcrumbs).toContainEqual(
    expect.objectContaining({
      category: "browser.connection",
      data: expect.objectContaining({
        source: "native-close",
        cancelled_awaiting_response: 1,
        pending_requests: 0,
      }),
    }),
  );
  await reopened.promise;
  await attachment.release();
  await userEvent.type(input(), "x");
  expect(input()).toBeDisabled();
  expect(remote.inputForTarget("notes")).toStrictEqual([]);
});
test("browser-viewer-interaction-048 The moved target survives a rejected create receipt", async () => {
  const remote = await openWindow();
  const receipt = await startCreation(remote);
  const target = created(remote);
  await failMovedCreation(remote, receipt);
  expect(remote.targets).toContainEqual(
    expect.objectContaining({ targetId: target.targetId, windowId: 42 }),
  );
  await expectStreamingAt(home);
  selected("Example");
});
test("browser-viewer-interaction-030 Recovery retries the first image on the original blank target", async () => {
  const remote = await openWindow();
  const creation = await startCreation(remote);
  const blank = created(remote);
  const first = remote.holdTargetFrames(blank.targetId);
  await creation.release();
  await first.received;
  expect(input()).toBeDisabled();
  first.release("!bad");
  const retry = remote.holdTargetFrames(blank.targetId);
  await screen.findByText("Reconnecting…");
  await retry.received;
  expect(input()).toBeDisabled();
  retry.release();
  await expectStreamingAt("");
  expect(screen.queryByText("Reconnecting…")).toBeNull();
  selected("New tab");
  expect(
    queryAllByRoleFast("tab").map((item) => {
      return item.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Example", "New tab"]);
  expect(remote.targets).toStrictEqual([
    primary,
    sibling,
    expect.objectContaining({
      targetId: blank.targetId,
      url: "about:blank",
      windowId: 0,
    }),
  ]);
});

function localPair() {
  return openWindow(0, [primary, { ...sibling, windowId: 0 }]);
}

test.each([
  ["049", "create receipt"],
  ["052", "membership"],
])(
  "browser-viewer-interaction-%s Another caller's destination survives the delayed %s",
  async (id) => {
    const remote = await openWindow();
    const creation = await startCreation(remote);
    const target = created(remote);
    const marker = target.url;
    expect(marker).toMatch(/^about:blank#.+/);
    if (id === "052") {
      const membership = remote.holdNextMembership(target.targetId);
      await creation.release();
      await membership.received;
      remote.beginNavigation(
        target.targetId,
        "https://user-navigation.example.com",
      );
      await membership.release();
    } else {
      remote.beginNavigation(
        target.targetId,
        "https://user-navigation.example.com",
      );
      await creation.release();
    }
    await screen.findByText(
      "The browser action could not be completed. Check the browser before trying again.",
    );
    await expectStreamingAt(home);
    selected("Example");
    expect(created(remote)).toMatchObject({
      targetId: target.targetId,
      url: marker,
      pendingUrl: "https://user-navigation.example.com",
    });
  },
);

test("browser-viewer-interaction-050 Native updates before the admission read still admit the local blank", async () => {
  const remote = await openWindow();
  const updatedTarget = remote.updateBeforeNextTabRead();
  await userEvent.click(newTabButton());
  await waitFor(() => {
    return selected("New tab");
  });
  await expectStreamingAt("");
  expect(created(remote)).toMatchObject({
    targetId: await updatedTarget,
    windowId: 0,
    url: "about:blank",
  });
});
test("browser-viewer-interaction-058 Mailto reaches the selected remote document intact", async () => {
  const uri = "mailto:user@example.com";
  const remote = await editingRemote(uri);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    return expect(remote.targets[0]?.url).toBe(uri);
  });
  await expectStreamingAt(uri);
});
test("browser-viewer-interaction-076 Draft focus survives closing Other", async () => {
  const remote = await localPair();
  await userEvent.click(tab("Other"));
  await expectStreamingAt(other);
  const close = remote.holdClose("notes");
  await userEvent.click(screen.getByLabelText("Close Other"));
  await close.received;
  await replaceDraft("draft.example");
  await close.release();
  await waitFor(() => {
    return selected("Example");
  });
  expect(remote.targets).toStrictEqual([primary]);
  expect(field()).toHaveFocus();
  expect(field()).toHaveValue("draft.example");
});
test("browser-viewer-interaction-079 A removed keyboard target returns focus once", async () => {
  const remote = await localPair();
  await userEvent.click(tab("Example"));
  await userEvent.keyboard("{ArrowRight}");
  expect(tab("Other")).toHaveFocus();
  remote.event("Target.targetDestroyed", { targetId: "notes" });
  await waitFor(() => {
    return expect(tab("Example")).toHaveFocus();
  });
  await replaceDraft("keep-focus.example");
  const target = remote.targets[0]!;
  target.title = "Updated report";
  remote.event("Target.targetInfoChanged", {
    targetInfo: { ...target, type: "page" },
  });
  await waitFor(() => {
    return selected("Updated report");
  });
  expect(field()).toHaveValue("keep-focus.example");
  expect(field()).toHaveFocus();
});
test("browser-viewer-interaction-080 Other receives tab focus before its first image", async () => {
  const remote = await localPair();
  const image = remote.holdTargetFrames("notes");
  await userEvent.click(screen.getByLabelText("Close Example"));
  await image.received;
  await waitFor(() => {
    return expect(tab("Other")).toHaveFocus();
  });
  selected("Other");
  expect(input()).toBeDisabled();
  image.release();
  await expectStreamingAt(other);
});

function presentPreview() {
  expect(screen.getByRole("img", { name: "Live browser view" })).toBeVisible();
  expect(screen.queryByText("Connecting to browser…")).toBeNull();
}
test("browser-viewer-interaction-082 Other retains its image while its visible page refreshes", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const remote = await localPair();
  await userEvent.click(tab("Other"));
  await expectStreamingAt(other);
  const replacement = remote.holdTargetFrames("notes");
  visibility.changeTo("hidden");
  await waitFor(() => {
    return expect(input()).toBeDisabled();
  });
  visibility.changeTo("visible");
  await replacement.received;
  await screen.findByText("Updating view…");
  presentPreview();
  expect(input()).toBeDisabled();
  replacement.release();
  await expectStreamingAt(other);
  selected("Other");
});
test("browser-viewer-interaction-083 Repeated resumes wait for the original stop and the new image", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const remote = await openWindow();
  const stop = remote.holdNext("Page.stopScreencast");
  visibility.changeTo("hidden");
  await stop.received;
  visibility.changeTo("visible");
  visibility.changeTo("hidden");
  visibility.changeTo("visible");
  await waitFor(presentPreview);
  expect(input()).toBeDisabled();
  const image = remote.holdTargetFrames("main");
  await stop.release();
  await image.received;
  presentPreview();
  expect(input()).toBeDisabled();
  image.release();
  await expectStreamingAt(home);
  await navigateFromEditor(remote, "main", "recovered.example/path");
});
test("browser-viewer-interaction-098 A paused draft only navigates on the second submission", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const remote = await openWindow();
  const draft = "local-draft.example/path";
  await replaceDraft(draft);
  const image = remote.holdTargetFrames("main");
  visibility.changeTo("hidden");
  await waitFor(() => {
    return expect(input()).toBeDisabled();
  });
  visibility.changeTo("visible");
  await image.received;
  expect(field()).toHaveValue(draft);
  await userEvent.click(field());
  await userEvent.keyboard("{Enter}");
  await screen.findByText("The browser is not ready. Try again shortly.");
  expect(field()).toHaveValue(draft);
  expect(remote.targets[0]?.url).toBe(home);
  image.release();
  await waitFor(() => {
    return expect(input()).toBeEnabled();
  });
  expect(remote.targets[0]?.url).toBe(home);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    return expect(remote.targets[0]?.url).toBe("http://" + draft);
  });
});
test("browser-viewer-interaction-100 A document changed in the background supplies the resumed address", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const remote = await localPair();
  await userEvent.click(tab("Other"));
  await expectStreamingAt(other);
  const image = remote.holdTargetFrames("notes");
  visibility.changeTo("hidden");
  await waitFor(() => {
    return expect(input()).toBeDisabled();
  });
  const destination = "https://background.example/changed";
  remote.navigate(remote.pageSession("notes"), destination);
  visibility.changeTo("visible");
  await image.received;
  await waitFor(() => {
    return expect(field()).toHaveValue(destination);
  });
  expect(input()).toBeDisabled();
  image.release();
  await expectStreamingAt(destination);
  await navigateFromEditor(
    remote,
    "notes",
    "after-background-navigation.example/ready",
  );
  expect(remote.targets[0]?.url).toBe(home);
});
test("browser-viewer-interaction-101 A second pause before paint retains the multi-tab preview", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const remote = await localPair();
  const first = remote.holdTargetFrames("main");
  visibility.changeTo("hidden");
  await waitFor(() => {
    return expect(input()).toBeDisabled();
  });
  visibility.changeTo("visible");
  await first.received;
  const stop = remote.holdNext("Page.stopScreencast");
  visibility.changeTo("hidden");
  await stop.received;
  const capture = remote.holdNext("Page.startScreencast");
  const image = remote.holdTargetFrames("main");
  visibility.changeTo("visible");
  await stop.release();
  await capture.received;
  presentPreview();
  expect(input()).toBeDisabled();
  await capture.release();
  await image.received;
  expect(input()).toBeDisabled();
  image.release();
  await expectStreamingAt(home);
});
function insertText(text: string) {
  fireEvent.input(input(), {
    target: { value: text },
    inputType: "insertText",
    data: text,
  });
}
function ime(phase: "compositionupdate" | "compositionend", data: string) {
  fireEvent(
    input(),
    Object.assign(new Event(phase, { bubbles: true }), { data }),
  );
}
function compose(text: string) {
  fireEvent.compositionStart(input());
  ime("compositionupdate", text);
  fireEvent.input(input(), {
    target: { value: text },
    data: text,
    isComposing: true,
    inputType: "insertCompositionText",
  });
}
function inserted(remote: Remote, target: string) {
  return remote
    .inputForTarget(target)
    .filter((e) => {
      return e.method === "Input.insertText";
    })
    .map((e) => {
      return e.params?.text;
    });
}
function softDelete() {
  fireEvent(
    input(),
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    }),
  );
}
function backspaces(remote: Remote, target: string) {
  return remote
    .inputForTarget(target)
    .filter((e) => {
      return e.params?.key === "Backspace";
    })
    .map((e) => {
      return e.params?.type;
    });
}
test("browser-viewer-interaction-071 A replaced composition cannot forward Enter or delete to Other", async () => {
  const remote = await localPair();
  await userEvent.click(input());
  const preedit = remote.holdNext("Input.imeSetComposition");
  compose("old");
  await preedit.received;
  ime("compositionend", "old");
  fireEvent.submit(input().closest("form")!);
  softDelete();
  await userEvent.click(tab("Other"));
  await expectStreamingAt(other);
  await preedit.release();
  await userEvent.click(input());
  insertText("fresh");
  softDelete();
  await waitFor(() => {
    return expect(backspaces(remote, "notes")).toStrictEqual([
      "rawKeyDown",
      "keyUp",
    ]);
  });
  expect(inserted(remote, "notes")).toStrictEqual(["fresh"]);
  expect(backspaces(remote, "main")).toStrictEqual([]);
  expect(
    remote.inputForTarget("notes").filter((e) => {
      return (
        e.params?.key === "Enter" || e.method === "Input.imeSetComposition"
      );
    }),
  ).toStrictEqual([]);
});
test("browser-viewer-interaction-072 Backward deletion distinguishes preedit from committed text", async () => {
  const remote = await openWindow();
  await userEvent.click(input());
  compose("中国");
  fireEvent.input(input(), {
    target: { value: "中" },
    data: null,
    isComposing: true,
    inputType: "deleteContentBackward",
  });
  ime("compositionupdate", "中");
  await waitFor(() => {
    expect(remote.inputForTarget("main")).toContainEqual(
      expect.objectContaining({
        method: "Input.imeSetComposition",
        params: expect.objectContaining({ text: "中" }),
      }),
    );
  });
  expect(input()).toHaveValue("中");
  ime("compositionend", "中");
  softDelete();
  insertText("fresh");
  await waitFor(() => {
    return expect(inserted(remote, "main")).toStrictEqual(["中", "fresh"]);
  });
  expect(backspaces(remote, "main")).toStrictEqual(["rawKeyDown", "keyUp"]);
});
test("browser-viewer-interaction-073 The IME confirms text while the editing read is outstanding", async () => {
  const remote = await openWindow();
  const metadata = remote.holdNext("editing-context");
  await userEvent.click(input());
  await metadata.received;
  compose("中");
  await waitFor(() => {
    return expect(remote.inputForTarget("main")).toContainEqual(
      expect.objectContaining({
        method: "Input.imeSetComposition",
        params: expect.objectContaining({ text: "中" }),
      }),
    );
  });
  ime("compositionend", "中");
  await waitFor(() => {
    return expect(inserted(remote, "main")).toStrictEqual(["中"]);
  });
  expect(input()).toHaveFocus();
  await metadata.release();
});
test("browser-viewer-interaction-074 Context reset retires old composition at the input boundary", async () => {
  const remote = await openWindow();
  await userEvent.click(input());
  compose("old");
  await waitFor(() => {
    return expect(remote.inputForTarget("main")).toContainEqual(
      expect.objectContaining({
        method: "Input.imeSetComposition",
        params: expect.objectContaining({ text: "old" }),
      }),
    );
  });
  remote.event(
    "Runtime.executionContextsCleared",
    undefined,
    remote.pageSession("main"),
  );
  await waitFor(() => {
    return expect(
      screen
        .getByRole("img", { name: "Live browser view" })
        .closest("[data-browser-surface]"),
    ).toHaveFocus();
  });
  ime("compositionend", "old");
  await userEvent.click(input());
  insertText("fresh");
  await waitFor(() => {
    return expect(inserted(remote, "main")).toStrictEqual(["fresh"]);
  });
});

function remoteField(
  type: string,
  extras: Partial<{
    inputMode: string;
    enterKeyHint: string;
    lang: string;
    autoCapitalize: string;
    multiline: boolean;
  }> = {},
) {
  return {
    x: 25,
    y: 30,
    width: 160,
    height: 90,
    offsetX: 0,
    offsetY: 0,
    editing: {
      type,
      multiline: false,
      inputMode: "",
      enterKeyHint: "",
      lang: "en",
      autoCapitalize: "words",
      ...extras,
    },
  };
}
function hints(
  mode: string,
  hint: string,
  lang: string,
  capital: string,
  type = "text",
) {
  const proxy = input();
  expect(proxy).toHaveFocus();
  expect(proxy).toHaveAttribute("type", type);
  expect(proxy).toHaveAttribute("inputmode", mode);
  expect(proxy).toHaveAttribute("enterkeyhint", hint);
  expect(proxy).toHaveAttribute("lang", lang);
  expect(proxy).toHaveAttribute("autocapitalize", capital);
}
const password = remoteField("password", {
  inputMode: "numeric",
  enterKeyHint: "done",
  lang: "ja",
});
test("browser-viewer-interaction-059 Remote keyboard hints track the current field outside composition", async () => {
  const remote = await openWindow();
  const canvas = screen.getByRole("img", { name: "Live browser view" });
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 500),
  );
  await userEvent.click(input());
  for (const [type, mode, enter, capital] of [
    ["search", "search", "search", "words"],
    ["email", "email", "enter", "none"],
    ["url", "url", "enter", "none"],
    ["tel", "tel", "enter", "words"],
    ["number", "decimal", "enter", "words"],
    ["textarea", "text", "enter", "words"],
    ["password", "text", "enter", "none"],
    ["search", "search", "search", "words"],
  ] as const) {
    remote.setFocusedEditing(
      remoteField(type, { multiline: type === "textarea" }),
    );
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => {
      return hints(
        mode,
        enter,
        "en",
        capital,
        type === "password" ? "password" : "text",
      );
    });
  }
  const previousAnchor = input().style.left;
  remote.setFocusedEditing({ ...password, x: 135 });
  const read = remote.holdNext("editing-context");
  compose("文");
  await read.received;
  await read.release();
  // The updated caret position comes from the same editing-context reply as the hints.
  await waitFor(() => {
    return expect(input().style.left).not.toBe(previousAnchor);
  });
  hints("search", "search", "en", "words");
  ime("compositionend", "文");
  await waitFor(() => {
    return hints("numeric", "done", "ja", "none", "password");
  });
  remote.setFocusedEditing(null);
  await userEvent.keyboard("{ArrowLeft}");
  await waitFor(() => {
    return hints("text", "enter", "", "none");
  });
  expect(input()).toBeEnabled();
});
test("browser-viewer-interaction-060 A tab title update preserves Japanese password composition", async () => {
  const remote = await openWindow();
  remote.setFocusedEditing(password);
  await userEvent.click(input());
  await waitFor(() => {
    return hints("numeric", "done", "ja", "none", "password");
  });
  compose("中");
  const target = remote.targets[0]!;
  target.title = "Checkout details";
  remote.nativeEvent("tab-updated", target);
  remote.event("Target.targetInfoChanged", {
    targetInfo: { ...target, type: "page" },
  });
  await waitFor(() => {
    return selected("Checkout details");
  });
  hints("numeric", "done", "ja", "none", "password");
  expect(input()).toBeEnabled();
  expect(input()).toHaveValue("中");
  ime("compositionend", "中");
  await waitFor(() => {
    return expect(inserted(remote, "main")).toStrictEqual(["中"]);
  });
  hints("numeric", "done", "ja", "none", "password");
});
test("browser-viewer-interaction-066 Failed context read restores defaults and forwards fresh input", async () => {
  const remote = await openWindow();
  remote.setFocusedEditing(password);
  await userEvent.click(input());
  await waitFor(() => {
    return hints("numeric", "done", "ja", "none", "password");
  });
  remote.failNext("Runtime.evaluate", "Editing context unavailable");
  await userEvent.keyboard("{ArrowRight}");
  await waitFor(() => {
    return hints("text", "enter", "", "none");
  });
  expect(input()).toBeEnabled();
  insertText("fresh");
  await waitFor(() => {
    return expect(inserted(remote, "main")).toStrictEqual(["fresh"]);
  });
});
test("browser-viewer-interaction-078 A late failure restores Example without displacing a chosen draft", async () => {
  const remote = await localPair();
  remote.failNext("Target.closeTarget", "Close refused");
  const denied = remote.holdNext("Target.closeTarget", "main");
  await userEvent.click(screen.getByLabelText("Close Example"));
  await denied.received;
  await userEvent.click(screen.getByLabelText("Close Other"));
  await waitFor(() => {
    selected("Example");
    expect(tab("Example")).toHaveAttribute("aria-disabled", "true");
    expect(
      remote.targets.some((page) => {
        return page.targetId === "notes";
      }),
    ).toBeFalsy();
  });
  await replaceDraft("chosen.example/draft");
  await denied.release();
  await screen.findByRole("alert");
  expect(tab("Example")).not.toHaveAttribute("aria-disabled", "true");
  expect(field()).toHaveFocus();
  expect(field()).toHaveValue("chosen.example/draft");
});
test("browser-viewer-interaction-084 Resuming after a rejected stop requires a fresh picture", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const remote = await openWindow();
  remote.failNext("Page.stopScreencast", "Stop failed");
  const stop = remote.holdNext("Page.stopScreencast");
  visibility.changeTo("hidden");
  await stop.received;
  const image = remote.holdTargetFrames("main");
  visibility.changeTo("visible");
  await stop.release();
  await screen.findByText("Reconnecting…");
  await image.received;
  expect(input()).toBeDisabled();
  image.release();
  await expectStreamingAt(home);
  visibility.changeTo("hidden");
  await waitFor(() => {
    return expect(input()).toBeDisabled();
  });
  visibility.changeTo("visible");
  await expectStreamingAt(home);
});
test("browser-viewer-interaction-099 Resume preserves the preview through fresh membership and paint", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const remote = await openWindow();
  remote.duplicate("main");
  const prior = remote.holdNextMembership(created(remote).targetId);
  await prior.received;
  visibility.changeTo("hidden");
  await waitFor(() => {
    return expect(input()).toBeDisabled();
  });
  const fresh = remote.holdNextMembership("main");
  const image = remote.holdTargetFrames("main");
  visibility.changeTo("visible");
  await prior.release();
  await fresh.received;
  presentPreview();
  expect(input()).toBeDisabled();
  await fresh.release();
  await image.received;
  presentPreview();
  expect(input()).toBeDisabled();
  image.release();
  await expectStreamingAt(home);
});

test("browser-viewer-interaction-075 Image retry waits for input and capture shutdown", async () => {
  const remote = await openWindow();
  const original = remote.holdNext("Input.insertText");
  await userEvent.click(input());
  insertText("typed");
  await original.received;
  const cleanup = remote.holdNext("Page.stopScreencast");
  remote.frame("!corrupt", remote.pageSession("main"));
  await screen.findByText("Reconnecting…");
  await cleanup.received;
  expect(input()).toBeDisabled();
  await original.release();
  expect(input()).toBeDisabled();
  const next = remote.holdTargetFrames("main");
  await cleanup.release();
  await next.received;
  expect(input()).toBeDisabled();
  next.release();
  await expectStreamingAt(home);
});
async function choosePng() {
  await userEvent.click(screen.getByLabelText("Browser settings"));
  await userEvent.click(await screen.findByText("Image format"));
  await userEvent.click(await screen.findByText("PNG"));
}
test("browser-viewer-interaction-087 Navigation completion permits PNG after its first capture was rejected", async () => {
  const remote = await openWindow();
  const session = remote.pageSession("main");
  remote.event(
    "Page.frameStartedNavigating",
    { frameId: "example-frame" },
    session,
  );
  remote.failNext("Page.startScreencast", "Navigation in progress");
  const failure = remote.holdNext("Page.startScreencast");
  await choosePng();
  await failure.received;
  await failure.release();
  const png = remote.holdTargetFrames("main");
  remote.event(
    "Page.frameStoppedLoading",
    { frameId: "example-frame" },
    session,
  );
  await png.received;
  expect(remote.captures.at(-1)).toMatchObject({ format: "png" });
  expect(input()).toBeDisabled();
  png.release();
  await expectStreamingAt(home);
  expect(screen.queryByText("Browser view unavailable")).toBeNull();
});
test("browser-viewer-interaction-096 A resumed owner accepts input after interrupted recovery preparation", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const remote = await openWindow();
  const prep = remote.holdNextMembership("main");
  remote.frame("!broken", remote.pageSession("main"));
  await screen.findByText("Reconnecting…");
  await prep.received;
  visibility.changeTo("hidden");
  await waitFor(() => {
    return expect(input()).toBeDisabled();
  });
  const replacement = remote.holdTargetFrames("main");
  visibility.changeTo("visible");
  await replacement.received;
  expect(input()).toBeDisabled();
  replacement.release();
  await expectStreamingAt(home);
  await prep.release();
  await userEvent.click(input());
  insertText("recovered");
  await waitFor(() => {
    return expect(inserted(remote, "main")).toStrictEqual(["recovered"]);
  });
  expect(screen.queryByText("Browser view unavailable")).toBeNull();
});

test("browser-viewer-interaction-103 Revealing the initially hidden viewer enables Example", async () => {
  const visibility = context.mocks.browser.visibilityState("hidden");
  const session = arrangeNativePage(context);
  await session.openPage();
  expect(input()).toBeDisabled();
  visibility.changeTo("visible");
  await expectStreamingAt(home);
});
test("browser-viewer-interaction-104 The initializing viewer survives a hidden-visible cycle", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const session = arrangeNativePage(context);
  const enabling = session.cdp.holdNext("Page.enable");
  await session.openPage();
  await enabling.received;
  visibility.changeTo("hidden");
  await waitFor(() => {
    return expect(input()).toBeDisabled();
  });
  visibility.changeTo("visible");
  await enabling.release();
  await expectStreamingAt(home);
});
test("browser-viewer-interaction-105 Resumed input commits only the new text", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const remote = await openWindow();
  await userEvent.click(input());
  const previous = remote.holdNext("Input.imeSetComposition");
  compose("旧");
  await previous.received;
  visibility.changeTo("hidden");
  await waitFor(() => {
    return expect(input()).toBeDisabled();
  });
  visibility.changeTo("visible");
  await previous.release();
  await expectStreamingAt(home);
  ime("compositionend", "旧");
  await userEvent.click(input());
  insertText("fresh text");
  await waitFor(() => {
    return expect(inserted(remote, "main")).toStrictEqual(["fresh text"]);
  });
  presentPreview();
});
test("browser-viewer-interaction-123 An ordinary Page enable failure disables the viewer", async () => {
  const session = arrangeNativePage(context);
  session.cdp.failNext("Page.enable", "Page not available");
  await session.openPage();
  await screen.findByText("Browser view unavailable");
  expect(input()).toBeDisabled();
});
