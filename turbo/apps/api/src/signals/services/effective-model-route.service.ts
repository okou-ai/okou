import type {
  ModelProviderCredentialScope,
  ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ReadonlyDb } from "../external/db";
import {
  isCatalogModelRunnable,
  type ModelCatalog,
} from "./model-catalog.service";
const ORG_SENTINEL_USER_ID = "__org__";
const PERSONAL_TYPES = [
  "claude-code-oauth-token",
  "codex-oauth-token",
] as const;
type PersonalType = (typeof PERSONAL_TYPES)[number];

export interface ResolvedRunModelRoute {
  readonly modelProviderId: string | null;
  readonly modelProviderType: ModelProviderType;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope;
  readonly selectedModel: string;
  readonly personalConnectionState?:
    | "capture_required"
    | "reconnect_required"
    | "unavailable";
}

interface PersonalCandidate {
  readonly type: PersonalType;
  readonly providerId: string | null;
  readonly needsReconnect: boolean;
}

export interface MemberModelRouteContext {
  /** False only for the `__no_preference__` and `__org__` sentinel contexts. */
  readonly memberScoped: boolean;
  readonly subscriptions: readonly PersonalCandidate[];
}

interface LoadedPersonalModelRouteMetadata {
  readonly kind: "loaded";
  readonly subscriptions: readonly PersonalCandidate[];
}

/**
 * One request's member observations. `not-applicable` is authoritative;
 * `not-loaded` is the only state that may issue the scoped metadata read.
 */
export interface PreparedMemberModelRouteContext {
  readonly orgId: string;
  readonly userId: string;
  readonly memberScoped: boolean;
  readonly personalMetadata:
    | { readonly kind: "not-applicable" }
    | {
        readonly kind: "not-loaded";
        readonly load: () => Promise<LoadedPersonalModelRouteMetadata>;
      };
}

export function prepareMemberModelRouteContext(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): PreparedMemberModelRouteContext {
  if (userId === "__no_preference__" || userId === ORG_SENTINEL_USER_ID) {
    return Object.freeze({
      orgId,
      userId,
      memberScoped: false,
      personalMetadata: Object.freeze({ kind: "not-applicable" as const }),
    });
  }

  let loading: Promise<LoadedPersonalModelRouteMetadata> | undefined;
  const personalMetadata = Object.freeze({
    kind: "not-loaded" as const,
    load: (): Promise<LoadedPersonalModelRouteMetadata> => {
      loading ??= (async () => {
        const subscriptions = await loadPersonalModelRouteSubscriptions(
          db,
          orgId,
          userId,
        );
        return Object.freeze({
          kind: "loaded" as const,
          subscriptions: Object.freeze(
            subscriptions.map((candidate) => {
              return Object.freeze({ ...candidate });
            }),
          ),
        });
      })();
      return loading;
    },
  });
  return Object.freeze({
    orgId,
    userId,
    memberScoped: true,
    personalMetadata,
  });
}

export async function loadMemberModelRouteContext(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<MemberModelRouteContext> {
  const prepared = prepareMemberModelRouteContext(db, orgId, userId);
  if (prepared.personalMetadata.kind === "not-applicable") {
    return { memberScoped: false, subscriptions: [] };
  }
  const loaded = await prepared.personalMetadata.load();
  return {
    memberScoped: true,
    subscriptions: loaded.subscriptions,
  };
}

/** Request-local metadata only. This also runs under thread lifecycle locks.
 * Never call account list/capture, decrypt, or probe a provider here. A type is
 * a candidate only while its logical provider has a connected account. */
async function loadPersonalModelRouteSubscriptions(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<readonly PersonalCandidate[]> {
  const accounts = await db
    .select({
      type: modelProviderAccounts.type,
      providerId: modelProviderAccounts.modelProviderId,
      isActive: modelProviderAccounts.isActive,
      needsReconnect: modelProviderAccounts.needsReconnect,
    })
    .from(modelProviderAccounts)
    .where(
      and(
        eq(modelProviderAccounts.orgId, orgId),
        eq(modelProviderAccounts.userId, userId),
        inArray(modelProviderAccounts.type, [...PERSONAL_TYPES]),
        isNull(modelProviderAccounts.disconnectedAt),
      ),
    );
  return PERSONAL_TYPES.flatMap((type) => {
    const connected = accounts.filter((account) => {
      return account.type === type;
    });
    const first = connected[0];
    if (!first) {
      return [];
    }
    return [
      {
        type,
        // This is a logical candidate, never an admitted account ID.
        providerId: first.providerId,
        needsReconnect: connected.some((account) => {
          return account.isActive && account.needsReconnect;
        }),
      },
    ];
  });
}

export function isMemberSubscriptionRoute(args: {
  readonly catalog: ModelCatalog;
  readonly member: MemberModelRouteContext;
  readonly model: string | null | undefined;
  readonly providerType: string | null | undefined;
  /** The route's credential scope when the caller knows it. */
  readonly credentialScope?: string | null;
}): boolean {
  const { model } = args;
  const type = PERSONAL_TYPES.find((candidate) => {
    return candidate === args.providerType;
  });
  if (
    !model ||
    !type ||
    !args.member.memberScoped ||
    (args.credentialScope !== undefined &&
      args.credentialScope !== null &&
      args.credentialScope !== "member") ||
    !isCatalogModelRunnable(args.catalog, model)
  ) {
    return false;
  }
  return (
    args.member.subscriptions.some((candidate) => {
      return candidate.type === type && !candidate.needsReconnect;
    }) &&
    args.catalog.routes.some((route) => {
      return (
        route.enabled &&
        route.model === model &&
        route.subscriptionType === type
      );
    })
  );
}

export function memberModelRouteContextFromAccounts(
  userId: string,
  accounts: readonly {
    readonly type: string;
    readonly providerId: string;
    readonly isActive: boolean;
    readonly needsReconnect: boolean;
  }[],
): MemberModelRouteContext {
  return {
    memberScoped:
      userId !== "__no_preference__" && userId !== ORG_SENTINEL_USER_ID,
    subscriptions: PERSONAL_TYPES.flatMap((type) => {
      const connected = accounts.filter((account) => {
        return account.type === type;
      });
      const first = connected[0];
      return first
        ? [
            {
              type,
              providerId: first.providerId,
              needsReconnect: connected.some((account) => {
                return account.isActive && account.needsReconnect;
              }),
            },
          ]
        : [];
    }),
  };
}
