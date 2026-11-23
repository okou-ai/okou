import type { OnboardingDraftPayload } from "@okouai/api-contracts/validators/onboarding";
import { marketingHandoffsContract } from "@okouai/api-contracts/contracts/marketing-handoffs";
import { composerDraftContract } from "@okouai/api-contracts/contracts/composer-draft";
import {
  onboardingDraftContract,
  onboardingStatusContract,
} from "@okouai/api-contracts/contracts/onboarding";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { setupPage, fill } from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  textContinuityDraft,
  continuityAttachment,
} from "./chat-continuity-test-helpers.ts";
const context = testContext();
const hash = "c".repeat(64),
  report = "Prepare the received report",
  saved = "Existing coastal briefing",
  notice = /We couldn’t restore the linked task/;
const path =
  "/prompt?handoff=" +
  hash +
  "&prompt=Replace+this&model=model-B&template=Document&connector=Gmail&showcase=yes";
function priorDraft() {
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, textContinuityDraft(saved));
  });
}
function unavailable() {
  context.mocks.api(marketingHandoffsContract.resolve, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Unknown marketing task" },
    });
  });
}
function manifest() {
  context.mocks.api(marketingHandoffsContract.resolve, ({ respond }) => {
    return respond(200, {
      version: 1,
      prompt: report,
      options: {},
      files: [
        {
          hash: "d".repeat(64),
          filename: "notes.txt",
          size: 32,
          contentType: "text/plain",
        },
      ],
    });
  });
}
function imported() {
  const file = continuityAttachment(853, 1, "notes.txt");
  context.mocks.api(marketingHandoffsContract.import, ({ respond }) => {
    return respond(200, { files: [file] });
  });
  return file;
}
async function keptDraft() {
  await screen.findByText(notice);
  expect(screen.getAllByText(notice)).toHaveLength(1);
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(editor.textContent).toBe(saved);
  });
  for (const key of [
    "handoff",
    "prompt",
    "model",
    "template",
    "connector",
    "showcase",
  ]) {
    expect(new URL(location.href).searchParams.has(key)).toBeFalsy();
  }
  await fill(editor, saved + " is editable");
  return editor;
}
test("marketing-handoff-recovery-001 an unavailable prompt clears link options and leaves the member's saved draft editable", async () => {
  priorDraft();
  unavailable();
  await setupPage({ context, path });
  await expect(keptDraft()).resolves.toHaveTextContent(saved + " is editable");
});
test("marketing-handoff-recovery-007 a lost resolution response returns the member to their existing editable draft with one notice", async () => {
  priorDraft();
  context.mocks.http.post("*/api/marketing-handoffs/:hash/resolve", () => {
    return HttpResponse.error();
  });
  await setupPage({ context, path });
  await expect(keptDraft()).resolves.toHaveTextContent(saved + " is editable");
});
test("marketing-handoff-recovery-008 a rejected attachment import discards the handoff and restores the existing draft", async () => {
  priorDraft();
  manifest();
  context.mocks.api(marketingHandoffsContract.import, ({ respond }) => {
    return respond(503, {
      error: { code: "UNAVAILABLE", message: "Attachment service unavailable" },
    });
  });
  await setupPage({ context, path });
  await expect(keptDraft()).resolves.toHaveTextContent(saved + " is editable");
});
test("marketing-handoff-recovery-010 an unavailable task returns an administrator to the ordinary onboarding question", async () => {
  unavailable();
  context.mocks.api(onboardingStatusContract.getStatus, ({ respond }) => {
    return respond(200, {
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: true,
      hasOrg: false,
    });
  });
  await setupPage({
    context,
    path: "/onboarding?skipOnboarding=true&handoff=" + hash,
  });
  await screen.findByText(notice);
  expect(screen.getAllByText(notice)).toHaveLength(1);
  await expect(
    screen.findByText("What kind of work do you do?"),
  ).resolves.toBeInTheDocument();
  expect(new URL(location.href).searchParams.has("handoff")).toBeFalsy();
});
test.each([
  ["016", 401],
  ["017", 426],
] as const)(
  "marketing-handoff-recovery-%s a protected-entry response %i keeps the original handoff link",
  async (_id, status) => {
    priorDraft();
    context.mocks.http.post("*/api/marketing-handoffs/:hash/resolve", () => {
      return HttpResponse.json(
        { error: { code: "ACCESS", message: "Entry stopped" } },
        { status },
      );
    });
    await expect(setupPage({ context, path })).rejects.toMatchObject({
      status,
    });
    expect(new URL(location.href).searchParams.get("handoff")).toBe(hash);
    expect(screen.queryByText(notice)).toBeNull();
  },
);
test("marketing-handoff-recovery-015 failed attachment lookup leaves the member's prior agent draft editable", async () => {
  priorDraft();
  manifest();
  imported();
  context.mocks.http.get("*/api/web/file-url", () => {
    return HttpResponse.error();
  });
  await setupPage({ context, path: "/?handoff=" + hash });
  await expect(keptDraft()).resolves.toHaveTextContent(saved + " is editable");
});
test("marketing-handoff-recovery-018 receiving a task places the exact report and its imported notes in the agent composer", async () => {
  manifest();
  const file = imported();
  context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
    return respond(200, {
      url: file.url,
      publicUrl: null,
      downloadUrl: file.url,
      expiresAt: "2099-01-01T00:00:00Z",
    });
  });
  context.mocks.http.get(file.url, () => {
    return new HttpResponse("Quarterly notes");
  });
  await setupPage({ context, path: "/?handoff=" + hash });
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(editor.textContent).toBe(report);
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(new URL(location.href).searchParams.has("handoff")).toBeFalsy();
  });
});

test("marketing-handoff-recovery-012 the next app opens an unavailable task with the request saved by the first app", async () => {
  const first = createTestRuntime(context);
  const next = createTestRuntime(context);
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin: true,
  });
  let draft: OnboardingDraftPayload = {
    step: "ready",
    answers: {
      industry: "marketing",
      experienced: false,
      provider: null,
      startingPromptDraft: "Review the first task",
      startingPromptKey: "edited",
      startingPromptOutput: null,
      recommendationJobId: null,
      recommendationStartedAt: null,
    },
  };
  let rev = crypto.randomUUID();
  const saved = context.mocks.deferred<void>();
  context.mocks.api(onboardingDraftContract.get, ({ respond }) => {
    return respond(200, { draft: { ...draft, revision: rev } });
  });
  context.mocks.api(onboardingDraftContract.save, ({ body, respond }) => {
    draft = { step: body.step, answers: body.answers };
    rev = crypto.randomUUID();
    if (draft.answers.startingPromptDraft === "Keep my onboarding draft") {
      saved.resolve();
    }
    return respond(200, { revision: rev });
  });
  unavailable();
  await setupPage({ context: first, path: "/onboarding/ready" });
  await fill(
    await screen.findByLabelText("Your first task"),
    "Keep my onboarding draft",
  );
  await waitFor(() => {
    return expect(saved.settled()).toBeTruthy();
  });
  cleanup();
  first.dispose();

  await setupPage({ context: next, path: "/onboarding?handoff=" + hash });
  await screen.findByText(notice);
  expect(screen.getAllByText(notice)).toHaveLength(1);
  expect(location.pathname).toBe("/onboarding/ready");
  await expect(screen.findByLabelText("Your first task")).resolves.toHaveValue(
    "Keep my onboarding draft",
  );
});
