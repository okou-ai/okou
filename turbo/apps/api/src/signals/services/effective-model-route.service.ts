import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { computed, type Computed } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { db$ } from "../external/db";
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

export interface MemberModelRouteIdentity {
  readonly orgId: string;
  readonly userId: string;
}

/** Request-local metadata only.
 * Never call account list/capture, decrypt, or probe a provider here. A type is
 * a candidate only while its logical provider has a connected account. */
export function memberModelRouteContext(
  identity$: Computed<MemberModelRouteIdentity>,
): Computed<Promise<MemberModelRouteContext>> {
  return computed(async (get): Promise<MemberModelRouteContext> => {
    const { orgId, userId } = get(identity$);
    const db = get(db$);
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
          isNull(modelProviderAccounts.disconnectedAt),
        ),
      );
    return {
      subscriptions: PERSONAL_TYPES.flatMap((type) => {
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
      }),
    };
  });
}

export function isMemberSubscriptionRoute(args: {
  readonly catalog: ModelCatalog;
  readonly member: MemberModelRouteContext;
  readonly model: string | null | undefined;
  readonly providerType: string | null | undefined;
}): boolean {
  const { model } = args;
  const type = PERSONAL_TYPES.find((candidate) => {
    return candidate === args.providerType;
  });
  if (!model || !type || !isCatalogModelRunnable(args.catalog, model)) {
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
