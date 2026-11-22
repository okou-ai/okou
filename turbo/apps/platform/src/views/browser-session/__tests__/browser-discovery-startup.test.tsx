import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { fill } from "../../../__tests__/page-helper.ts";
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
