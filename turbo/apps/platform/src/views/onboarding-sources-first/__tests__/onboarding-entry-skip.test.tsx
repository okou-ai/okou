import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { billingRedeemCodeContract } from "@okouai/api-contracts/contracts/billing";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { marketingEventsContract } from "@okouai/api-contracts/contracts/marketing-events";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  receiveFirstChat,
  findSentPrompt,
} from "./onboarding-first-chat-test-helpers.ts";
const context = testContext();
function newcomer() {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}
test("onboarding-entry-skip-001 sign-in keeps literal flags in the task separate from URL parameters", async () => {
  const prompt = "Review skipOnboarding=true&redeemCode=TEXT as literal text.";
  const query = new URLSearchParams({
    prompt,
    skipOnboarding: "false",
    redeemCode: "PRO-ENTRY",
  });
  await startPage({ context, path: "/onboarding?" + query, auth: null });
  await waitFor(() => {
    return expect(location.pathname).toBe("/sign-in");
  });
  const target = new URL(
    new URL(location.href).searchParams.get("redirect_url")!,
  );
  expect(target.pathname).toBe("/onboarding");
  expect(target.searchParams.get("prompt")).toBe(prompt);
  expect(target.searchParams.get("skipOnboarding")).toBe("false");
  expect(target.searchParams.get("redeemCode")).toBe("PRO-ENTRY");
});
test("onboarding-entry-skip-006 a skip link without a task redeems the code and completes at Home", async () => {
  newcomer();
  const code = context.mocks.deferred<string>();
  context.mocks.api(billingRedeemCodeContract.create, ({ body, respond }) => {
    if (!code.settled()) {
      code.resolve(body.code);
    }
    return respond(200, { redeemed: true });
  });
  const done = context.mocks.deferred<void>();
  context.mocks.api(onboardingCompleteContract.complete, ({ respond }) => {
    context.mocks.data.onboardingStatus({
      needsOnboarding: false,
      onboardingComplete: true,
    });
    if (!done.settled()) {
      done.resolve();
    }
    return respond(200, { needsOnboarding: false, onboardingComplete: true });
  });
  await setupPage({
    context,
    path: "/onboarding?skipOnboarding=true&redeemCode=TRIAL-FALL",
  });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeVisible();
  await expect(code.promise).resolves.toBe("TRIAL-FALL");
  await done.promise;
  expect(location.pathname).toBe("/");
});
test("onboarding-entry-skip-002 the redeemed task opens in chat while the authenticated Marketing request is outstanding", async () => {
  newcomer();
  const pending = context.mocks.deferred<Request>();
  const release = context.mocks.deferred<void>();
  const redeem = context.mocks.deferred<string>();
  const completed = context.mocks.deferred<void>();
  context.mocks.api(billingRedeemCodeContract.create, ({ body, respond }) => {
    if (!redeem.settled()) {
      redeem.resolve(body.code);
    }
    return respond(200, { redeemed: true });
  });
  context.mocks.api(onboardingCompleteContract.complete, ({ respond }) => {
    if (!completed.settled()) {
      completed.resolve();
    }
    context.mocks.data.onboardingStatus({
      needsOnboarding: false,
      onboardingComplete: true,
    });
    return respond(200, { needsOnboarding: false, onboardingComplete: true });
  });
  context.mocks.api(
    marketingEventsContract.record,
    async ({ request, body, respond }) => {
      if (body.tag === "onboarding-start") {
        if (!pending.settled()) {
          pending.resolve(request);
        }
        await release.promise;
      }
      return respond(204);
    },
  );
  const task = "Prepare my event checklist";
  const sent = receiveFirstChat(context);
  try {
    await setupPage({
      context,
      path:
        "/onboarding?" +
        new URLSearchParams({
          skipOnboarding: "true",
          prompt: task,
          redeemCode: "PRO-ENTRY",
        }),
    });
    const req = await pending.promise;
    await expect(redeem.promise).resolves.toBe("PRO-ENTRY");
    await completed.promise;
    const chat = await sent;
    expect(chat.prompt).toBe(task);
    await expect(findSentPrompt(task)).resolves.toBeVisible();
    expect(location.pathname).toBe("/chats/" + chat.threadId);
    expect(location.search).toBe("");
    expect(req.credentials).toBe("include");
    expect(req.headers.get("authorization")).toBe("Bearer test-token");
    expect(req.signal.aborted).toBeFalsy();
  } finally {
    release.resolve();
  }
});
