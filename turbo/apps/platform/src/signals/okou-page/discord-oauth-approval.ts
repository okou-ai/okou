import { command, computed, state } from "ccstate";
import type { infer as zInfer } from "zod";
import { discordOauthContract } from "@okouai/api-contracts/client/discord-oauth";
import { discordOauthApprovalBodySchema } from "@okouai/api-contracts/validators/discord-oauth";
import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { runtimeAuthenticatedIdentity$ } from "../auth-context.ts";
import { replaceSearchParams$, searchParams$ } from "../route.ts";
import { onDomEventFn, setLoop, settle } from "../utils.ts";
import { refreshDiscordOrg$ } from "./discord.ts";
import { discordConnectParams } from "./discord-connect-params.ts";
import {
  discordOauthResultSchema,
  type DiscordOauthResult,
} from "./discord-oauth-message.ts";

type DiscordApprovalProof = zInfer<typeof discordOauthApprovalBodySchema>;

// Private, ephemeral consent-browser memory. Nothing is exposed to the opener,
// browser storage, logging, analytics, or a callback query parameter.
const approvalProof$ = state<DiscordApprovalProof | null>(null);
const approvalSucceeded$ = state(false);
const approvalRequest$ = state<Promise<void> | null>(null);

export const discordApprovalAvailable$ = computed((get) => {
  return get(approvalProof$) !== null;
});
export const discordApprovalSucceeded$ = computed((get) => {
  return get(approvalSucceeded$);
});
export const discordApprovalRequest$ = computed((get) => {
  return get(approvalRequest$);
});

export const captureDiscordApprovalFragment$ = command(
  ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const params = new URLSearchParams(window.location.search);
    const legacyCallback =
      window.location.pathname === "/works" &&
      ["pending", "error", "connected"].includes(params.get("discord") ?? "");
    if (
      legacyCallback ||
      window.location.pathname === INTEGRATION_SETTINGS_PATHS.discord ||
      window.location.pathname ===
        `${INTEGRATION_SETTINGS_PATHS.discord}/install`
    ) {
      const clean = discordConnectParams(
        params,
        legacyCallback ? "discord" : "status",
      );
      if (legacyCallback) {
        clean.set("discord", clean.get("status")!);
        clean.delete("status");
      }
      // Strip unrecognized query data before auth continuation and telemetry.
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${clean.size ? `?${clean}` : ""}${window.location.hash}`,
      );
    }
    if (!fragment.has("discord_oauth")) {
      return;
    }
    // Clear before telemetry initializes, including malformed approval links.
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    set(approvalSucceeded$, false);
    const parsed =
      (window.location.pathname === "/works" ||
        window.location.pathname === INTEGRATION_SETTINGS_PATHS.discord) &&
      fragment.get("discord_oauth") === "approve"
        ? discordOauthApprovalBodySchema.safeParse({
            state: fragment.get("state"),
            approvalProof: fragment.get("approval_proof"),
          })
        : null;
    set(approvalProof$, parsed?.success ? parsed.data : null);
    signal.addEventListener(
      "abort",
      () => {
        set(approvalProof$, null);
        set(approvalSucceeded$, false);
      },
      { once: true },
    );
  },
);

const showDiscordApprovalResult$ = command(
  async (
    { set },
    status: DiscordOauthResult["status"],
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    // A terminal result consumes this attempt. Its approval response may still
    // be in flight and must not overwrite the terminal result.
    set(approvalProof$, null);
    set(approvalRequest$, null);
    set(approvalSucceeded$, false);
    set(replaceSearchParams$, new URLSearchParams({ status }));
    if (status === "connected") {
      await set(refreshDiscordOrg$, signal);
      signal.throwIfAborted();
    }
  },
);

const interruptDiscordApproval$ = command(({ get, set }) => {
  set(approvalProof$, null);
  set(approvalSucceeded$, false);
  set(approvalRequest$, null);
  const params = discordConnectParams(get(searchParams$));
  params.set("status", "pending");
  set(replaceSearchParams$, params);
});

export const ownDiscordApprovalRoute$ = command(
  ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    signal.addEventListener(
      "abort",
      () => {
        set(approvalProof$, null);
        set(approvalSucceeded$, false);
        set(approvalRequest$, null);
      },
      { once: true },
    );
    const attemptState = get(approvalProof$)?.state;
    const opener: Window | null = window.opener;
    if (!attemptState) {
      return;
    }
    if (!opener || opener.closed) {
      set(interruptDiscordApproval$);
      return;
    }
    let terminal = false;
    // The listener is ready before approval allows the original tab to finish.
    const onResult = onDomEventFn((event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== opener) {
        return;
      }
      const message = discordOauthResultSchema.safeParse(event.data);
      if (!message.success || message.data.state !== attemptState) {
        return;
      }
      terminal = true;
      window.removeEventListener("message", onResult);
      return set(showDiscordApprovalResult$, message.data.status, signal);
    });
    window.addEventListener("message", onResult, { signal });
    opener.postMessage(
      { type: "discord-oauth-ready", state: attemptState },
      window.location.origin,
    );
    setLoop(
      () => {
        if (terminal) {
          return true;
        }
        if (!opener.closed) {
          return false;
        }
        terminal = true;
        window.removeEventListener("message", onResult);
        set(interruptDiscordApproval$);
        return true;
      },
      1000,
      signal,
      { testIntervalMs: 10 },
    );
  },
);

const verifyDiscordAuthorization$ = command(
  async ({ get, set }, proof: DiscordApprovalProof, signal: AbortSignal) => {
    await get(runtimeAuthenticatedIdentity$);
    signal.throwIfAborted();
    if (get(approvalProof$) !== proof) {
      return;
    }
    const client = get(apiClient$)(discordOauthContract);
    await accept(
      client.approve({
        body: proof,
        fetchOptions: { signal, credentials: "include" },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    if (get(approvalProof$) !== proof) {
      return;
    }
    set(approvalProof$, null);
    set(approvalSucceeded$, true);
    // Keep the authorization tab open while the original tab completes with
    // its separately retained proof and notifies this page of completion.
  },
);

export const approveDiscordAuthorization$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const proof = get(approvalProof$);
    if (!proof) {
      return;
    }
    // The authenticated endpoint verifies the initiating account and workspace.
    const request = set(verifyDiscordAuthorization$, proof, signal);
    set(approvalRequest$, request);
    // The panel displays the failed request; a rejection must not fail route setup.
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
    await settle(request, signal);
  },
);
