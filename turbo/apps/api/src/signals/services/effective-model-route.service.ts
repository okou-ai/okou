import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ReadonlyDb } from "../external/db";
import {
  isCatalogModelRunnable,
  type ModelCatalog,
} from "./model-catalog.service";
const PERSONAL_TYPES = [
  "claude-code-oauth-token",
  "codex-oauth-token",
] as const;
type PersonalType = (typeof PERSONAL_TYPES)[number];

interface PersonalCandidate {
  readonly type: PersonalType;
  readonly providerId: string | null;
  readonly needsReconnect: boolean;
}

export interface MemberModelRouteContext {
  readonly subscriptions: readonly PersonalCandidate[];
}

export async function loadMemberModelRouteContext(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<MemberModelRouteContext> {
  return {
    subscriptions: await loadPersonalModelRouteSubscriptions(db, orgId, userId),
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
  accounts: readonly {
    readonly type: string;
    readonly providerId: string;
    readonly isActive: boolean;
    readonly needsReconnect: boolean;
  }[],
): MemberModelRouteContext {
  return {
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
