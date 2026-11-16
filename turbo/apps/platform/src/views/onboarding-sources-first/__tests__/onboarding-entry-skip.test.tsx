import { billingRedeemCodeContract } from "@okouai/api-contracts/contracts/billing";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { marketingEventsContract } from "@okouai/api-contracts/contracts/marketing-events";
import { marketingHandoffsContract } from "@okouai/api-contracts/contracts/marketing-handoffs";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";

const context = testContext();
const TASK = "What is 1 + 2? Reply with only the number.";
const HASH = "a".repeat(12);
const FILE_ID = "bc3125d1-dc3f-4422-955c-f69f1d077608";

test("Authentication keeps task text separate from the actual onboarding flags", async () => {
  context.mocks.clerk();
  // The deployed Clerk builder decodes the nested query before serializing it.
  mockedClerk.buildSignInUrl.mockImplementation((options) => {
    const url = new URL("/sign-in", "https://app.okou.ai");
    const params = new URLSearchParams({
      redirect_url: decodeURIComponent(options?.redirectUrl ?? ""),
    });
    url.hash = `/?${params}`;
    return url.toString();
  });
  const prompt = "Find C++ teams &skipOnboarding=true&redeemCode=TASK-TEXT";
  const params = new URLSearchParams({
    prompt,
    skipOnboarding: "false",
    redeemCode: "PRO-ENTRY",
  });
  await startPage({
    context,
    host: "app.okou.ai",
    path: `/onboarding?${params}`,
    auth: null,
  });
  await waitFor(() => {
    expect(window.location.pathname).toBe("/sign-in");
  });
  const signIn = new URL(window.location.href);
  const target =
    signIn.searchParams.get("redirect_url") ??
    new URLSearchParams(signIn.hash.split("?")[1] ?? "").get("redirect_url");
  if (!target) {
    throw new Error("Expected an authentication return URL");
  }
  const returned = new URL(target);
  expect(returned.searchParams.get("prompt")).toBe(prompt);
  expect(returned.searchParams.getAll("skipOnboarding")).toStrictEqual([
    "false",
  ]);
  expect(returned.searchParams.getAll("redeemCode")).toStrictEqual([
    "PRO-ENTRY",
  ]);
});

function needsOnboarding(isAdmin = true): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: !isAdmin,
    isAdmin,
  });
}

function completeOnboarding(isAdmin = true): void {
  context.mocks.api(onboardingCompleteContract.complete, ({ respond }) => {
    context.mocks.data.onboardingStatus({
      needsOnboarding: false,
      onboardingComplete: true,
      isAdmin,
    });
    return respond(200, { needsOnboarding: false, onboardingComplete: true });
  });
}

function nextButton(): HTMLElement {
  return action("button", "Next");
}

function action(role: "button" | "link", name: string): HTMLElement {
  const found = queryAllByRoleFast(role).find((element) => {
    return element.textContent?.trim() === name;
  });
  if (!found) {
    throw new Error(`Expected ${role} named ${name}`);
  }
  return found;
}

test.each([true, false])(
  "A skip link redeems, completes and runs its task while cookie delivery survives navigation (eligible: %s)",
  async (redeemed) => {
    needsOnboarding();
    completeOnboarding();
    const eventReceived = context.mocks.deferred<Request>();
    const finishEvent = context.mocks.deferred<void>();
    context.mocks.api(
      marketingEventsContract.record,
      async ({ request, body, respond, withSignal }) => {
        expect(body.tag).toBe("onboarding-start");
        eventReceived.resolve(request);
        await withSignal(finishEvent.promise);
        return respond(204);
      },
    );
    context.mocks.api(billingRedeemCodeContract.create, ({ body, respond }) => {
      expect(body.code).toBe("PRO-SKIP");
      return respond(200, { redeemed });
    });
    let sentPrompt: string | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        sentPrompt = body.prompt;
      },
    });

    await setupPage({
      context,
      host: "app.okou.ai",
      path: `/onboarding?${new URLSearchParams({
        prompt: TASK,
        redeemCode: " PRO-SKIP ",
        skipOnboarding: "true",
      })}`,
    });
    await waitFor(() => {
      expect(sentPrompt).toBe(TASK);
      expect(pathname()).toMatch(/^\/chats\//u);
    });
    const event = await eventReceived.promise;
    expect(event.url).toBe("https://www.okou.ai/api/events");
    expect(event.credentials).toBe("include");
    expect(event.headers.get("authorization")).toBe("Bearer test-token");
    expect(event.signal.aborted).toBeFalsy();
    finishEvent.resolve();
    expect(search()).toBe("");
  },
);

