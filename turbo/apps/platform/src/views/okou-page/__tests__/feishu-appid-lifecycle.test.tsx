import {
  feishuConnectContract,
  larkConnectContract,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { act, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  findAction,
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
    click(await findAction("button", "Next"));
    await fill(await screen.findByLabelText("App ID"), "cli_first_bot");
    await fill(screen.getByLabelText("App Secret"), "test-secret");
    click(await findAction("button", "Next"));
    await started.promise;
    click(getAction("link", `${platform === "lark" ? "Lark" : "Feishu"} bots`));
    await screen.findByRole("heading", {
      name: `${platform === "lark" ? "Lark" : "Feishu"} bots`,
    });
    click(getAction("link", "Add bot"));
    await screen.findByText("Create an Agent app");
    await act(() => {
      response.resolve();
      return response.promise;
    });
    expect(screen.getByText("Create an Agent app")).toBeInTheDocument();
    click(await findAction("button", "Next"));
    expect(screen.getByLabelText("App ID")).toHaveValue("");
    expect(screen.getByLabelText("App Secret")).toHaveValue("");
  },
);
