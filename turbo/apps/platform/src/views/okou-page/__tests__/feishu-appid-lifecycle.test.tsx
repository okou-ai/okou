import { feishuConnectContract } from "@okouai/api-contracts/contracts/feishu-connect";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getAction,
  mockFeishu,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();

function credential(label: "App ID" | "App Secret"): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(label);
}

test("feishu app validation preserves a newly opened setup", async () => {
  mockFeishu(context);
  const started = context.mocks.deferred<void>();
  const aborted = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const answered = context.mocks.deferred<void>();
  context.mocks.api(
    feishuConnectContract.checkAppId,
    async ({ query, request, respond }) => {
      if (query.appId === "cli_first_bot") {
        request.signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
          },
          { once: true },
        );
        started.resolve();
        await release.promise;
        answered.resolve();
      }
      return respond(200, { available: true });
    },
  );
  await setupPage({
    context,
    path: "/settings/feishu/setup",
    featureSwitches: { [FeatureSwitchKey.FeishuIntegration]: true },
  });
  await expect(
    screen.findByRole("heading", { name: "Create an Agent app" }),
  ).resolves.toBeInTheDocument();
  click(getAction("button", "Next"));
  await expect(screen.findByLabelText("App ID")).resolves.toBeInTheDocument();
  await fill(credential("App ID"), "cli_first_bot");
  await fill(credential("App Secret"), "first-secret");
  click(getAction("button", "Next"));
  await started.promise;
  await findAction("button", "Checking…");

  click(getAction("link", "Feishu bots"));
  click(await findAction("link", "Add bot"));
  await expect(
    screen.findByRole("heading", { name: "Create an Agent app" }),
  ).resolves.toBeInTheDocument();
  await aborted.promise;
  release.resolve();
  await answered.promise;

  expect(
    screen.getByRole("heading", { name: "Create an Agent app" }),
  ).toBeInTheDocument();
  click(getAction("button", "Next"));

  await expect(
    screen.findByRole("heading", { name: "Add the app credentials" }),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/settings/feishu/setup");
  expect(
    screen.getByRole("heading", { name: "Add a Feishu bot" }),
  ).toBeInTheDocument();
  expect(credential("App ID")).toHaveValue("");
  expect(credential("App Secret")).toHaveValue("");
});
