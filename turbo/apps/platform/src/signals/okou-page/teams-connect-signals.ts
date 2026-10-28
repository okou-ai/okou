import { command, computed } from "ccstate";
import { replaceSearchParams$, searchParams$ } from "../route.ts";
import { authenticatedSessionKey$ } from "../auth.ts";
import { accept } from "../../lib/accept.ts";
import { refreshTeamsOrg$, teamsClient$, teamsOrgData$ } from "./teams.ts";
import {
  teamsConnectBody,
  teamsReturnUrl,
  teamsTargetState,
} from "./teams-connect-context.ts";

export const teamsConnectPageState$ = computed(async (get) => {
  const params = get(searchParams$);
  const { orgId, assertCurrent } = await get(teamsClient$);
  const data = await get(teamsOrgData$);
  assertCurrent();
  const target = teamsTargetState(params, data, orgId);
  const connected =
    data.isConnected &&
    (data.workspaceIdentity === true ||
      (data.isInstalled && !data.pendingInstallation));
  const success = connected && (target === "none" || target === "match");
  const body = teamsConnectBody(params);
  return {
    data,
    target,
    connected,
    success,
    canBind:
      data.workspaceIdentity !== true &&
      Boolean(body) &&
      target !== "orgMismatch" &&
      target !== "invalid" &&
      (!data.tenantId || data.tenantId === body?.tenantId) &&
      (!params.get("teamId") ||
        !data.teamId ||
        params.get("teamId") === data.teamId),
    returnUrl: teamsReturnUrl(params, data, success && target === "match"),
  };
});

export type TeamsConnectPageState = Awaited<
  ReturnType<typeof teamsConnectPageState$.read>
>;

export const connectTeamsAccount$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const owner = get(authenticatedSessionKey$);
    const params = get(searchParams$);
    const page = await get(teamsConnectPageState$);
    signal.throwIfAborted();
    const body = teamsConnectBody(params);
    if (!body || !page.canBind) {
      return;
    }
    const { client, assertCurrent } = await get(teamsClient$);
    signal.throwIfAborted();
    assertCurrent();
    if (get(authenticatedSessionKey$) !== owner) {
      throw new DOMException("Teams owner changed", "AbortError");
    }
    await accept(
      client.connect({ body, fetchOptions: { signal } }),
      [200],
      signal,
    );
    assertCurrent();
    // A successful mutation is not installation or exact-identity evidence.
    if (params.has("error")) {
      const next = new URLSearchParams(params);
      next.delete("error");
      set(replaceSearchParams$, next);
    }
    await set(refreshTeamsOrg$, signal);
  },
);