test.each([true, false])(
  "A skip link preserves a hash handoff's task and attachment (admin: %s)",
  async (isAdmin) => {
    needsOnboarding(isAdmin);
    completeOnboarding(isAdmin);
    context.mocks.api(billingRedeemCodeContract.create, ({ body, respond }) => {
      if (!isAdmin) {
        return respond(403, {
          error: {
            code: "FORBIDDEN",
            message: "Only workspace administrators can redeem codes",
          },
        });
      }
      expect(body.code).toBe("PRO-SKIP");
      return respond(200, { redeemed: true });
    });
    context.mocks.api(marketingHandoffsContract.resolve, ({ respond }) => {
      return respond(200, {
        version: 1,
        prompt: TASK,
        options: {},
        files: [
          {
            hash: "f".repeat(64),
            filename: "notes.txt",
            contentType: "text/plain",
            size: 5,
          },
        ],
      });
    });
    context.mocks.api(marketingHandoffsContract.import, ({ respond }) => {
      return respond(200, {
        files: [
          {
            id: FILE_ID,
            filename: "notes.txt",
            contentType: "text/plain",
            size: 5,
            url: "https://app.okou.ai/artifacts/abcdefgh12/notes.txt",
          },
        ],
      });
    });
    context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
      return respond(200, {
        url: "https://storage.example.test/notes.txt",
        downloadUrl: "https://storage.example.test/notes.txt?download=1",
        expiresAt: "2099-01-01T00:00:00.000Z",
        publicUrl: null,
      });
    });
    let message: UserMessageDocument | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        message = body.userMessage;
      },
    });

    await setupPage({
      context,
      path: `/onboarding?handoff=${HASH}&redeemCode=PRO-SKIP&skipOnboarding=true`,
    });
    await waitFor(() => {
      expect(message?.parts).toContainEqual({ type: "text", text: TASK });
      expect(pathname()).toMatch(/^\/chats\//u);
    });
    expect(message?.parts).toContainEqual({
      type: "file",
      fileId: FILE_ID,
      filenameSnapshot: "notes.txt",
      contentType: "text/plain",
    });
  },
);

