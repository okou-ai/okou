import { vi } from "vitest";
import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import {
  integrationsDiscordContract,
  type DiscordOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-discord";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

export const harbor = Object.freeze({
  guild: "1000000000000000321",
  previousGuild: "1000000000000000456",
  auth: {
    user: { id: "reader-iris", fullName: "Iris Reader" },
    session: { token: "harbor-session" },
    organization: {
      activeOrg: { id: "org_harbor", name: "Harbor" },
      memberships: [{ id: "org_harbor" }],
    },
  },
});
export const consentState = "s".repeat(43);
const approvalProof = "p".repeat(43);
const privateToken = "t".repeat(43);
export const consentFragment =
  "#" +
  new URLSearchParams({
    discord_oauth: "approve",
    state: consentState,
    approval_proof: approvalProof,
  });
export const authorizeUrl =
  "https://discord.com/oauth2/authorize?state=" + consentState;

export function statusService(
  context: TestContext,
  read: () => Partial<DiscordOrgStatus> | Promise<Partial<DiscordOrgStatus>>,
  sessionToken: string = harbor.auth.session.token,
) {
  context.mocks.api(
    integrationsDiscordContract.getStatus,
    async ({ request, respond }) => {
      if (request.headers.get("authorization") !== "Bearer " + sessionToken) {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Unexpected identity" },
        });
      }
      return respond(200, {
        isAvailable: true,
        isConnected: false,
        isAdmin: false,
        guildId: null,
        guildName: null,
        discordUserId: null,
        defaultAgentId: null,
        defaultAgentName: null,
        contextMode: "mentions_only",
        onboarding: "oauth",
        dmSelectionConnectionId: null,
        dmBindings: [],
        ...(await read()),
      });
    },
  );
}

export function browserPeer(context: TestContext) {
  const peer = context.mocks.browser.authWindow();
  Object.defineProperty(peer, "location", { value: { href: "about:blank" } });
  return peer;
}

export function watchApproval(context: TestContext, hold?: Promise<void>) {
  const received = createDeferredPromise<void>(context.signal);
  context.mocks.api(
    discordOauthContract.approve,
    async ({ body, request, respond }) => {
      if (
        body.state !== consentState ||
        body.approvalProof !== approvalProof ||
        request.headers.get("authorization") !== "Bearer harbor-session"
      ) {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Invalid proof owner" },
        });
      }
      received.resolve();
      await hold;
      return respond(200, { approved: true });
    },
  );
  return received;
}

export function consentOpener(context: TestContext) {
  const peer = browserPeer(context);
  vi.stubGlobal("opener", peer);
  return (status: "connected" | "error") => {
    return context.mocks.browser.message(
      { type: "discord-oauth-result", state: consentState, status },
      { source: peer, origin: location.origin },
    );
  };
}

export function authorizationService(
  context: TestContext,
  options: { guildId?: string; flow?: "install" },
  before: Partial<DiscordOrgStatus> = {},
  sessionToken: string = harbor.auth.session.token,
) {
  const checking = createDeferredPromise<void>(context.signal);
  const pending = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  let forbiddenMessage = "Harbor could not verify this identity";
  let approved = false;
  let outcome: "connected" | "forbidden" | "conflict" = "connected";
  let connected = false;
  statusService(
    context,
    () => {
      return connected
        ? {
            ...before,
            isConnected: true,
            guildId: harbor.guild,
            guildName: "Koala harbor",
            discordUserId: "731271",
          }
        : before;
    },
    sessionToken,
  );
  context.mocks.api(
    discordOauthContract.start,
    ({ body, request, respond }) => {
      if (
        body.guildId !== options.guildId ||
        body.flow !== options.flow ||
        request.headers.get("authorization") !== "Bearer " + sessionToken
      ) {
        return respond(403, {
          error: {
            code: "FORBIDDEN",
            message: "Wrong installation or identity",
          },
        });
      }
      return respond(200, {
        authorizationUrl: authorizeUrl,
        completionToken: privateToken,
      });
    },
  );
  context.mocks.api(
    discordOauthContract.complete,
    async ({ body, request, respond }) => {
      if (
        request.headers.get("authorization") !== "Bearer " + sessionToken ||
        body.state !== consentState ||
        body.completionToken !== privateToken
      ) {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Wrong owner or attempt" },
        });
      }
      const authorizedAtRequest = approved;
      if (!checking.settled()) {
        checking.resolve();
      }
      await release.promise;
      if (outcome === "forbidden") {
        return respond(403, {
          error: {
            code: "FORBIDDEN",
            message: forbiddenMessage,
          },
        });
      }
      if (!authorizedAtRequest) {
        if (!pending.settled()) {
          pending.resolve();
        }
        return respond(409, {
          error: {
            code: "DISCORD_OAUTH_APPROVAL_REQUIRED",
            message: "Consent outstanding",
          },
        });
      }
      if (outcome === "conflict") {
        return respond(409, {
          error: {
            code: "CONFLICT",
            message: "Disconnect the existing Discord identity first",
          },
        });
      }
      connected = true;
      return respond(200, { status: "connected" });
    },
  );
  return {
    pending,
    checking,
    release,
    approve: () => {
      approved = true;
    },
    fail: (reason: "forbidden" | "conflict", message?: string) => {
      if (message) {
        forbiddenMessage = message;
      }
      outcome = reason;
    },
  };
}
