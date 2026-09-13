import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createChildAbortController } from "../../../signals/utils.ts";
import {
  context,
  findEnabledButton,
  installRunChat,
  NEW_CHAT_PATH,
  queryButton,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const secondContext = testContext();
const flags = { [FeatureSwitchKey.VoiceInputV2]: true } as const;

function restoreHistory() {
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
}

function unload(page: AbortController) {
  const error = new Error("Page reloaded");
  error.name = "AbortError";
  page.abort(error);
  cleanup();
  restoreHistory();
}

function installVoiceBoundaries() {
  installRunChat();
  context.mocks.browser.voiceInput({ rms: 0.12 });
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, { allowed: true, count: 0, limit: 60 });
  });
}

function pageRoot(element: Element): HTMLElement {
  const root = Array.from(document.body.children).find((candidate) => {
    return candidate.contains(element);
  });
  if (!(root instanceof HTMLElement)) {
    throw new Error("Expected page root");
  }
  return root;
}

test.each(["user", "org", "target"] as const)(
  "Keep local recordings isolated when the composer changes %s",
  async (part) => {
    installVoiceBoundaries();
    // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
    const firstPage = createChildAbortController(context.signal);
    context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
      return HttpResponse.json({ error: "Temporary outage" }, { status: 503 });
    });
    await setupPage({
      locale: "en-US",
      context: { ...context, signal: firstPage.signal },
      path: RUN_PATH,
      featureSwitches: flags,
    });
    click(await findEnabledButton("Voice input"));
    click(await findEnabledButton("Stop recording"));
    await findEnabledButton("Retry");
    unload(firstPage);
    await setupPage({
      locale: "en-US",
      context: secondContext,
      path: part === "target" ? NEW_CHAT_PATH : RUN_PATH,
      featureSwitches: flags,
      auth: {
        user: {
          id: part === "user" ? "other-user" : "test-user-123",
          fullName: "Test User",
        },
        ...(part === "org"
          ? {
              organization: {
                activeOrg: { id: "org_other", name: "Other Organization" },
                memberships: [{ id: "org_other" }],
              },
            }
          : {}),
      },
    });
    await findEnabledButton("Voice input");
    expect(queryButton("Retry")).toBeNull();
  },
);

test("Removing another target's local recording preserves the original recording", async () => {
  installVoiceBoundaries();
  let successful = false;
  context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
    return successful
      ? HttpResponse.json({
          transcript: "original",
          polishedText: "Original recording.",
          language: "en-US",
        })
      : HttpResponse.json({ error: "Temporary outage" }, { status: 503 });
  });

  await setupPage({
    locale: "en-US",
    context,
    path: RUN_PATH,
    featureSwitches: flags,
  });
  const firstComposer = await screen.findByRole("textbox", {
    name: "Message",
  });
  const firstRoot = pageRoot(firstComposer);
  click(await findEnabledButton("Voice input", firstRoot));
  click(await findEnabledButton("Stop recording", firstRoot));
  await findEnabledButton("Retry", firstRoot);

  restoreHistory();
  await setupPage({
    locale: "en-US",
    context: secondContext,
    path: NEW_CHAT_PATH,
    featureSwitches: flags,
  });
  const secondComposer = await waitFor(() => {
    const composer = screen
      .getAllByRole("textbox", { name: "Message" })
      .find((candidate) => {
        return candidate !== firstComposer;
      });
    expect(composer).toBeDefined();
    return composer!;
  });
  const secondRoot = pageRoot(secondComposer);
  await findEnabledButton("Voice input", secondRoot);
  expect(queryButton("Retry", secondRoot)).toBeNull();
  click(await findEnabledButton("Voice input", secondRoot));
  click(await findEnabledButton("Stop recording", secondRoot));
  click(await findEnabledButton("Remove voice draft", secondRoot));
  await findEnabledButton("Voice input", secondRoot);

  successful = true;
  click(await findEnabledButton("Retry", firstRoot));
  await findEnabledButton("Voice input", firstRoot);
  expect(firstComposer).toHaveTextContent("Original recording.");
});
