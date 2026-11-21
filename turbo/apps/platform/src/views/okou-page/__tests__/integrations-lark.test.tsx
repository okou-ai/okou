import { test, expect } from "vitest";
import { screen } from "@testing-library/react";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import {
  visitProvider,
  botWorkspace,
  providerContract,
} from "./provider-bot-fixtures.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();

test("integrations-lark-001 the Lark guide verifies its own app credentials before asking for encryption", async () => {
  botWorkspace(context, "lark", true, () => {
    return [];
  });
  context.mocks.api(
    providerContract("lark").checkAppId,
    ({ query, respond }) => {
      return query.appId === "cli_lark"
        ? respond(200, { available: true })
        : respond(409, {
            error: { code: "CONFLICT", message: "Unrecognized app" },
          });
    },
  );
  await visitProvider(context, "lark", "/works");
  const link = await screen.findByTestId("lark-setup-button");
  expect(link).toHaveAttribute("href", "/settings/lark");
  expect(screen.queryByTestId("feishu-setup-button")).toBeNull();
  click(link);
  await expect(
    screen.findByRole("heading", { name: "Lark bots" }),
  ).resolves.toBeInTheDocument();
  click(await findAction("link", "Add bot"));
  await expect(
    screen.findByText("Create an Agent app"),
  ).resolves.toBeInTheDocument();
  expect(
    document.querySelector(
      'a[href="https://open.larksuite.com/page/launcher?from=backend_oneclick"]',
    ),
  ).toBeVisible();
  await expect(
    findAction("link", "Download the optional Okou icon"),
  ).resolves.toHaveAttribute("download", "okou-lark-app-icon.png");
  click(await findAction("button", "Next"));
  await fill(
    screen.getByLabelText("App ID", { selector: "input" }),
    "cli_lark",
  );
  await fill(
    screen.getByLabelText("App Secret", { selector: "input" }),
    "lark-credential",
  );
  click(await findAction("button", "Next"));
  await expect(
    screen.findByLabelText("Encrypt Key", { selector: "input" }),
  ).resolves.toBeInTheDocument();
});

test("integrations-lark-003 the empty installation account loads on the Lark bot list", async () => {
  const status = createDeferredPromise<void>(context.signal);
  botWorkspace(context, "lark", true, () => {
    if (!status.settled()) {
      status.resolve();
    }
    return [];
  });
  await visitProvider(context, "lark", "/settings/lark");
  await status.promise;
  await expect(
    screen.findByText("No Lark bots yet"),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByRole("heading", { name: "Lark bots" }),
  ).resolves.toBeInTheDocument();
  await expect(findAction("link", "Add bot")).resolves.toHaveAttribute(
    "href",
    "/settings/lark/setup",
  );
});
