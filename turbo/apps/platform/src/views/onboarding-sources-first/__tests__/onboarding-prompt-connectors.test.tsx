import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";
import {
  getConnectorAction,
  mockOAuthCompletions,
  queryConnectorAction,
} from "../../okou-page/__tests__/connector-page-test-helpers.ts";
import {
  mockOnboardingConnectorCatalog,
  onboardingSourceItem,
} from "./onboarding-catalog-test-helpers.ts";

const context = testContext();
const PROMPT = "Review my latest campaign and draft a launch plan";
const RECOMMENDED_TOOLS = [
  { slug: "gmail", label: "Gmail" },
  { slug: "google-drive", label: "Google Drive" },
  { slug: "google-calendar", label: "Google Calendar" },
  { slug: "google-docs", label: "Google Docs" },
  { slug: "google-sheets", label: "Google Sheets" },
  { slug: "google-ads", label: "Google Ads" },
  { slug: "notion", label: "Notion" },
  { slug: "github", label: "GitHub" },
] as const;

function mockPromptOnboarding() {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  mockOnboardingConnectorCatalog(
    context,
    RECOMMENDED_TOOLS.map((tool) => {
      return onboardingSourceItem({
        ...tool,
        description: `Connect ${tool.label} to work with your information.`,
        hasAccount: false,
      });
    }),
  );
}

test.each([
  { mobile: false, path: ROUTES.onboarding, action: "Next" },
  { mobile: true, path: ROUTES.onboardingSources, action: "Start task" },
])(
  "A prompt link offers recommended connections and can run without them (mobile: $mobile)",
  async ({ mobile, path, action }) => {
    mockPromptOnboarding();
    context.mocks.browser.matchMedia((query) => {
      return mobile && query === "(width < 640px)";
    });
    let runPrompt: string | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runPrompt = body.prompt;
      },
    });

    await setupPage({
      context,
      path: `${path}?prompt=${encodeURIComponent(PROMPT)}`,
    });

    const recommendations = await screen.findByRole("region", {
      name: "Connect your work tools",
    });
    await waitFor(() => {
      expect(
        getConnectorAction("button", "Connect Google Ads", recommendations),
      ).toBeEnabled();
    });
    for (const tool of RECOMMENDED_TOOLS) {
      expect(
        getConnectorAction("button", `Connect ${tool.label}`, recommendations),
      ).toBeEnabled();
    }
    expect(screen.getByLabelText("Onboarding prompt")).toHaveValue(PROMPT);

    const editedPrompt = `${PROMPT} for next month`;
    await fill(screen.getByLabelText("Onboarding prompt"), editedPrompt);
    click(getConnectorAction("button", action));

    await waitFor(() => {
      expect(runPrompt).toBe(
        `${editedPrompt}\n\nCreate a complete document with the results in the requested file format (Markdown by default). Upload it as an artifact and include the working artifact link in your final response.`,
      );
      expect(pathname()).toMatch(/^\/chats\//u);
    });
  },
);

test("Recommendations offer the OAuth methods available in the current catalog", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  const gmail = onboardingSourceItem({
    slug: "gmail",
    label: "Gmail",
    description: "Read and manage Gmail messages.",
    hasAccount: false,
  });
  const notion = onboardingSourceItem({
    slug: "notion",
    label: "Notion",
    description: "Access Notion pages and databases.",
    hasAccount: false,
  });
  mockOnboardingConnectorCatalog(context, [
    gmail,
    { ...notion, authMethods: [], singleAuthCodeAuthMethodId: null },
  ]);

  await setupPage({
    context,
    path: `${ROUTES.onboarding}?prompt=${encodeURIComponent(PROMPT)}`,
  });

  await waitFor(() => {
    expect(getConnectorAction("button", "Connect Gmail")).toBeEnabled();
  });
  expect(queryConnectorAction("button", "Connect Notion")).toBeNull();
  expect(getConnectorAction("button", "Next")).toBeEnabled();
});

test.each([
  { slug: "google-ads", label: "Google Ads" },
  { slug: "notion", label: "Notion" },
  { slug: "github", label: "GitHub" },
])(
  "A recommended $label connection completes OAuth without losing the edited prompt",
  async ({ slug, label }) => {
    mockPromptOnboarding();
    const completedAttempts = mockOAuthCompletions(context);
    const authWindow = context.mocks.browser.authWindow();
    authWindow.closed = true;
    Object.defineProperty(authWindow, "location", {
      value: { href: "" },
      configurable: true,
    });
    context.mocks.browser.open(authWindow);
    const oauthAttemptId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const authorizationUrl = `https://oauth.test/${slug}/authorize`;
    context.mocks.api(
      builtinConnectorOauthStartContract.start,
      ({ body, params, respond }) => {
        expect(params.connectorSlug).toBe(slug);
        expect(body.authMethod).toBe("oauth");
        expect(body.account).toStrictEqual({ intent: "add" });
        completedAttempts.set(oauthAttemptId, connectionId);
        context.mocks.data.connectors([
          {
            id: connectionId,
            slug,
            authMethod: "oauth",
            externalId: "connected-account",
            externalUsername: null,
            externalEmail: null,
            oauthScopes: [],
            connectionStatus: "connected",
            reconnectReason: null,
            tokenExpiresAt: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ]);
        context.mocks.ably.trigger("connector:changed", {
          connectorSlug: slug,
        });
        return respond(200, { authorizationUrl, oauthAttemptId });
      },
    );

    await setupPage({
      context,
      host: "app.okou.ai",
      path: `${ROUTES.onboarding}?prompt=${encodeURIComponent(PROMPT)}`,
    });

    const connect = await waitFor(() => {
      const button = getConnectorAction("button", `Connect ${label}`);
      expect(button).toBeEnabled();
      return button;
    });
    const editedPrompt = `${PROMPT} using ${label}`;
    await fill(screen.getByLabelText("Onboarding prompt"), editedPrompt);
    click(connect);

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
      expect(getConnectorAction("button", "Connect Gmail")).toBeEnabled();
    });
    expect(authWindow.location.href).toBe(authorizationUrl);
    expect(screen.getByLabelText("Onboarding prompt")).toHaveValue(
      editedPrompt,
    );
    expect(getConnectorAction("button", "Next")).toBeEnabled();
  },
);
