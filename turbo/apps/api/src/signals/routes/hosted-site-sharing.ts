import { command, computed } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { hostedSiteSharingContract } from "@okouai/api-contracts/contracts/hosted-site-sharing";
import { badRequestMessage, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { getHostedSiteVisibility$ } from "../services/hosted-site-access.service";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import {
  hostedSiteShareList,
  removeHostedSiteShare$,
  shareHostedSite$,
} from "../services/hosted-site-sharing.service";
import { hostedSiteWorkspaceAccounts } from "../services/hosted-site-share-directory.service";
import { sendEmailOutboxItem$ } from "../services/email-common.service";
import {
  consumeHostedSiteSharingQuota$,
  type SharingQuotaRequest,
} from "../services/hosted-site-sharing-quota.service";
import { recordLegacyArtifactEndpointCall$ } from "../services/legacy-artifact-deprecation-telemetry";
import type { RouteEntry } from "../route-entry";

const shares$ = hostedSiteShareList(
  computed((get) => {
    return get(pathParamsOf(hostedSiteSharingContract.list)).siteId;
  }),
);
const searchAccounts$ = hostedSiteWorkspaceAccounts(
  computed((get) => {
    return {
      orgId: get(organizationAuthContext$).orgId,
      query: get(queryOf(hostedSiteSharingContract.search)).query,
    };
  }),
);
const recipientAccounts$ = hostedSiteWorkspaceAccounts(
  computed(async (get) => {
    const input = await get(bodyResultOf(hostedSiteSharingContract.share));
    if (!input.ok) {
      throw new Error("Website recipients require a validated invitation");
    }
    return {
      orgId: get(organizationAuthContext$).orgId,
      emailAddress: [input.data.email],
    };
  }),
);

const owner$ = command(
  async ({ get, set }, siteId: string, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "private, no-store");
    const auth = get(organizationAuthContext$);
    const context = await set(
      loadUserFeatureSwitchContext$,
      auth.orgId,
      auth.userId,
      signal,
    );
    if (!isFeatureEnabled(FeatureSwitchKey.HostedSiteEmailSharing, context)) {
      return null;
    }
    const owner = { ...auth, siteId };
    return (await set(getHostedSiteVisibility$, owner, signal)) ? owner : null;
  },
);

const admission$ = command(
  async ({ set }, args: SharingQuotaRequest, signal: AbortSignal) => {
    const retryAfter = await set(consumeHostedSiteSharingQuota$, args, signal);
    if (retryAfter === null) {
      return null;
    }
    set(setResHeader$, "Retry-After", String(retryAfter));
    return {
      status: 429 as const,
      body: {
        error: {
          code: "RATE_LIMITED",
          message: "Too many website sharing requests. Try again later.",
        },
      },
    };
  },
);

const list$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  set(recordLegacyArtifactEndpointCall$, {
    endpoint: "GET /api/host/sites/:siteId/shares",
    orgId: auth.orgId,
    userId: auth.userId,
  });
  const { siteId } = get(pathParamsOf(hostedSiteSharingContract.list));
  const owner = await set(owner$, siteId, signal);
  if (!owner) {
    return notFound("Published website not found");
  }
  const shares = await get(shares$);
  signal.throwIfAborted();
  return { status: 200 as const, body: { shares } };
});

const search$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  set(recordLegacyArtifactEndpointCall$, {
    endpoint: "GET /api/host/sites/:siteId/share-accounts",
    orgId: auth.orgId,
    userId: auth.userId,
  });
  const { siteId } = get(pathParamsOf(hostedSiteSharingContract.search));
  const owner = await set(owner$, siteId, signal);
  if (!owner) {
    return notFound("Published website not found");
  }
  const limited = await set(admission$, { ...owner, kind: "search" }, signal);
  if (limited) {
    return limited;
  }
  const accounts = await get(searchAccounts$);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      accounts: accounts.filter((account) => {
        return account.userId !== owner.userId;
      }),
    },
  };
});

const share$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  set(recordLegacyArtifactEndpointCall$, {
    endpoint: "POST /api/host/sites/:siteId/shares",
    orgId: auth.orgId,
    userId: auth.userId,
  });
  const { siteId } = get(pathParamsOf(hostedSiteSharingContract.share));
  const owner = await set(owner$, siteId, signal);
  if (!owner) {
    return notFound("Published website not found");
  }
  const input = await get(bodyResultOf(hostedSiteSharingContract.share));
  signal.throwIfAborted();
  if (!input.ok) {
    return input.response;
  }
  const limited = await set(
    admission$,
    { ...owner, kind: "share", email: input.data.email },
    signal,
  );
  if (limited) {
    return limited;
  }
  const recipients = await get(recipientAccounts$);
  signal.throwIfAborted();
  const result = await set(
    shareHostedSite$,
    { ...owner, ...input.data, recipient: recipients[0] },
    signal,
  );
  if (result.status === "self") {
    return badRequestMessage("You already own this website");
  }
  if (result.status === "not_found") {
    return notFound("Published website not found");
  }
  if (result.outboxId) {
    waitUntil(set(sendEmailOutboxItem$, result.outboxId, signal));
  }
  return {
    status: 200 as const,
    body: { share: result.share },
  };
});

const remove$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  set(recordLegacyArtifactEndpointCall$, {
    endpoint: "DELETE /api/host/sites/:siteId/shares/:shareId",
    orgId: auth.orgId,
    userId: auth.userId,
  });
  const params = get(pathParamsOf(hostedSiteSharingContract.remove));
  const owner = await set(owner$, params.siteId, signal);
  if (!owner) {
    return notFound("Published website not found");
  }
  const removed = await set(
    removeHostedSiteShare$,
    { ...owner, shareId: params.shareId },
    signal,
  );
  return removed
    ? { status: 200 as const, body: { removed: removed.id } }
    : notFound("Website share not found");
});

const auth = {
  requiredCapability: "host:write",
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;
export const hostedSiteSharingRoutes: readonly RouteEntry[] = [
  { route: hostedSiteSharingContract.list, handler: authRoute(auth, list$) },
  {
    route: hostedSiteSharingContract.search,
    handler: authRoute(auth, search$),
  },
  { route: hostedSiteSharingContract.share, handler: authRoute(auth, share$) },
  {
    route: hostedSiteSharingContract.remove,
    handler: authRoute(auth, remove$),
  },
];
