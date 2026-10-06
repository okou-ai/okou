import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { cleanup, screen } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, vi, describe, beforeEach, it } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { resetSignal } from "../../../signals/utils.ts";
import {
  context,
  findEnabledButton,
  installRunChat,
  queryButton,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const secondContext = testContext();

it("Release a VAD session initialized after the old composer was cancelled", async () => {
  const loadStarted = context.mocks.deferred<void>();
  const modelReady = context.mocks.deferred<void>();
  const released = context.mocks.deferred<void>();
  installRunChat();
  context.mocks.browser.voiceInput({
    rms: 0.12,
    vadModelReady: () => {
      loadStarted.resolve();
      return modelReady.promise;
    },
    onVadRelease: released.resolve,
  });
  const resetPage$ = resetSignal();
  const pageSignal = context.store.set(resetPage$, context.signal);
  await setupPage({
    context: { ...context, signal: pageSignal },
    path: RUN_PATH,
  });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await loadStarted.promise;
  context.store.set(resetPage$);
  releasePageDom();
  await setupPage({
    context: secondContext,
    path: RUN_PATH,
    auth: { user: { id: "other-user", fullName: "Other User" } },
  });
  await findEnabledButton("Voice input");
  modelReady.resolve();
  await released.promise;
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
    "",
  );
  expect(queryButton("Retry")).toBeNull();
});

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

describe.each(["user", "org"] as const)(
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
        path: RUN_PATH,
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
