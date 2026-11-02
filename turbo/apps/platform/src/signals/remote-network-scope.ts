import { command, computed, state } from "ccstate";
import { cloudflareAccessContract } from "@okouai/api-contracts/client/cloudflare-access";
import type {
  ScopedCloudflareAccessConfig,
  CloudflareAccessImpactPreview,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { tailscaleContract } from "@okouai/api-contracts/client/tailscale";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { apiClient$ } from "./api-client.ts";
import { authenticatedSessionKey$ } from "./auth.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { isOrgAdmin$ } from "./org.ts";
import { accept } from "../lib/accept.ts";

export type RemoteNetworkProvider = "tailscale" | "cloudflare";
type RemoteNetworkScope = "personal" | "organization";
interface ScopeDraft {
  readonly sessionKey: string;
  readonly provider: RemoteNetworkProvider;
  readonly configId: string;
  readonly scope: RemoteNetworkScope;
}
interface ScopeChange extends ScopeDraft {
  readonly config: ScopedCloudflareAccessConfig;
}
const draft$ = state<ScopeDraft | null>(null);
const pending$ = state<ScopeChange | null>(null);
const acknowledged$ = state<string | null>(null);
const approved$ = state(false);
const error$ = state<"conflict" | "unavailable" | "uncertain" | null>(null);
const saved$ = state<{ id: string; sessionKey: string } | null>(null);
const enabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.RemoteControlGuidedSetup];
});
export const remoteNetworkScopeDraft$ = computed((get) => {
  const draft = get(draft$);
  return get(enabled$) && draft?.sessionKey === get(authenticatedSessionKey$)
    ? draft
    : null;
});
export const remoteNetworkScopeChange$ = computed((get) => {
  const pending = get(pending$);
  return get(enabled$) && pending?.sessionKey === get(authenticatedSessionKey$)
    ? pending
    : null;
});
export const remoteNetworkScopeStatus$ = computed((get) => {
  const sessionKey = get(authenticatedSessionKey$);
  const active =
    get(enabled$) &&
    (get(draft$)?.sessionKey === sessionKey ||
      get(pending$)?.sessionKey === sessionKey);
  const saved = get(saved$);
  return {
    error: active ? get(error$) : null,
    acknowledged: active ? get(acknowledged$) : null,
    savedId:
      get(enabled$) && saved?.sessionKey === sessionKey ? saved.id : null,
  };
});
export const editRemoteNetworkScope$ = command(
  (
    { get, set },
    provider: RemoteNetworkProvider,
    configId: string,
    scope: RemoteNetworkScope,
  ) => {
    const sessionKey = get(authenticatedSessionKey$);
    if (!sessionKey || !get(enabled$)) {
      return;
    }
    set(draft$, { provider, configId, scope, sessionKey });
    set(pending$, null);
    set(error$, null);
    set(approved$, false);
    set(acknowledged$, null);
    set(saved$, null);
  },
);
export const cancelRemoteNetworkScope$ = command(({ set }) => {
  set(pending$, null);
  set(approved$, false);
  set(acknowledged$, null);
});
export const acknowledgeRemoteNetworkScope$ = command(
  ({ set }, snapshot: string | null) => {
    set(acknowledged$, snapshot);
  },
);
export const approveRemoteNetworkScope$ = command(({ set }) => {
  set(approved$, true);
});
const scopeClient$ = computed((get) => {
  const sessionKey = get(authenticatedSessionKey$);
  const guard = () => {
    if (!sessionKey || sessionKey !== get(authenticatedSessionKey$)) {
      throw new DOMException("Network owner changed", "AbortError");
    }
  };
  const options = {
    getTokenGuard: () => {
      guard();
      return guard;
    },
  };
  const client = get(apiClient$);
  return {
    tailscale: client(tailscaleContract, options),
    cloudflare: client(cloudflareAccessContract, options),
  };
});
export const remoteNetworkScopeImpact$ = computed(async (get) => {
  const pending = get(remoteNetworkScopeChange$);
  if (!pending || pending.scope !== "personal") {
    return null;
  }
  const result = await accept(
    get(scopeClient$)[pending.provider].impactPreview({
      params: { configId: pending.configId },
      query: { operation: "convert" },
    }),
    [200, 403, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result.body : null;
});

function matchingScopeDraft(
  draft: ScopeDraft | null,
  provider: RemoteNetworkProvider,
  config: ScopedCloudflareAccessConfig,
): draft is ScopeDraft {
  return (
    !!draft &&
    draft.configId === config.id &&
    draft.provider === provider &&
    draft.scope !== config.scope
  );
}
function matchingScopeChange(
  pending: ScopeChange | null,
  draft: ScopeDraft,
  config: ScopedCloudflareAccessConfig,
): pending is ScopeChange {
  return (
    !!pending &&
    pending.configId === config.id &&
    pending.scope === draft.scope &&
    pending.config.revision === config.revision
  );
}

function scopeImpactConfirmed(
  pending: ScopeChange,
  preview: CloudflareAccessImpactPreview | null,
  acknowledged: string | null,
) {
  return (
    pending.scope !== "personal" ||
    (!!preview &&
      preview.expectedRevision === pending.config.revision &&
      (preview.otherHostCount === 0 || acknowledged === preview.impactSnapshot))
  );
}

export const applyRemoteNetworkScope$ = command(
  async (
    { get, set },
    provider: RemoteNetworkProvider,
    config: ScopedCloudflareAccessConfig,
    signal: AbortSignal,
  ) => {
    const draft = get(remoteNetworkScopeDraft$);
    if (!matchingScopeDraft(draft, provider, config)) {
      return config;
    }
    if (get(error$)) {
      return null;
    }
    const admin = await get(isOrgAdmin$);
    signal.throwIfAborted();
    if (!admin) {
      set(error$, "unavailable");
      return null;
    }
    signal.throwIfAborted();
    if (draft !== get(remoteNetworkScopeDraft$)) {
      return null;
    }
    let pending = get(remoteNetworkScopeChange$);
    if (!matchingScopeChange(pending, draft, config)) {
      pending = { ...draft, config };
      set(pending$, pending);
      set(approved$, false);
      set(acknowledged$, null);
    }
    if (pending.scope === "personal" && !get(approved$)) {
      return null;
    }
    const preview = await get(remoteNetworkScopeImpact$);
    signal.throwIfAborted();
    if (pending !== get(remoteNetworkScopeChange$)) {
      return null;
    }
    if (!scopeImpactConfirmed(pending, preview, get(acknowledged$))) {
      set(approved$, false);
      return null;
    }
    set(approved$, false);
    const client = get(scopeClient$)[provider];
    const params = { configId: config.id };
    const request =
      pending.scope === "organization"
        ? client.convertToOrganization({
            params,
            body: { expectedRevision: config.revision },
            fetchOptions: { signal },
          })
        : client.convertToPersonal({
            params,
            body: {
              expectedRevision: config.revision,
              impactSnapshot: preview?.impactSnapshot ?? "",
            },
            fetchOptions: { signal },
          });
    const result = await accept(
      request,
      [200, 400, 401, 403, 404, 409, 500],
      signal,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    if (pending !== get(remoteNetworkScopeChange$)) {
      return null;
    }
    if (result.status === 500) {
      set(error$, "uncertain");
      return null;
    }
    if (result.status !== 200) {
      set(error$, result.status === 409 ? "conflict" : "unavailable");
      return null;
    }
    set(saved$, { id: config.id, sessionKey: pending.sessionKey });
    set(draft$, null);
    set(pending$, null);
    set(acknowledged$, null);
    return result.body;
  },
);

export const resetRemoteNetworkScope$ = command(({ set }) => {
  set(draft$, null);
  set(pending$, null);
  set(approved$, false);
  set(acknowledged$, null);
  set(error$, null);
  set(saved$, null);
});
