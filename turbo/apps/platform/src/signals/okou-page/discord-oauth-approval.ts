import { command, computed, state } from "ccstate";
import type { z } from "zod";
import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { runtimeAuthenticatedIdentity$ } from "../auth-context.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { settle } from "../utils.ts";

type DiscordApprovalProof = z.infer<typeof discordOauthContract.approve.body>;

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
      window.location.pathname === "/works" &&
      fragment.get("discord_oauth") === "approve"
        ? discordOauthContract.approve.body.safeParse({
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

export const ownDiscordApprovalRoute$ = command(
  ({ set }, signal: AbortSignal) => {
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
  },
);

const verifyDiscordAuthorization$ = command(
  async ({ get, set }, proof: DiscordApprovalProof, signal: AbortSignal) => {
    await get(runtimeAuthenticatedIdentity$);
    signal.throwIfAborted();
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
    set(approvalProof$, null);
    set(approvalSucceeded$, true);
    // Approval is not a connection. Only the original tab may complete with its
    // separately retained token; if close() is blocked, the UI explains this.
    window.close();
  },
);

export const approveDiscordAuthorization$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const proof = get(approvalProof$);
    if (!proof || !get(featureSwitch$)[FeatureSwitchKey.DiscordIntegration]) {
      return;
    }
    // The authenticated endpoint verifies the initiating account and workspace.
    const request = set(verifyDiscordAuthorization$, proof, signal);
    set(approvalRequest$, request);
    // The panel owns failure and retry UI; a rejection must not fail route setup.
    await settle(request, signal);
  },
);
