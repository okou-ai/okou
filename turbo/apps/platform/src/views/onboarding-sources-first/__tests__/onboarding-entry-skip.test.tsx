import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import {
  getAction,
  findAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { billingRedeemCodeContract } from "@okouai/api-contracts/contracts/billing";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { marketingEventsContract } from "@okouai/api-contracts/contracts/marketing-events";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  documentInstructions,
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

test("onboarding-entry-skip-008 an explicit false skip flag leaves the linked task ready to edit", async () => {
  newcomer();
  const task = "Prepare the quarterly supplier review";
  await setupPage({
    context,
    path:
      "/onboarding?" +
      new URLSearchParams({ skipOnboarding: "false", prompt: task }),
  });
  await expect(
    screen.findByLabelText("Onboarding prompt"),
  ).resolves.toHaveValue(task);
  expect(getAction("button", "Next")).toBeEnabled();
});
test("onboarding-entry-skip-009 a rejected redemption can be completed manually with the original task", async () => {
  newcomer();
  const code = "TRIAL-PARTNER";
  const task = "Draft the partner launch checklist";
  let valid = false;
  context.mocks.api(billingRedeemCodeContract.create, ({ body, respond }) => {
    expect(body.code).toBe(code);
    return valid
      ? respond(200, { redeemed: true })
      : respond(400, {
          error: {
            code: "INVALID_CODE",
            message: "This partner code is invalid.",
          },
        });
  });
  const sent = receiveFirstChat(context);
  await setupPage({
    context,
    path:
      "/onboarding?" +
      new URLSearchParams({
        skipOnboarding: "true",
        prompt: task,
        redeemCode: code,
      }),
  });
  await expect(
    screen.findByText("This partner code is invalid.", { selector: "p" }),
  ).resolves.toBeVisible();
  click(await findAction("link", "Continue with onboarding"));
  const editor = await screen.findByLabelText("Onboarding prompt");
  expect(editor).toHaveValue(task);
  expect(editor).toBeEnabled();
  expect(editor).not.toHaveAttribute("readonly");
  expect(new URL(location.href).searchParams.get("redeemCode")).toBe(code);
  valid = true;
  click(getAction("button", "Next"));
  const receipt = await sent;
  expect(receipt.prompt).toBe(task + "\n\n" + documentInstructions);
  await expect(findSentPrompt(receipt.prompt)).resolves.toBeVisible();
  expect(location.pathname).toBe("/chats/" + receipt.threadId);
});
test("onboarding-entry-skip-011 automatic entry keeps the task pending while the workspace is being prepared", async () => {
  newcomer();
  const task = "List my open handoffs";
  const pending = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    onboardingCompleteContract.complete,
    async ({ respond }) => {
      if (!pending.settled()) {
        pending.resolve();
      }
      await release.promise;
      context.mocks.data.onboardingStatus({
        needsOnboarding: false,
        onboardingComplete: true,
      });
      return respond(200, { needsOnboarding: false, onboardingComplete: true });
    },
  );
  const delivery = context.mocks.deferred<{
    prompt: string;
    threadId: string;
  }>();
  const sent = receiveFirstChat(context, delivery);
  try {
    await startPage({
      context,
      path:
        "/onboarding?" +
        new URLSearchParams({ skipOnboarding: "true", prompt: task }),
    });
    await pending.promise;
    await expect(
      screen.findByRole("status", { name: "Getting your workspace ready" }),
    ).resolves.toBeVisible();
    expect(delivery.settled()).toBeFalsy();
  } finally {
    release.resolve();
  }
  const receipt = await sent;
  expect(receipt.prompt).toBe(task);
  await expect(findSentPrompt(task)).resolves.toBeVisible();
  expect(location.pathname).toBe("/chats/" + receipt.threadId);
});
