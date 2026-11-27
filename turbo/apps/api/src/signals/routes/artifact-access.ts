import { command, computed } from "ccstate";
import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route-entry";
import {
  addArtifactShare$,
  getArtifactVisibility$,
  listArtifactShares$,
  removeArtifactShare$,
  resolveOwnedArtifactAccessTarget$,
  updateArtifactVisibility$,
} from "../services/artifact-access.service";
import { sendEmailOutboxItem$ } from "../services/email-common.service";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import { hostedSiteWorkspaceAccounts } from "../services/hosted-site-share-directory.service";
import {
  consumeHostedSiteSharingQuota$,
  type SharingQuotaRequest,
} from "../services/hosted-site-sharing-quota.service";

const searchAccounts$ = hostedSiteWorkspaceAccounts(
  computed((get) => {
    return {
      orgId: get(organizationAuthContext$).orgId,
      query: get(queryOf(artifactAccessContract.searchShareAccounts)).query,
    };
  }),
);

const recipientAccounts$ = hostedSiteWorkspaceAccounts(
  computed(async (get) => {
    const input = await get(bodyResultOf(artifactAccessContract.addShare));
    if (!input.ok) {
      throw new Error("Artifact recipients require a validated request");
    }
    const orgId = get(organizationAuthContext$).orgId;
    return "userId" in input.data
      ? { orgId, userId: [input.data.userId] }
      : { orgId, emailAddress: [input.data.email] };
  }),
);

const sharingAdmission$ = command(
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

const getVisibility$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  set(setResHeader$, "Referrer-Policy", "no-referrer");
  const auth = get(organizationAuthContext$);
  const { artifactId } = get(
    pathParamsOf(artifactAccessContract.getVisibility),
  );
  const body = await set(
    getArtifactVisibility$,
    { artifactId, userId: auth.userId, orgId: auth.orgId },
    signal,
  );
  return body ? { status: 200 as const, body } : notFound("Artifact not found");
});

const updateVisibility$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  set(setResHeader$, "Referrer-Policy", "no-referrer");
  const auth = get(organizationAuthContext$);
  const { artifactId } = get(
    pathParamsOf(artifactAccessContract.updateVisibility),
  );
  const parsed = await get(
    bodyResultOf(artifactAccessContract.updateVisibility),
  );
  signal.throwIfAborted();
  if (!parsed.ok) {
    return parsed.response;
  }
  const result = await set(
    updateArtifactVisibility$,
    {
      artifactId,
      userId: auth.userId,
      orgId: auth.orgId,
      visibility: parsed.data.visibility,
    },
    signal,
  );
  if (result.status === "not_found") {
    return notFound("Artifact not found");
  }
  if (result.status === "bad_request") {
    return badRequestMessage(result.message);
  }
  if (result.status === "conflict") {
    return conflict("Artifact visibility changed; reload before editing");
  }
  return { status: 200 as const, body: result.body };
});

const requireArtifactUserSharingFeature$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "private, no-store");
    const auth = get(organizationAuthContext$);
    const context = await set(
      loadUserFeatureSwitchContext$,
      auth.orgId,
      auth.userId,
      signal,
    );
    return isFeatureEnabled(FeatureSwitchKey.ArtifactUserSharing, context)
      ? auth
      : null;
  },
);

const listShares$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = await set(requireArtifactUserSharingFeature$, signal);
  if (!auth) {
    return notFound("Artifact not found");
  }
  const { artifactId } = get(pathParamsOf(artifactAccessContract.listShares));
  const shares = await set(
    listArtifactShares$,
    { artifactId, userId: auth.userId, orgId: auth.orgId },
    signal,
  );
  return shares
    ? { status: 200 as const, body: { shares } }
    : notFound("Artifact not found");
});