test.each([ROUTES.onboarding, ROUTES.onboardingReady])(
  "A skip link without a task completes onboarding and opens App from %s",
  async (path) => {
    needsOnboarding();
    completeOnboarding();
    context.mocks.api(billingRedeemCodeContract.create, ({ body, respond }) => {
      expect(body.code).toBe("PRO-SKIP");
      return respond(200, { redeemed: true });
    });
    await setupPage({
      context,
      path: `${path}?skipOnboarding=true&redeemCode=PRO-SKIP`,
    });
    await expect(
      screen.findByRole("textbox", { name: "Message" }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toMatch(/^\/agents\/[^/]+\/chat$/u);
  },
);

test("The prompt remains editable with skipOnboarding=false", async () => {
  needsOnboarding();
  await setupPage({
    context,
    path: `/onboarding?prompt=${encodeURIComponent(TASK)}&skipOnboarding=false`,
  });
  const input = await screen.findByRole("textbox", {
    name: "Onboarding prompt",
  });
  expect(input).toHaveValue(TASK);
  expect(nextButton()).toBeEnabled();
});

test("A redemption error offers a manual continuation with the task intact", async () => {
  needsOnboarding();
  completeOnboarding();
  let invalid = true;
  context.mocks.api(billingRedeemCodeContract.create, ({ respond }) => {
    return invalid
      ? respond(400, {
          error: { code: "BAD_REQUEST", message: "Invalid redeem code" },
        })
      : respond(200, { redeemed: true });
  });
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  await setupPage({
    context,
    path: `/onboarding?prompt=${encodeURIComponent(TASK)}&skipOnboarding=true&redeemCode=PRO-SKIP`,
  });
  await expect(
    screen.findByRole("heading", { name: "Oops! Something went sideways" }),
  ).resolves.toBeInTheDocument();
  expect(
    within(screen.getByRole("alert")).getByText("Invalid redeem code"),
  ).toBeInTheDocument();
  click(action("link", "Continue with onboarding"));
  const input = await screen.findByRole("textbox", {
    name: "Onboarding prompt",
  });
  expect(input).toHaveValue(TASK);
  expect(new URLSearchParams(search()).get("redeemCode")).toBe("PRO-SKIP");
  invalid = false;
  click(nextButton());
  await waitFor(() => {
    expect(sentPrompt).toBe(TASK);
    expect(pathname()).toMatch(/^\/chats\//u);
  });
});

test("A completion retry retains a redeemed code's grant without consuming it again", async () => {
  needsOnboarding();
  let redeemed = false;
  context.mocks.api(billingRedeemCodeContract.create, ({ body, respond }) => {
    expect(body.code).toBe("PRO-SKIP");
    if (redeemed) {
      return respond(400, {
        error: { code: "BAD_REQUEST", message: "Code already redeemed" },
      });
    }
    redeemed = true;
    return respond(200, { redeemed: true });
  });
  context.mocks.api(onboardingCompleteContract.complete, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Could not complete onboarding",
      },
    });
  });
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  await setupPage({
    context,
    path: `/onboarding?prompt=${encodeURIComponent(TASK)}&skipOnboarding=true&redeemCode=PRO-SKIP`,
  });
  await expect(
    screen.findByRole("heading", { name: "Oops! Something went sideways" }),
  ).resolves.toBeInTheDocument();
  expect(
    within(screen.getByRole("alert")).getByText(
      "Could not complete onboarding",
    ),
  ).toBeInTheDocument();
  completeOnboarding();
  click(action("button", "Retry"));
  await waitFor(() => {
    expect(sentPrompt).toBe(TASK);
    expect(pathname()).toMatch(/^\/chats\//u);
  });
});

test("A skip entry shows progress until completion succeeds before starting its task", async () => {
  needsOnboarding();
  const completion = context.mocks.deferred<void>();
  const received = context.mocks.deferred<void>();
  context.mocks.api(
    onboardingCompleteContract.complete,
    async ({ respond, withSignal }) => {
      received.resolve();
      await withSignal(completion.promise);
      context.mocks.data.onboardingStatus({
        needsOnboarding: false,
        onboardingComplete: true,
      });
      return respond(200, { needsOnboarding: false, onboardingComplete: true });
    },
  );
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  await setupPage({
    context,
    path: `/onboarding?prompt=${encodeURIComponent(TASK)}&skipOnboarding=true`,
  });
  await expect(
    screen.findByRole("status", { name: "Getting your workspace ready" }),
  ).resolves.toBeInTheDocument();
  await received.promise;
  expect(pathname()).toBe(ROUTES.onboarding);
  completion.resolve();
  await waitFor(() => {
    expect(sentPrompt).toBe(TASK);
    expect(pathname()).toMatch(/^\/chats\//u);
  });
});

test("An unavailable task resumes ordinary onboarding instead of completing an empty request", async () => {
  needsOnboarding();
  context.mocks.api(marketingHandoffsContract.resolve, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Content not found" },
    });
  });
  await setupPage({
    context,
    path: `/onboarding?handoff=${HASH}&skipOnboarding=true&redeemCode=PRO-SKIP`,
  });
  await expect(
    screen.findByRole("heading", { name: "What kind of work do you do?" }),
  ).resolves.toBeInTheDocument();
  expect(new URLSearchParams(search()).get("redeemCode")).toBe("PRO-SKIP");
});
