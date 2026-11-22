import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { arrangeNativePage } from "./browser-native-page-fixture.ts";
import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";

const context = testContext();
function control(role: "tab" | "menuitem" | "menuitemradio", label: string) {
  return waitFor(() => {
    const match = queryAllByRoleFast(role).find((element) => {
      return (
        element.getAttribute("aria-label") === label ||
        element.textContent?.trim() === label
      );
    });
    if (!match) {
      throw new Error("Missing " + role + ": " + label);
    }
    return match;
  });
}

test("browser-session-page-002 Each window sizing choice is checked when settings reopen", async () => {
  const session = arrangeNativePage(context);
  await session.openPage();
  const settings = await screen.findByLabelText("Browser settings");
  await waitFor(() => {
    expect(settings).toBeEnabled();
  });
  async function openSizing() {
    await userEvent.click(settings);
    const windowSize = await control("menuitem", "Window size");
    await userEvent.hover(windowSize);
    return await control("menuitemradio", "Follow panel");
  }
  await expect(openSizing()).resolves.toHaveAttribute("aria-checked", "true");
  for (const selected of ["On connection", "Follow panel", "Off"]) {
    await userEvent.click(await control("menuitemradio", selected));
    await openSizing();
    await expect(control("menuitemradio", selected)).resolves.toHaveAttribute(
      "aria-checked",
      "true",
    );
  }
});

test("browser-session-page-003 The blank tab's guidance follows the selected remote page", async () => {
  const destination = "https://example.com/";
  const session = arrangeNativePage(context, {
    targets: [
      {
        targetId: "welcome",
        title: "about:blank",
        url: "about:blank",
        windowId: 101,
      },
      {
        targetId: "article",
        title: "Example",
        url: destination,
        windowId: 101,
      },
    ],
  });
  await session.openPage();
  const address = await screen.findByLabelText("Address");
  const guidance =
    "Okou opens pages here as it works. Enter a URL above to browse yourself.";
  await expect(screen.findByText("Nothing open yet")).resolves.toBeVisible();
  expect(screen.getByText(guidance)).toBeVisible();
  expect(address).toBeEnabled();
  await userEvent.click(await control("tab", "Example"));
  await waitFor(() => {
    expect(address).toHaveValue(destination);
  });
  expect(screen.queryByText("Nothing open yet")).toBeNull();
  expect(screen.queryByText(guidance)).toBeNull();
  await userEvent.click(await control("tab", "New tab"));
  await expect(screen.findByText(guidance)).resolves.toBeVisible();
  expect(screen.getByText("Nothing open yet")).toBeVisible();
  expect(address).toBeEnabled();
});
