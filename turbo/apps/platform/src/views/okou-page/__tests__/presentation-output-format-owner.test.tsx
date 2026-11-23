import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { createTemplateGalleryHelpers } from "./chat-composer-template-gallery-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);
const owner = Object.freeze({
  id: "presentation-owner-a",
  fullName: "Alex Rivera",
  email: "alex.rivera@example.test",
});
const organization = Object.freeze({
  activeOrg: Object.freeze({
    id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
    name: "Staff workspace",
  }),
});
const features = Object.freeze({
  [FeatureSwitchKey.PresentationOutputFormat]: true,
});

function preferences(
  presentationFormat: "html" | "pptx",
): UserPreferencesResponse {
  return {
    timezone: "Etc/UTC",
    locale: "en-US",
    supportedLocales: ["en-US"],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    chatResourcesEnabledByDefault: false,
    theme: "light",
    colorTheme: null,
    presentationFormat,
    forYouCoverId: null,
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };
}

function button(name: string) {
  const found = queryAllByRoleFast("button").find((candidate) => {
    return (
      (candidate.getAttribute("aria-label") ??
        candidate.textContent?.trim()) === name
    );
  });
  if (!found) {
    throw new Error(`Expected button ${name}`);
  }
  return found;
}

test.each(["account", "session"] as const)(
  "An untagged message uses the current owner's server format after a %s change",
  async (change) => {
    const capture = mockTemplateChat();
    const originalReadStarted = context.mocks.deferred<void>();
    const currentReadStarted = context.mocks.deferred<void>();
    let originalMember = preferences("pptx");
    const otherMember = preferences("html");
    context.mocks.api(userPreferencesContract.get, ({ request, respond }) => {
      switch (request.headers.get("authorization")) {
        case "Bearer original-session": {
          originalReadStarted.resolve();
          return respond(200, originalMember);
        }
        case "Bearer current-session": {
          currentReadStarted.resolve();
          return respond(
            200,
            change === "session" ? originalMember : otherMember,
          );
        }
        default: {
          throw new Error("Expected a configured Clerk session");
        }
      }
    });

    await setupPage({
      context,
      path: "/",
      auth: {
        user: owner,
        organization: {
          ...organization,
          memberships: [{ id: organization.activeOrg.id }],
        },
        session: { id: "original-session", token: "original-session" },
      },
      featureSwitches: features,
    });
    await originalReadStarted.promise;
    await findComposerEditor();

    if (change === "session") {
      // Another device saves HTML for this member before the new session opens.
      originalMember = { ...originalMember, presentationFormat: "html" };
    }
    const clerk = context.mocks.clerk();
    act(() => {
      clerk.user(
        change === "account"
          ? {
              id: "presentation-owner-b",
              fullName: "Sam Chen",
              email: "sam.chen@example.test",
            }
          : owner,
        { id: "current-session", token: "current-session" },
      );
      clerk.stateChanged();
    });
    await currentReadStarted.promise;

    const prompt = "Summarize our launch plan";
    await fill(await findComposerEditor(), prompt);
    click(button("Send"));
    await waitFor(() => {
      expect(capture.sentMessages).toHaveLength(1);
    });
    expect(capture.runPrompts).toStrictEqual([prompt]);
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "text",
      text: prompt,
    });
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "additional_info",
      text: expect.stringContaining("- Output format: HTML format"),
    });
  },
);

test.each([
  { change: "account", phase: "create" },
  { change: "session", phase: "create" },
  { change: "account", phase: "send" },
  { change: "session", phase: "send" },
])(
  "A pending $phase token cannot post the original PPTX context after a $change change",
  async ({ change, phase }) => {
    mockTemplateChat();
    context.mocks.data.userPreferences({ presentationFormat: "pptx" });
    const tokenRequested = context.mocks.deferred<void>();
    const releaseToken = context.mocks.deferred<void>();
    const threadCreates: string[] = [];
    const sends: string[] = [];
    const holdNextToken = () => {
      mockedClerk.sessionGetToken.mockImplementationOnce(async () => {
        tokenRequested.resolve();
        await releaseToken.promise;
        // Model the live Clerk token read completing under the new session.
        return "current-session";
      });
    };
    mockChatLifecycle(context, {
      onThreadCreate(body) {
        threadCreates.push(body.clientThreadId ?? "server-selected");
        if (phase === "send") {
          holdNextToken();
        }
      },
      onSendRequest(body) {
        sends.push(body.prompt ?? "");
      },
    });
    await setupPage({
      context,
      path: "/",
      auth: {
        user: owner,
        organization: {
          ...organization,
          memberships: [{ id: organization.activeOrg.id }],
        },
        session: { id: "original-session", token: "original-session" },
      },
      featureSwitches: features,
    });
    await fill(await findComposerEditor(), "Prepare the original owner's deck");
    if (phase === "create") {
      holdNextToken();
    }
    click(button("Send"));
    await tokenRequested.promise;
    expect(threadCreates).toHaveLength(phase === "create" ? 0 : 1);
    expect(sends).toStrictEqual([]);

    const clerk = context.mocks.clerk();
    await act(async () => {
      clerk.user(
        change === "account"
          ? {
              id: "presentation-owner-b",
              fullName: "Sam Chen",
              email: "sam.chen@example.test",
            }
          : owner,
        { id: "current-session", token: "current-session" },
      );
      clerk.stateChanged();
      releaseToken.resolve();
      await releaseToken.promise;
    });
    await findComposerEditor();
    expect(threadCreates).toHaveLength(phase === "create" ? 0 : 1);
    expect(sends).toStrictEqual([]);
  },
);
