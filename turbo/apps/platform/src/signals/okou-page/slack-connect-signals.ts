import { command, computed, state } from "ccstate";
import { searchParams$ } from "../route.ts";
import { slackConnectContract } from "@okouai/api-contracts/client/slack-connect";
import type { SlackConnectLinkStatus } from "@okouai/api-contracts/contracts/slack-connect";
import { apiClient$ } from "../api-client.ts";
import { appendCapturedPreviewBypassToUrl } from "../../lib/preview-bypass-cookie.ts";
import { accept } from "../../lib/accept.ts";
import type { SlackOrgStatus } from "@okouai/api-contracts/contracts/integrations-slack";
import { slackOrgData$, reloadSlackOrg$ } from "./slack.ts";
import { authenticatedSessionKey$ } from "../auth.ts";
import { settle } from "../utils.ts";

const linkReload$ = state(0);
const reloadSlackConnectStatus$ = command(({ set }) => {
  set(linkReload$, (value) => {
    return value + 1;
  });
  set(reloadSlackOrg$);
});

interface SlackConnectWorkspaceStatus {
  readonly workspaceName?: string | null;
}

export type SlackConnectStatus =
  | {
      readonly kind: "overview";
      readonly data: SlackOrgStatus;
      readonly authorizationUrl: string | null;
    }
  | { readonly kind: "invalid" }
  | ({ readonly kind: "connect" } & SlackConnectWorkspaceStatus)
  | ({
      readonly kind: "success";
      readonly slackUserId: string;
    } & SlackConnectWorkspaceStatus)
  | (Exclude<
      SlackConnectLinkStatus,
      { readonly kind: "connect" | "connected" }
    > &
      SlackConnectWorkspaceStatus);

export const slackConnectStatus$ = computed(
  async (get): Promise<SlackConnectStatus> => {
    const params = get(searchParams$);
    const workspaceId = params.get("w");
    const slackUserId = params.get("u");
    get(linkReload$);

    if (!workspaceId && !slackUserId) {
      const data = await get(slackOrgData$);
      const action =
        data.scopeMismatch && data.isAdmin
          ? data.reinstallUrl
          : data.isConnected
            ? !data.isInstalled
              ? data.installUrl
              : null
            : (data.connectUrl ?? data.installUrl);
      const url = action ? new URL(action, window.location.origin) : null;
      const prompt = params.get("prompt");
      if (url && prompt) {
        url.searchParams.set("prompt", prompt);
      }
      if (url) {
        appendCapturedPreviewBypassToUrl(url);
      }
      return {
        kind: "overview",
        data,
        authorizationUrl: url?.toString() ?? null,
      };
    }
    if (!workspaceId || !slackUserId) {
      return { kind: "invalid" };
    }

    const client = get(apiClient$)(slackConnectContract);
    const result = await accept(
      client.getLinkStatus({ query: { workspaceId, slackUserId } }),
      [200],
    );
    const { linkStatus, workspaceName } = result.body;
    const workspace = workspaceName === undefined ? {} : { workspaceName };
    if (linkStatus.kind === "connected") {
      return { kind: "success", slackUserId, ...workspace };
    }
    if (linkStatus.kind === "connect") {
      return { kind: "connect", ...workspace };
    }
    return { ...linkStatus, ...workspace };
  },
);

export const effectiveError$ = computed((get) => {
  const params = get(searchParams$);
  return params.get("error") ?? "";
});

export const slackReturnUrl$ = computed((get) => {
  const params = get(searchParams$);
  const workspace = params.get("w");
  const channel = params.get("c");
  const url = new URL(channel ? "slack://channel" : "slack://open");
  if (workspace) {
    url.searchParams.set("team", workspace);
  }
  if (channel) {
    url.searchParams.set("id", channel);
  }
  return url.toString();
});

// Reconcile authenticated state once on entry before returning to Slack.
export const initSlackConnectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const owner = get(authenticatedSessionKey$);
    set(reloadSlackConnectStatus$);
    const pending = get(slackConnectStatus$);
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
    const result = await settle(pending, signal);
    // The page displays read errors; a failed or superseded read cannot launch Slack.
    if (
      !result.ok ||
      !owner ||
      get(authenticatedSessionKey$) !== owner ||
      get(slackConnectStatus$) !== pending ||
      get(effectiveError$)
    ) {
      return;
    }
    const status = result.value;
    if (status.kind === "success") {
      window.location.assign(get(slackReturnUrl$));
    } else if (
      status.kind === "overview" &&
      status.data.isConnected &&
      !status.data.scopeMismatch
    ) {
      window.location.assign("slack://open");
    }
  },
);

// Connect account
export const connectSlackAccount$ = command(
  async ({ get }, intent: "connect" | "switch", signal: AbortSignal) => {
    const params = get(searchParams$);
    const workspaceId = params.get("w");
    const slackUserId = params.get("u");
    if (!workspaceId || !slackUserId) {
      return;
    }

    const client = get(apiClient$)(slackConnectContract);
    const channelId = params.get("c");
    const threadTs = params.get("t");

    const requestUserScopes = true;
    const body = {
      workspaceId,
      slackUserId,
      requestUserScopes,
      ...(channelId ? { channelId } : {}),
      ...(threadTs ? { threadTs } : {}),
    } satisfies Parameters<typeof client.connect>[0]["body"];
    const request = { body, fetchOptions: { signal } };
    const result = await accept(
      intent === "switch"
        ? client.switchAccount(request)
        : client.connect(request),
      [202],
    );
    signal.throwIfAborted();

    window.location.href = result.body.authorizationUrl;
  },
);
