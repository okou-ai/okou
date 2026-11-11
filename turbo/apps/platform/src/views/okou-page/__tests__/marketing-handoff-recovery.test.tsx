import { marketingHandoffsContract } from "@okouai/api-contracts/contracts/marketing-handoffs";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import { fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";
import { resetSignal } from "../../../signals/utils.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const NOTICE =
  "We couldn’t restore the linked task. You can continue normally; your existing draft is unchanged.";
const HASH = "a".repeat(12);

function preserveDraft() {
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text: "Keep my existing draft" }],
      },
      draftAttachments: null,
    });
  });
}

async function expectUsableDraft() {
  await waitFor(() => {
    const composer = document.querySelector(
      '[data-slot="chat-composer-card"] [contenteditable="true"]',
    );
    expect(composer).toHaveTextContent("Keep my existing draft");
  });
  expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(1);
  const params = new URLSearchParams(search());
  for (const key of [
    "handoff",
    "prompt",
    "model",
    "template",
    "connector",
    "showcase",
  ]) {
    expect(params.has(key)).toBeFalsy();
  }
}

test.each([
  ["/prompt", 404],
  ["/prompt", 503],
  ["/onboarding", 404],
  ["/onboarding", 503],
  [`/agents/${AGENT_ID}/chat`, 404],
  [`/agents/${AGENT_ID}/chat`, 503],
] as const)(
  "A failed handoff at %s (%i) keeps the App usable and the draft intact",
  async (path, status) => {
    preserveDraft();
    context.mocks.api(marketingHandoffsContract.resolve, ({ respond }) => {
      return respond(status, {
        error: { code: "NOT_FOUND", message: "Content not found" },
      });
    });
    await setupPage({
      context,
      locale: "en-US",
      path: `${path}?handoff=${HASH}&prompt=Do%20not%20send%20this&model=gpt-5.6-sol&template=retired&connector=gmail&showcase=test`,
    });
    await expectUsableDraft();
    expect(screen.getAllByText(NOTICE)).toHaveLength(1);
  },
);

test("A network failure restoring a task keeps the App and the existing draft usable", async () => {
  preserveDraft();
  context.mocks.http.post("*/api/marketing-handoffs/:hash/resolve", () => {
    return HttpResponse.error();
  });
  await setupPage({
    context,
    locale: "en-US",
    path: `/prompt?handoff=${HASH}`,
  });
  await expectUsableDraft();
  expect(screen.getAllByText(NOTICE)).toHaveLength(1);
});

test.each(["/prompt", `/agents/${AGENT_ID}/chat`])(
  "An attachment import failure at %s preserves the existing draft",
  async (path) => {
    preserveDraft();
    context.mocks.api(marketingHandoffsContract.resolve, ({ respond }) => {
      return respond(200, {
        version: 1,
        prompt: "Do not send this incomplete task",
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
      return respond(503, {
        error: { code: "SERVICE_UNAVAILABLE", message: "Storage unavailable" },
      });
    });
    await setupPage({
      context,
      locale: "en-US",
      path: `${path}?handoff=${HASH}`,
    });
    await expectUsableDraft();
    expect(screen.getAllByText(NOTICE)).toHaveLength(1);
  },
);

test.each([true, false])(
  "An unavailable task resumes ordinary onboarding (admin: %s)",
  async (isAdmin) => {
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: !isAdmin,
      isAdmin,
    });
    context.mocks.api(marketingHandoffsContract.resolve, ({ respond }) => {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Content not found" },
      });
    });
    await setupPage({
      context,
      locale: "en-US",
      path: `/onboarding?handoff=${HASH}`,
    });
    await expect(
      screen.findByRole("heading", {
        name: "What kind of work do you do?",
      }),
    ).resolves.toBeInTheDocument();
    expect(screen.getAllByText(NOTICE)).toHaveLength(1);
    expect(new URLSearchParams(search()).has("handoff")).toBeFalsy();
  },
);

