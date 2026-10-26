import {
  feishuConnectContract,
  larkConnectContract,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  mockFeishu,
  setupFeishuSettingsPage,
} from "./connector-integrations-test-helpers.ts";
const context = testContext();

test.each(["feishu", "lark"] as const)(
  "%s app validation preserves a newly opened setup",
  async (platform) => {
    const contract =
      platform === "lark" ? larkConnectContract : feishuConnectContract;
    mockFeishu(context, {}, platform);
    const started = context.mocks.deferred<void>();
    const response = context.mocks.deferred<void>();
    context.mocks.api(contract.checkAppId, async ({ respond }) => {
      started.resolve();
      await response.promise;
      return respond(200, { available: true });
    });
    await setupFeishuSettingsPage(context, platform);
    click(await screen.findByText("Add bot"));
    click(getAction("button", "Next"));
    await fill(await screen.findByLabelText("App ID"), "cli_first_bot");
    await fill(screen.getByLabelText("App Secret"), "test-secret");
    click(getAction("button", "Next"));
    await started.promise;
    click(getAction("button", "Close", screen.getByRole("dialog")));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    click(getAction("button", "Add bot"));
    await screen.findByText("Create an Agent app");
    await act(() => {
      response.resolve();
      return response.promise;
    });
    expect(screen.getByText("Create an Agent app")).toBeInTheDocument();
    click(getAction("button", "Next"));
    expect(screen.getByLabelText("App ID")).toHaveValue("");
    expect(screen.getByLabelText("App Secret")).toHaveValue("");
  },
);
