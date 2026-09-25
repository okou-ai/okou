import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { connectorOauthStates } from "@okouai/db/schema/connector-oauth-state";
import { and, eq, gt, isNotNull, isNull, type SQL } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { storedConnectorAccountMutationSelection } from "./connector-account-mutation.service";

const storedOAuthStateSelection = Object.freeze({
  id: connectorOauthStates.id,
  state: connectorOauthStates.state,
  connectorSlug: connectorOauthStates.connectorSlug,
  customConnectorId: connectorOauthStates.customConnectorId,
  storageVersion: connectorOauthStates.storageVersion,
  authMethod: connectorOauthStates.authMethod,
  userId: connectorOauthStates.userId,
  orgId: connectorOauthStates.orgId,
  agentId: connectorOauthStates.agentId,
  authorizeAgent: connectorOauthStates.authorizeAgent,
  redirectUri: connectorOauthStates.redirectUri,
  authorizationUrl: connectorOauthStates.authorizationUrl,
  oauthRequestedScopes: connectorOauthStates.oauthRequestedScopes,
  codeVerifier: connectorOauthStates.codeVerifier,
  oauthContext: connectorOauthStates.oauthContext,
  accountMutation: storedConnectorAccountMutationSelection(
    connectorOauthStates.accountMutation,
  ),
  createdAt: connectorOauthStates.createdAt,
  expiresAt: connectorOauthStates.expiresAt,
  consumedAt: connectorOauthStates.consumedAt,
});

type StoredOAuthStateRow = Pick<
  typeof connectorOauthStates.$inferSelect,
  keyof typeof storedOAuthStateSelection
>;

export type StoredBuiltinOAuthState = Omit<
  StoredOAuthStateRow,
  "connectorSlug" | "customConnectorId" | "storageVersion"
> & {
  readonly connectorSlug: ConnectorSlug;
  readonly customConnectorId: null;
  readonly storageVersion: null;
};

export type StoredCustomConnectorOAuthState = Omit<
  StoredOAuthStateRow,
  "authMethod" | "connectorSlug" | "customConnectorId"
> & {
  readonly connectorSlug: null;
  readonly customConnectorId: string;
};

type BuiltinOAuthStateTarget = {
  readonly kind: "builtin";
  readonly connectorSlug: ConnectorSlug;
};

type CustomOAuthStateTarget = {
  readonly kind: "custom";
};

type OAuthStateTarget = BuiltinOAuthStateTarget | CustomOAuthStateTarget;

type ConnectorOAuthStateClaimResult<TState> =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "usable"; readonly state: TState };

type CustomConnectorOAuthStateReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "usable";
      readonly state: StoredCustomConnectorOAuthState;
    };

type ConnectorOAuthStateStatus =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "usable";
      readonly redirectUri: string;
    };

export async function insertConnectorOAuthState(
  db: Db,
  values: typeof connectorOauthStates.$inferInsert,
): Promise<string> {
  const [oauthState] = await db
    .insert(connectorOauthStates)
    .values(values)
    .returning({ id: connectorOauthStates.id });
  if (!oauthState) {
    throw new Error("Failed to create connector OAuth state");
  }
  return oauthState.id;
}

function oauthStateTargetConditions(
  target: OAuthStateTarget,
): readonly [SQL, SQL] {
  if (target.kind === "builtin") {
    return [
      eq(connectorOauthStates.connectorSlug, target.connectorSlug),
      isNull(connectorOauthStates.customConnectorId),
    ] as const;
  }
  return [
    isNull(connectorOauthStates.connectorSlug),
    isNotNull(connectorOauthStates.customConnectorId),
  ] as const;
}

function matchesOAuthStateTarget(
  state: Pick<StoredOAuthStateRow, "connectorSlug" | "customConnectorId">,
  target: OAuthStateTarget,
): boolean {
  if (target.kind === "builtin") {
    return (
      state.connectorSlug === target.connectorSlug &&
      state.customConnectorId === null
    );
  }
  return state.connectorSlug === null && state.customConnectorId !== null;
}

