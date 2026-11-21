// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { platformFeishuAppIconImg } from "../../../lib/static-assets.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  mockFeishu,
  findAction,
} from "./connector-integrations-test-helpers.ts";
import { catPng } from "./hosted-download-boundaries.ts";
const context = testContext();
async function openIcon(platform: "feishu" | "lark", read: () => Response) {
  const browser = context.mocks.browser.blobDownload();
  context.mocks.http.get(platformFeishuAppIconImg, read);
  mockFeishu(context, {}, platform);
  const path = "/settings/" + platform + "/setup";
  await setupPage({
    context,
    host: "app.okou.ai",
    path,
    featureSwitches: {
      [platform === "lark"
        ? FeatureSwitchKey.LarkIntegration
        : FeatureSwitchKey.FeishuIntegration]: true,
    },
  });
  const link = await findAction("link", "Download the optional Okou icon");
  expect(link).toHaveAttribute("href", platformFeishuAppIconImg);
  return { link, browser, path };
}

test.each([
  ["feishu-icon-download-002", "feishu"],
  ["feishu-icon-download-004", "lark"],
] as const)(
  "%s saves the optional PNG and keeps the setup step open",
  async (_id, platform) => {
    const { link, browser, path } = await openIcon(platform, () => {
      return new HttpResponse(catPng, {
        headers: { "Content-Type": "image/png" },
      });
    });
    if (platform === "feishu") {
      link.focus();
      await userEvent.setup({ delay: null }).keyboard("{Enter}");
    } else {
      click(link);
    }
    await waitFor(() => {
      return expect(
        browser.downloads.map((item) => {
          return item.filename;
        }),
      ).toStrictEqual(["okou-" + platform + "-app-icon.png"]);
    });
    const blob = browser.downloads[0]!.blob!;
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toStrictEqual(catPng);
    expect(location.pathname).toBe(path);
    await expect(
      screen.findByText("Create an Agent app"),
    ).resolves.toBeVisible();
  },
);
test("feishu-icon-download-003 an unreadable icon leaves the administrator at the Feishu creation step", async () => {
  const { link, browser, path } = await openIcon("feishu", () => {
    return HttpResponse.text("Unreadable icon", { status: 500 });
  });
  click(link);
  await expect(screen.findByText("Download failed")).resolves.toBeVisible();
  expect(browser.downloads).toStrictEqual([]);
  expect(location.pathname).toBe(path);
  await expect(screen.findByText("Create an Agent app")).resolves.toBeVisible();
});
