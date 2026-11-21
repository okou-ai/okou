import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { arrangeNativePage } from "./browser-native-page-fixture.ts";

const context = testContext();
async function chooseSeparateImages() {
  click(await screen.findByLabelText("Browser settings"));
  click(await screen.findByText("Connection mode"));
  const shared = (await screen.findByText("Shared connection")).closest(
    '[role="menuitemradio"]',
  );
  expect(shared).toHaveAttribute("aria-checked", "true");
  click(await screen.findByText("Separate image connection"));
}
test.each([
  { id: "003", pending: "socket" },
  { id: "004", pending: "attachment" },
])(
  "browser-viewer-binding-$id changes transport before the initial binding is ready",
  async ({ pending }) => {
    const connecting = context.mocks.deferred<void>();
    const { cdp, openPage } = arrangeNativePage(context, {
      autoOpen: pending !== "socket",
      onConnecting: () => {
        if (!connecting.settled()) {
          connecting.resolve();
        }
      },
    });
    const attach =
      pending === "attachment"
        ? cdp.holdNext("Target.attachToBrowserTarget")
        : null;
    await openPage();
    await connecting.promise;
    if (attach) {
      await attach.received;
    }
    const input = await screen.findByLabelText("Remote browser input");
    expect(input).toBeDisabled();
    await chooseSeparateImages();
    cdp.setAutoOpen(true);
    cdp.openConnection();
    await attach?.release();
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
    expect(
      screen.getByRole("img", { name: "Live browser view" }),
    ).toBeVisible();
    click(screen.getByLabelText("Browser settings"));
    click(await screen.findByText("Connection mode"));
    expect(
      (await screen.findByText("Separate image connection")).closest(
        '[role="menuitemradio"]',
      ),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      cdp.targets.map(({ url, windowId }) => {
        return { url, windowId };
      }),
    ).toStrictEqual([{ url: "https://example.com", windowId: 101 }]);
  },
);
