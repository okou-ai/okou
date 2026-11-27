import { command, computed } from "ccstate";
import { artifactSharingContract } from "@okouai/api-contracts/contracts/artifact-sharing";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { authRoute } from "../auth/auth-route";
import { organizationAuthContext$ } from "../auth/auth-context";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { badRequestMessage, notFound } from "../../lib/error";
import {
  artifactSharingResource,
  artifactSharingRecipients,
} from "../services/artifact-sharing-resource.service";
import { hostedSiteWorkspaceAccounts } from "../services/hosted-site-share-directory.service";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import {
  consumeHostedSiteSharingQuota$,
  type SharingQuotaRequest,
} from "../services/hosted-site-sharing-quota.service";
import {
  shareHostedSite$,
  removeHostedSiteShare$,
} from "../services/hosted-site-sharing.service";
import {
  shareFileArtifact$,
  removeFileArtifactShare$,
} from "../services/artifact-file-sharing.service";
import { sendEmailOutboxItem$ } from "../services/email-common.service";
import { recordLegacyArtifactEndpointCall$ } from "../services/legacy-artifact-deprecation-telemetry";
import type { RouteEntry } from "../route-entry";

const resource$ = artifactSharingResource(
  computed((get) => {
    return {
      ...get(organizationAuthContext$),
      ...get(pathParamsOf(artifactSharingContract.list)),
    };
  }),
);
const shares$ = artifactSharingRecipients(resource$);
const accounts$ = hostedSiteWorkspaceAccounts(
  computed((get) => {
    return {
      orgId: get(organizationAuthContext$).orgId,
      query: get(queryOf(artifactSharingContract.search)).query,
    };
  }),
);
const recipients$ = hostedSiteWorkspaceAccounts(
  computed(async (get) => {
    const input = await get(bodyResultOf(artifactSharingContract.share));
    if (!input.ok) {
      throw new Error("Artifact recipients require a validated invitation");
    }
    return {
      orgId: get(organizationAuthContext$).orgId,
      emailAddress: [input.data.email],
    };
  }),
);
const owner$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const auth = get(organizationAuthContext$);
  const context = await set(
    loadUserFeatureSwitchContext$,
    auth.orgId,
    auth.userId,
    signal,
  );
  return isFeatureEnabled(FeatureSwitchKey.HostedSiteEmailSharing, context)
    ? await get(resource$)
    : null;
});
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
          message: "Too many sharing requests. Try again later.",
        },
      },
    };
  },
);
const list$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  set(recordLegacyArtifactEndpointCall$, {
    endpoint: "GET /api/artifact-sharing/:kind/:id/shares",
    orgId: auth.orgId,
    userId: auth.userId,
  });
  if (!(await set(owner$, signal))) {
    return notFound("Artifact not found");
  }
  const shares = await get(shares$);
  signal.throwIfAborted();
  return { status: 200 as const, body: { shares } };
});
const search$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  set(recordLegacyArtifactEndpointCall$, {
    endpoint: "GET /api/artifact-sharing/:kind/:id/share-accounts",
    orgId: auth.orgId,
    userId: auth.userId,
  });
  const owner = await set(owner$, signal);
  if (!owner) {
    return notFound("Artifact not found");
  }
  const limited = await set(admission$, { ...owner, kind: "search" }, signal);
  if (limited) {
    return limited;
  }
  const accounts = await get(accounts$);
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
    endpoint: "POST /api/artifact-sharing/:kind/:id/shares",
    orgId: auth.orgId,
    userId: auth.userId,
  });
  const resource = await set(owner$, signal);
  if (!resource) {
    return notFound("Artifact not found");
  }
  const input = await get(bodyResultOf(artifactSharingContract.share));
  signal.throwIfAborted();
  if (!input.ok) {
    return input.response;
  }
  const limited = await set(
    admission$,
    {
      userId: resource.userId,
      orgId: resource.orgId,
      kind: "share",
      email: input.data.email,
    },
    signal,
  );
  if (limited) {
    return limited;
  }
  const recipients = await get(recipients$);
  signal.throwIfAborted();
  const recipient = recipients[0];
  const result =
    resource.kind === "site"
      ? await set(
          shareHostedSite$,
          {
            siteId: resource.id,
            userId: resource.userId,
            orgId: resource.orgId,
            email: input.data.email,
            recipient,
          },
          signal,
        )
      : await set(
          shareFileArtifact$,
          { resource, email: input.data.email, recipient },
          signal,
        );
  if (result.status === "self") {
    return badRequestMessage("You already own this artifact");
  }
  if (result.status === "not_found") {
    return notFound("Artifact not found");
  }
  if (result.outboxId) {
    waitUntil(set(sendEmailOutboxItem$, result.outboxId, signal));
  }
  return { status: 200 as const, body: { share: result.share } };
});
const remove$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  set(recordLegacyArtifactEndpointCall$, {
    endpoint: "DELETE /api/artifact-sharing/:kind/:id/shares/:shareId",
    orgId: auth.orgId,
    userId: auth.userId,
  });
  const resource = await set(owner$, signal);
  if (!resource) {
    return notFound("Artifact not found");
  }
  const { shareId } = get(pathParamsOf(artifactSharingContract.remove));
  const removed =
    resource.kind === "site"
      ? await set(
          removeHostedSiteShare$,
          {
            siteId: resource.id,
            userId: resource.userId,
            orgId: resource.orgId,
            shareId,
          },
          signal,
        )
      : await set(removeFileArtifactShare$, { resource, shareId }, signal);
  return removed
    ? { status: 200 as const, body: { removed: removed.id } }
    : notFound("Artifact share not found");
});
const auth = {
  requiredCapability: "artifact:write",
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;
export const artifactSharingRoutes: readonly RouteEntry[] = [
  { route: artifactSharingContract.list, handler: authRoute(auth, list$) },
  { route: artifactSharingContract.search, handler: authRoute(auth, search$) },
  { route: artifactSharingContract.share, handler: authRoute(auth, share$) },
  { route: artifactSharingContract.remove, handler: authRoute(auth, remove$) },
];