test("An unavailable task resumes the saved onboarding step and edited request", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  const originalApp = createTestRuntime(context);
  const stopOriginalPage$ = resetSignal();
  const originalSignal = originalApp.store.set(
    stopOriginalPage$,
    originalApp.signal,
  );
  await setupPage({
    context: { ...originalApp, signal: originalSignal },
    locale: "en-US",
    path: "/onboarding/ready",
  });
  await fill(
    await screen.findByLabelText("Your first task"),
    "Keep my onboarding draft",
  );
  originalApp.store.set(stopOriginalPage$);
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
  vi.mocked(window.history.forward).mockRestore();
  const replacementApp = createTestRuntime(context);
  context.mocks.api(marketingHandoffsContract.resolve, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Content not found" },
    });
  });
  await setupPage({
    context: replacementApp,
    locale: "en-US",
    path: `/onboarding?handoff=${HASH}`,
  });
  await expect(screen.findByLabelText("Your first task")).resolves.toHaveValue(
    "Keep my onboarding draft",
  );
  expect(pathname()).toBe("/onboarding/ready");
  expect(screen.getAllByText(NOTICE)).toHaveLength(1);
});

test.each([404, 503, "network"] as const)(
  "An imported attachment that cannot resolve (%s) keeps the saved draft and shows one notice",
  async (failure) => {
    preserveDraft();
    context.mocks.api(marketingHandoffsContract.resolve, ({ respond }) => {
      return respond(200, {
        version: 1,
        prompt: "Do not send this incomplete task",
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
            id: "bc3125d1-dc3f-4422-955c-f69f1d077608",
            filename: "notes.txt",
            contentType: "text/plain",
            size: 5,
            url: "https://app.okou.ai/artifacts/abcdefgh12/notes.txt",
          },
        ],
      });
    });
    if (failure === "network") {
      context.mocks.http.get("*/api/web/file-url", () => {
        return HttpResponse.error();
      });
    } else if (failure === 503) {
      context.mocks.http.get("*/api/web/file-url", () => {
        return HttpResponse.json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "Attachment storage unavailable",
            },
          },
          { status: 503 },
        );
      });
    } else {
      context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
        return respond(404, {
          error: {
            code: "NOT_FOUND",
            message: "Attachment storage unavailable",
          },
        });
      });
    }
    await setupPage({
      context,
      locale: "en-US",
      path: `/agents/${AGENT_ID}/chat?handoff=${HASH}`,
    });
    const notice =
      failure === 404
        ? "notes.txt is no longer available. Upload it again to send."
        : failure === 503
          ? "Attachment storage unavailable"
          : NOTICE;
    await expectUsableDraft();
    expect(screen.getAllByText(notice)).toHaveLength(1);
  },
);

test.each([401, 426])(
  "Authentication and upgrade failures (%i) keep their existing handling",
  async (status) => {
    preserveDraft();
    context.mocks.http.post("*/api/marketing-handoffs/:hash/resolve", () => {
      return HttpResponse.json(
        {
          error: {
            code: status === 401 ? "UNAUTHORIZED" : "CLIENT_UPGRADE_REQUIRED",
            message: "Client cannot continue",
          },
        },
        { status },
      );
    });
    await expect(
      setupPage({ context, locale: "en-US", path: `/prompt?handoff=${HASH}` }),
    ).rejects.toMatchObject({ status });
    expect(new URLSearchParams(search()).get("handoff")).toBe(HASH);
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  },
);

test("A valid task restores its text and attachments into the agent composer", async () => {
  preserveDraft();
  context.mocks.api(marketingHandoffsContract.resolve, ({ respond }) => {
    return respond(200, {
      version: 1,
      prompt: "Prepare the received report",
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
          id: "bc3125d1-dc3f-4422-955c-f69f1d077608",
          filename: "notes.txt",
          contentType: "text/plain",
          size: 5,
          url: "https://app.okou.ai/artifacts/abcdefgh12/notes.txt",
        },
      ],
    });
  });
  await setupPage({
    context,
    locale: "en-US",
    path: `/agents/${AGENT_ID}/chat?handoff=${HASH}`,
  });
  await waitFor(() => {
    expect(
      document.querySelector(
        '[data-slot="chat-composer-card"] [contenteditable="true"]',
      ),
    ).toHaveTextContent("Prepare the received report");
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(new URLSearchParams(search()).has("handoff")).toBeFalsy();
  });
  expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
});
