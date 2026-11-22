import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
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
