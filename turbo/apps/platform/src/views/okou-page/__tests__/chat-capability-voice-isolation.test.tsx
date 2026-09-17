import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, vi, describe, beforeEach, it } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { resetSignal } from "../../../signals/utils.ts";
import {
  context,
  findEnabledButton,
  installRunChat,
  NEW_CHAT_PATH,
  queryButton,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const secondContext = testContext();

function restoreHistory() {
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
}

function releasePageDom() {
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

describe.each(["user", "org", "target"] as const)(
  "keep local recordings isolated when the composer changes %s",
  (part) => {
    async function prepareScenario() {
      installVoiceBoundaries();
      const resetFirstPage$ = resetSignal();
      const firstPageSignal = context.store.set(
        resetFirstPage$,
        context.signal,
      );
      context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
        return HttpResponse.json(
          { error: "Temporary outage" },
          { status: 503 },
        );
      });
      await setupPage({
        locale: "en-US",
        context: { ...context, signal: firstPageSignal },
        path: RUN_PATH,
      });
      return { resetFirstPage$ };
    }
    let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
    beforeEach(async () => {
      preparedScenario = await prepareScenario();
    });
    it("preserves the complete scenario", async () => {
      const { resetFirstPage$ } = preparedScenario;
      click(await findEnabledButton("Voice input"));
      click(await findEnabledButton("Stop recording"));
      await findEnabledButton("Retry");
      context.store.set(resetFirstPage$);
      releasePageDom();
      await setupPage({
        locale: "en-US",
        context: secondContext,
        path: part === "target" ? NEW_CHAT_PATH : RUN_PATH,
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
    });
  },
);

describe("with an initial voice composer", () => {
  async function prepareScenario() {
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
    });
    const firstComposer = await screen.findByRole("textbox", {
      name: "Message",
    });
    const firstRoot = pageRoot(firstComposer);
    return {
      firstRoot,
      firstComposer,
      get successful() {
        return successful;
      },
      set successful(next: typeof successful) {
        successful = next;
      },
    };
  }
  let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
  beforeEach(async () => {
    preparedScenario = await prepareScenario();
  });
  it("removing another target's local recording preserves the original recording", async () => {
    const { firstRoot, firstComposer } = preparedScenario;
    click(await findEnabledButton("Voice input", firstRoot));
    click(await findEnabledButton("Stop recording", firstRoot));
    await findEnabledButton("Retry", firstRoot);

    restoreHistory();
    await setupPage({
      locale: "en-US",
      context: secondContext,
      path: NEW_CHAT_PATH,
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

    preparedScenario.successful = true;
    click(await findEnabledButton("Retry", firstRoot));
    await findEnabledButton("Voice input", firstRoot);
    expect(firstComposer).toHaveTextContent("Original recording.");
  });
});