const searchShareAccounts$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = await set(requireArtifactUserSharingFeature$, signal);
    if (!auth) {
      return notFound("Artifact not found");
    }
    const { artifactId } = get(
      pathParamsOf(artifactAccessContract.searchShareAccounts),
    );
    const target = await set(
      resolveOwnedArtifactAccessTarget$,
      { artifactId, userId: auth.userId, orgId: auth.orgId },
      signal,
    );
    if (!target) {
      return notFound("Artifact not found");
    }
    const limited = await set(
      sharingAdmission$,
      { userId: auth.userId, orgId: auth.orgId, kind: "search" },
      signal,
    );
    if (limited) {
      return limited;
    }
    const accounts = await get(searchAccounts$);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        accounts: accounts.filter((account) => {
          return account.userId !== auth.userId;
        }),
      },
    };
  },
);

const addShare$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = await set(requireArtifactUserSharingFeature$, signal);
  if (!auth) {
    return notFound("Artifact not found");
  }
  const { artifactId } = get(pathParamsOf(artifactAccessContract.addShare));
  const input = await get(bodyResultOf(artifactAccessContract.addShare));
  signal.throwIfAborted();
  if (!input.ok) {
    return input.response;
  }
  const target = await set(
    resolveOwnedArtifactAccessTarget$,
    { artifactId, userId: auth.userId, orgId: auth.orgId },
    signal,
  );
  if (!target) {
    return notFound("Artifact not found");
  }
  if ("userId" in input.data && input.data.userId === auth.userId) {
    return badRequestMessage("You already own this artifact");
  }
  const recipientKey =
    "userId" in input.data
      ? `user:${input.data.userId}`
      : `email:${input.data.email}`;
  const limited = await set(
    sharingAdmission$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      kind: "user-share",
      recipientKey,
    },
    signal,
  );
  if (limited) {
    return limited;
  }
  const recipients = await get(recipientAccounts$);
  signal.throwIfAborted();
  const recipient = recipients.find((candidate) => {
    return "userId" in input.data
      ? candidate.userId === input.data.userId
      : candidate.email === input.data.email;
  });
  if (!recipient) {
    return badRequestMessage("Recipient must be a member of this workspace");
  }
  if (recipient.userId === auth.userId) {
    return badRequestMessage("You already own this artifact");
  }
  const result = await set(
    addArtifactShare$,
    {
      artifactId,
      userId: auth.userId,
      orgId: auth.orgId,
      recipient,
    },
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

const removeShare$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = await set(requireArtifactUserSharingFeature$, signal);
  if (!auth) {
    return notFound("Artifact not found");
  }
  const { artifactId, userId } = get(
    pathParamsOf(artifactAccessContract.removeShare),
  );
  const removed = await set(
    removeArtifactShare$,
    {
      artifactId,
      userId: auth.userId,
      orgId: auth.orgId,
      targetUserId: userId,
    },
    signal,
  );
  return removed
    ? { status: 200 as const, body: removed }
    : notFound("Artifact share not found");
});

const readAuth = {
  requireOrganization: true,
  requiredCapability: "artifact:read",
} as const;

const writeAuth = {
  requireOrganization: true,
  requiredCapability: "artifact:write",
} as const;

export const artifactAccessRoutes: readonly RouteEntry[] = [
  {
    route: artifactAccessContract.getVisibility,
    handler: authRoute(readAuth, getVisibility$),
  },
  {
    route: artifactAccessContract.updateVisibility,
    handler: authRoute(writeAuth, updateVisibility$),
  },
  {
    route: artifactAccessContract.listShares,
    handler: authRoute(writeAuth, listShares$),
  },
  {
    route: artifactAccessContract.searchShareAccounts,
    handler: authRoute(writeAuth, searchShareAccounts$),
  },
  {
    route: artifactAccessContract.addShare,
    handler: authRoute(writeAuth, addShare$),
  },
  {
    route: artifactAccessContract.removeShare,
    handler: authRoute(writeAuth, removeShare$),
  },
];
