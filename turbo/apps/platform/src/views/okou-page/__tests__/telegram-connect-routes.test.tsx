import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  openTelegram,
  botState,
  signedQuery,
  telegramBotUrl,
  telegramPath,
  visitLink,
} from "./telegram-page-fixture.ts";
const context = testContext();
test("telegram-connect-routes-001 The linked member lands on standalone Telegram with the original query and fragment", async () => {
  botState(context, "99001");
  await openTelegram(context, telegramPath + signedQuery);
  await expect(
    screen.findByText("Already connected to Telegram"),
  ).resolves.toBeInTheDocument();
  expect(location.href).toBe(
    "https://app.okou.ai" + telegramPath + signedQuery,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  await visitLink(context, "Open Telegram", telegramBotUrl);
});
test("telegram-connect-routes-003 Sign-in carries the complete signed member destination", async () => {
  await startPage({
    context,
    auth: null,
    host: "app.okou.ai",
    path: telegramPath + signedQuery,
    sharedWorkerTestTransport: "message-port",
  });
  await waitFor(() => {
    expect(location.pathname).toBe("/sign-in");
  });
  expect(new URL(location.href).searchParams.get("redirect_url")).toBe(
    "https://app.okou.ai" + telegramPath + signedQuery,
  );
});
test("telegram-connect-routes-005 Setup opens onboarding in a new page and preserves the signed request", async () => {
  botState(context);
  context.mocks.data.onboardingStatus({
    hasOrg: false,
    needsOnboarding: true,
  });
  const path =
    telegramPath +
    signedQuery.replace("context=phone", "prompt=connect&context=phone");
  await openTelegram(context, path);
  await expect(
    screen.findByText("Finish account setup"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Connect")).toBeNull();
  await visitLink(context, "Open setup", "https://app.okou.ai/onboarding");
  expect(location.href).toBe("https://app.okou.ai" + path);
});
