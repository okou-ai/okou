import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import {
  getAction,
  mockFeishu,
  setupFeishuSettingsPage,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const ICON_URL =
  "https://static.okou.io/platform/views/zero-page/assets/feishu/app-icon-okou-fefdc683bf5c.png";

describe.each(["feishu", "lark"] as const)("%s icon download", (platform) => {
  async function openCreateStep() {
    await setupFeishuSettingsPage(context, platform);
    click(await screen.findByText("Add bot"));
    await expect(
      screen.findByText("Create an Agent app"),
    ).resolves.toBeInTheDocument();
    return getAction("link", "Download the optional Okou icon");
  }

  it.each(["click", "Enter"])(
    "%s downloads the cross-origin icon with the platform filename",
    async (activation) => {
      const iconBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0xff]);
      mockFeishu(context, {}, platform);
      context.mocks.http.get(ICON_URL, () => {
        return new HttpResponse(iconBytes, {
          headers: { "Content-Type": "image/png" },
        });
      });
      const browser = context.mocks.browser.blobDownload();
      const user = userEvent.setup({ delay: null });
      const link = await openCreateStep();

      if (activation === "Enter") {
        link.focus();
        await user.keyboard("{Enter}");
      } else {
        click(link);
      }

      await waitFor(() => {
        expect(browser.downloads).toHaveLength(1);
      });
      const download = browser.downloads[0];
      expect(download?.filename).toBe(`okou-${platform}-app-icon.png`);
      expect(download?.blob?.type).toBe("image/png");
      await expect(download?.blob?.arrayBuffer()).resolves.toStrictEqual(
        iconBytes.buffer,
      );
      expect(pathname()).toBe(`/settings/${platform}`);
      expect(screen.getByText("Create an Agent app")).toBeInTheDocument();
    },
  );

  it("reports an unreadable icon without navigating away from setup", async () => {
    mockFeishu(context, {}, platform);
    context.mocks.http.get(ICON_URL, () => {
      return new HttpResponse(null, { status: 500 });
    });
    const browser = context.mocks.browser.blobDownload();
    const link = await openCreateStep();

    click(link);

    await expect(
      screen.findByText("Download failed"),
    ).resolves.toBeInTheDocument();
    expect(browser.downloads).toStrictEqual([]);
    expect(pathname()).toBe(`/settings/${platform}`);
    expect(screen.getByText("Create an Agent app")).toBeInTheDocument();
  });
});
