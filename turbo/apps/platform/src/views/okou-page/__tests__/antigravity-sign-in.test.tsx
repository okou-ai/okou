import { antigravityDeviceAuthContract } from "@okouai/api-contracts/contracts/antigravity-device-auth";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { thirdPartySubscriptionsMainContract } from "@okouai/api-contracts/contracts/third-party-subscriptions";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getAction,
} from "./connector-integrations-test-helpers.ts";
import { providerGroup } from "./personal-account-settings-fixtures.ts";
import { buildRunModel } from "./chat-model-builders.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { getMockModelCatalog } from "../../../mocks/handlers/api-model-catalog.ts";

const context = testContext();
const browserUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=agy&state=state-1";
const redirect =
  "http://localhost:51121/oauth-callback?state=state-1&code=4/0AeaYSHB-code";
function antigravityAccount(): ModelProviderResponse {
  return {
    id: "da000062-0000-4000-8000-000000000071",
    type: "antigravity",
    framework: "claude-code",
    accountEmail: "pilot@gmail.com",
    isActive: true,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-11-25T00:00:00Z",
    updatedAt: "2026-11-25T00:00:00Z",
  };
}

function serveSignIn() {
  const calls = {
    start: [] as { mode?: string; modelProviderId?: string }[],
    complete: [] as string[],
    cancel: 0,
  };
  let connected = false;
  context.mocks.api(
    antigravityDeviceAuthContract.start,
    ({ body, respond }) => {
      calls.start.push(body);
      return respond(200, {
        sessionToken: `session-${calls.start.length}`,
        type: "antigravity",
        status: "pending",
        browserUrl,
        expiresIn: 900,
      });
    },
  );
  context.mocks.api(
    antigravityDeviceAuthContract.complete,
    ({ body, respond }) => {
      calls.complete.push(body.authorizationCode);
      if (body.authorizationCode !== redirect) {
        return respond(400, {
          error: {
            message: "The pasted address belongs to another sign-in",
            code: "BAD_REQUEST",
          },
        });
      }
      connected = true;
      return respond(200, {
        status: "complete",
        created: true,
        provider: antigravityAccount(),
      });
    },
  );
  context.mocks.api(antigravityDeviceAuthContract.cancel, ({ respond }) => {
    calls.cancel += 1;
    return respond(200, { status: "cancelled" });
  });
  context.mocks.api(thirdPartySubscriptionsMainContract.list, ({ respond }) => {
    return respond(200, {
      subscriptions: connected ? [antigravityAccount()] : [],
    });
  });
  return calls;
}

// The pilot switch is only available to staff organizations.
const staffOrg = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";

async function openModels(enabled: boolean) {
  await setupPage({
    context,
    path: "/?settings=model",
    featureSwitches: { [FeatureSwitchKey.GeminiAntigravity]: enabled },
    auth: {
      user: { id: "user_antigravity_pilot", fullName: "Pilot member" },
      organization: {
        activeOrg: { id: staffOrg, name: "Staff" },
        memberships: [{ id: staffOrg }],
      },
    },
  });
}

test("connects a Google AI account by pasting the redirect address", async () => {
  const calls = serveSignIn();
  await openModels(true);
  const group = await providerGroup("Google AI (Antigravity)");
  await group.findByText("No accounts connected.");
  click(group.button("Connect account"));

  const dialog = await screen.findByRole("dialog", {
    name: "Connect Google AI (Antigravity)",
  });
  const signIn = await findAction("link", "Open Google sign-in", dialog);
  expect(signIn).toHaveAttribute("href", browserUrl);
  expect(signIn).toHaveAttribute("rel", "noopener noreferrer");
  expect(calls.start).toStrictEqual([{ mode: "add" }]);

  const address = within(dialog).getByRole("textbox", {
    name: "Address from your browser",
  });
  click(getAction("button", "Connect", dialog));
  await within(dialog).findByText(
    "Paste the address from your browser to continue.",
  );
  expect(calls.complete).toStrictEqual([]);

  await fill(address, "http://localhost:51121/oauth-callback?state=other");
  click(getAction("button", "Connect", dialog));
  await within(dialog).findByText(
    "The pasted address belongs to another sign-in",
  );

  await fill(address, redirect);
  click(getAction("button", "Connect", dialog));
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  const connected = await providerGroup("Google AI (Antigravity)");
  await connected.findByText("pilot@gmail.com");
  expect(calls.cancel).toBe(0);
});

test("closing the dialog cancels the pending sign-in", async () => {
  const calls = serveSignIn();
  await openModels(true);
  const group = await providerGroup("Google AI (Antigravity)");
  click(group.button("Connect account"));
  const dialog = await screen.findByRole("dialog", {
    name: "Connect Google AI (Antigravity)",
  });
  await findAction("link", "Open Google sign-in", dialog);
  click(getAction("button", "Close", dialog));
  await waitFor(() => {
    return expect(calls.cancel).toBe(1);
  });
  expect(dialog).not.toBeInTheDocument();
});

test("hides the Google AI group unless the member opted into the pilot", async () => {
  serveSignIn();
  await openModels(false);
  await providerGroup("Claude");
  expect(
    screen.queryByRole("region", { name: "Google AI (Antigravity)" }),
  ).toBeNull();
});

// The catalog lists the pilot models only for members who opted in.
function catalogWithGemini() {
  const catalog = getMockModelCatalog();
  const model = catalog.models.find((entry) => {
    return entry.model === "gpt-6-luna";
  });
  const route = catalog.routes.find((entry) => {
    return entry.model === "gpt-6-luna";
  });
  if (!model || !route) {
    throw new Error("The mock catalog lacks its subscription fixture");
  }
  return {
    ...catalog,
    models: [
      ...catalog.models,
      {
        ...model,
        model: "gemini-4-neon",
        displayName: "Gemini 4 Neon",
        resolvedModel: "gemini-4-neon",
        sortOrder: 230,
      },
    ],
    routes: [
      ...catalog.routes,
      {
        ...route,
        model: "gemini-4-neon",
        providerType: "antigravity",
        concreteProviderType: "antigravity",
        subscriptionType: "antigravity",
        upstreamModel: "gemini-4-neon",
      },
    ],
  };
}

test("the composer lists Gemini models under the Google AI plan", async () => {
  const account = antigravityAccount();
  context.mocks.api(modelCatalogContract.get, ({ respond }) => {
    return respond(200, catalogWithGemini());
  });
  context.mocks.data.personalModelProviders([account]);
  context.mocks.data.availableRunModels([
    buildRunModel({ model: null }),
    buildRunModel({
      model: "gemini-4-neon",
      modelLabel: "Gemini 4 Neon",
      providerType: "antigravity",
      modelProviderId: account.id,
    }),
  ]);
  await setupPage({
    context,
    path: "/",
    featureSwitches: { [FeatureSwitchKey.GeminiAntigravity]: true },
    auth: {
      user: { id: "user_antigravity_pilot", fullName: "Pilot member" },
      organization: {
        activeOrg: { id: staffOrg, name: "Staff" },
        memberships: [{ id: staffOrg }],
      },
    },
  });
  click(await composerModelTrigger("Auto"));
  const panel = within(
    await screen.findByRole("dialog", { name: "Chat models" }),
  );
  expect(panel.getByText("Your Google AI plan")).toBeVisible();
  expect(panel.getByText("Gemini 4 Neon")).toBeVisible();
});