function narrowStoredOAuthState(
  state: StoredOAuthStateRow,
  target: BuiltinOAuthStateTarget,
): StoredBuiltinOAuthState | null;
function narrowStoredOAuthState(
  state: StoredOAuthStateRow,
  target: CustomOAuthStateTarget,
): StoredCustomConnectorOAuthState | null;
function narrowStoredOAuthState(
  state: StoredOAuthStateRow,
  target: OAuthStateTarget,
): StoredBuiltinOAuthState | StoredCustomConnectorOAuthState | null;
function narrowStoredOAuthState(
  state: StoredOAuthStateRow,
  target: OAuthStateTarget,
): StoredBuiltinOAuthState | StoredCustomConnectorOAuthState | null {
  if (!matchesOAuthStateTarget(state, target)) {
    return null;
  }
  if (target.kind === "builtin") {
    if (state.connectorSlug === null || state.storageVersion !== null) {
      return null;
    }
    return {
      ...state,
      connectorSlug: state.connectorSlug,
      customConnectorId: null,
      storageVersion: null,
    };
  }
  if (state.customConnectorId === null) {
    return null;
  }
  const { authMethod: _authMethod, ...customState } = state;
  return {
    ...customState,
    connectorSlug: null,
    customConnectorId: state.customConnectorId,
  };
}

function requireStoredOAuthState(
  state: StoredOAuthStateRow,
  target: OAuthStateTarget,
): StoredBuiltinOAuthState | StoredCustomConnectorOAuthState {
  const narrowed = narrowStoredOAuthState(state, target);
  if (!narrowed) {
    throw new Error(`Claimed ${target.kind} OAuth state has invalid identity`);
  }
  return narrowed;
}

export async function getConnectorOAuthStateStatus(
  db: Db,
  args: {
    readonly state: string;
    readonly target: OAuthStateTarget;
  },
  signal: AbortSignal,
): Promise<ConnectorOAuthStateStatus> {
  const [storedState] = await db
    .select({
      connectorSlug: connectorOauthStates.connectorSlug,
      customConnectorId: connectorOauthStates.customConnectorId,
      consumedAt: connectorOauthStates.consumedAt,
      expiresAt: connectorOauthStates.expiresAt,
      redirectUri: connectorOauthStates.redirectUri,
    })
    .from(connectorOauthStates)
    .where(eq(connectorOauthStates.state, args.state))
    .limit(1);
  signal.throwIfAborted();

  if (!storedState) {
    return { kind: "missing" };
  }

  if (
    !matchesOAuthStateTarget(storedState, args.target) ||
    storedState.consumedAt ||
    storedState.expiresAt <= nowDate()
  ) {
    return { kind: "invalid" };
  }

  return {
    kind: "usable",
    redirectUri: storedState.redirectUri,
  };
}

export function claimConnectorOAuthState(
  db: Db,
  args: {
    readonly state: string;
    readonly target: BuiltinOAuthStateTarget;
  },
  signal: AbortSignal,
): Promise<ConnectorOAuthStateClaimResult<StoredBuiltinOAuthState>>;
export function claimConnectorOAuthState(
  db: Db,
  args: {
    readonly state: string;
    readonly target: CustomOAuthStateTarget;
  },
  signal: AbortSignal,
): Promise<ConnectorOAuthStateClaimResult<StoredCustomConnectorOAuthState>>;
export async function claimConnectorOAuthState(
  db: Db,
  args: {
    readonly state: string;
    readonly target: OAuthStateTarget;
  },
  signal: AbortSignal,
): Promise<
  ConnectorOAuthStateClaimResult<
    StoredBuiltinOAuthState | StoredCustomConnectorOAuthState
  >
> {
  const claimedAt = nowDate();
  const [claimedState] = await db
    .delete(connectorOauthStates)
    .where(
      and(
        eq(connectorOauthStates.state, args.state),
        ...oauthStateTargetConditions(args.target),
        isNull(connectorOauthStates.consumedAt),
        gt(connectorOauthStates.expiresAt, claimedAt),
      ),
    )
    .returning(storedOAuthStateSelection);
  signal.throwIfAborted();

  if (claimedState) {
    return {
      kind: "usable",
      state: requireStoredOAuthState(claimedState, args.target),
    };
  }

  const [existingState] = await db
    .select({ id: connectorOauthStates.id })
    .from(connectorOauthStates)
    .where(eq(connectorOauthStates.state, args.state))
    .limit(1);
  signal.throwIfAborted();

  return existingState ? { kind: "invalid" } : { kind: "missing" };
}

export async function readCustomConnectorOAuthState(
  db: ReadonlyDb,
  args: {
    readonly state: string;
  },
  signal: AbortSignal,
): Promise<CustomConnectorOAuthStateReadResult> {
  const [storedState] = await db
    .select(storedOAuthStateSelection)
    .from(connectorOauthStates)
    .where(eq(connectorOauthStates.state, args.state))
    .limit(1);
  signal.throwIfAborted();
  if (!storedState) {
    return { kind: "missing" };
  }
  const narrowed = narrowStoredOAuthState(storedState, { kind: "custom" });
  if (
    !narrowed ||
    storedState.consumedAt ||
    storedState.expiresAt <= nowDate()
  ) {
    return { kind: "invalid" };
  }
  return { kind: "usable", state: narrowed };
}
