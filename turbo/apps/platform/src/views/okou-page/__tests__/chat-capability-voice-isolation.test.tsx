import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { cleanup } from "@testing-library/react";
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
