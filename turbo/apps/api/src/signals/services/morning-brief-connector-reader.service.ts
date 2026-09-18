import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { connectorRuntimeTargetKey } from "@okouai/api-contracts/contracts/runners";
import { matchFirewallRequestDecision } from "@okouai/connectors/firewall-rule-matcher";
import type { NetworkPolicies } from "@okouai/connectors/firewall-types";
import {
  isFeatureEnabled,
  getAllFeatureStates,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { assertErasureSubjectWritable } from "@okouai/db/operations/account-erasure";
import { agents } from "@okouai/db/schema/agent";
import { connectors } from "@okouai/db/schema/connector";
import { and, eq, or, sql } from "drizzle-orm";
import type { z } from "zod";

import type { Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import type { ClerkClient } from "../external/clerk";
import type { Db, ReadonlyDb } from "../external/db";
import {
  readBoundedResponseText,
  safeJsonParse,
  settle,
  startUntrackedBestEffortCleanup,
} from "../utils";
import { loadAgentConnectorScope } from "./agent-connector-scope.service";
import {
  buildConnectorDiagnosticBaseCandidates,
  loadConnectorDiagnosticCatalogView,
} from "./connector-diagnostic-runtime.service";
import {
  listConnectorRuntimeVisibleSlugs,
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import {
  connectorCredentialRuntimeValueRef,
  loadConnectorCredentialConnection,
  loadConnectorCredentialValues,
  refreshConnectorCredentialAccess,
} from "./connector-credential-runtime.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { loadCurrentMembershipId } from "./morning-brief-membership.service";
import { loadMorningBriefMigrationState } from "./morning-brief-migration-state.service";
import { resolveActiveNetworkPolicyRefreshes } from "./user-permission-grants.service";
import { resolveWorkflowAutomationConnectorId } from "./workflow-automation-account.service";

/**
 * The shared authorization boundary every Simple Morning Brief OAuth source
 * reads through.
 *
 * A collector never holds a credential, never builds its own request and never
 * decides whether it may read. It receives a `MorningBriefConnectorReader` that
 * re-derives live authority — the member's current Clerk membership generation,
 * canonical ownership, the pinned connector account, the Agent's grants,
 * accepted catalog visibility and the effective URL policy — before the
 * credential is ever touched, before every request, and again before the
 * collected payload is released.
 *
 * Holding a credential is not permission. Every gate must produce an
 * unambiguous `allow`; missing metadata, no route match, `deny`, `ask` and
 * expired grants are all refusals. There is deliberately no authorization
 * result for a request that names no endpoint: the credential is decrypted
 * lazily, behind the first endpoint that a live policy actually allowed.
 *
 * The contract, its caps and its explicit limits are documented in
 * [Morning Brief Gmail collection](../../../../../../docs/morning-brief-gmail-collection.md).
 */

const L = logger("morning-brief-connector-reader.service");

/** Derived from live state and canonical ownership, never from a caller. */
export interface MorningBriefCollectionScope {
  readonly orgId: string;
  readonly userId: string;
  readonly installationId: string;
  readonly agentId: string;
  readonly chatThreadId: string | null;
  readonly anchor: Date;
  readonly timezone: string;
  /**
   * The immutable Clerk membership this collection speaks for. A removal and
   * rejoin issues a new id, so a new membership cannot release content the
   * previous one collected.
   */
  readonly membershipId: string;
}

interface MorningBriefReaderBudget {
  /** Every attempted request counts, including the ones that fail. */
  readonly maxRequests: number;
  readonly maxResponseBytes: number;
  readonly maxTotalResponseBytes: number;
}

/**
 * The one absolute deadline a whole source read spends.
 *
 * It is started by the composition that performs the real source admission, so
 * the identity preflight that admits the source, the credential preparation,
 * every provider request and body and the release fence all spend the same
 * budget. Nothing downstream starts a second one: a preflight that consumed the
 * whole budget leaves no allowance behind, rather than earning a fresh one.
 */
export interface MorningBriefSourceDeadline {
  /** Absolute `now()` milliseconds at which the source read expires. */
  readonly at: number;
  /** Aborts in-flight provider I/O once the wall clock is spent. */
  readonly signal: AbortSignal;
}

export function startMorningBriefSourceDeadline(
  budgetMs: number,
): MorningBriefSourceDeadline {
  return { at: now() + budgetMs, signal: AbortSignal.timeout(budgetMs) };
}

/**
 * Has this source's budget run out, by the clock rather than by the timer?
 *
 * `AbortSignal.timeout` only reports `aborted` once its callback has been
 * scheduled and run, so between the instant a budget expires and that callback
 * the bit is still false. Every decision about whether the source may keep
 * going — and above all the final release of a collected payload — compares the
 * absolute deadline, and the timer is left to do what a clock cannot: interrupt
 * I/O that is already in flight.
 */
function deadlineHasPassed(at: number, timer: AbortSignal): boolean {
  return timer.aborted || now() >= at;
}

/**
 * Why a whole source is unusable. These are terminal: the source is discarded,
 * no further request may be issued and no collected payload is released.
 */
type MorningBriefSourceUnavailable =
  | "not-connected"
  | "not-authorized"
  | "reconnect-required"
  | "source-revoked"
  | "deadline-exceeded"
  | "provider-failed";

type MorningBriefAccessResult<T> =
  | {
      readonly kind: "ok";
      readonly value: T;
      readonly requests: number;
      readonly truncatedTotalBytes: boolean;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: MorningBriefSourceUnavailable;
    };

/**
 * Bounded, validated provider response facts.
 *
 * Only an allowlist of headers is read, and a `Link` header contributes the
 * existence of a next page plus its validated page number — never a URL an
 * adapter could follow. Adapters keep constructing their own fixed paths.
 */
export interface MorningBriefResponseMetadata {
  readonly rateLimitRemaining: number | null;
  readonly rateLimitResetAt: string | null;
  readonly retryAfterMs: number | null;
  readonly hasNextPage: boolean;
  readonly nextPageNumber: number | null;
}

/**
 * One bounded GET.
 *
 * `denied` is endpoint-local and leaves a coverage gap: `scope: "policy"` is
 * this member's own effective permission refusing the endpoint, and
 * `scope: "provider"` is the provider answering `403`. A provider `403`
 * carrying `retryAfterMs` is a secondary rate limit rather than a lost
 * credential, which is why neither terminates the source. `revoked` discards
 * the entire source through the wrapper's latch.
 */
export type MorningBriefReadOutcome<T> =
  | {
      readonly kind: "ok";
      readonly value: T;
      readonly meta: MorningBriefResponseMetadata;
    }
  | { readonly kind: "not-found" }
  | {
      readonly kind: "denied";
      readonly scope: "policy" | "provider";
      readonly meta: MorningBriefResponseMetadata;
    }
  | {
      readonly kind: "rate-limited";
      readonly retryAfterMs: number | null;
      readonly meta: MorningBriefResponseMetadata;
    }
  | { readonly kind: "too-large" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "budget-exhausted";
      readonly limit: MorningBriefReaderLimit;
    }
  | { readonly kind: "provider-failed" }
  | { readonly kind: "revoked" };

type MorningBriefReaderLimit =
  | "total-requests"
  | "deadline"
  | "total-response-bytes";

export interface MorningBriefConnectorReader {
  /**
   * GET one allowlisted path on the source's fixed provider host. The reader
   * owns the host, the credential and the authorization; the provider module
   * owns only the path and its query.
   */
  getJson<T>(args: {
    readonly pathname: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly schema: z.ZodType<T>;
  }): Promise<MorningBriefReadOutcome<T>>;
  /**
   * The account this source is pinned to, for safe provider deep links. It is
   * `null` until the first authorized request resolves the credential.
   */
  readonly accountEmail: string | null;
}

/**
 * The exact account choice one source is admitted with, including absence.
 *
 * It is resolved once, before any source of the attempt starts reading, and
 * never re-derived while the attempt runs. Resolving a selection when each
 * later reader happens to start lets an account chosen after admission decide
 * what a source reads, so the attempt would not be the attempt that was
 * admitted. `absent` is a decision too: a source with no selected account when
 * the attempt began does not acquire one mid-attempt.
 */
export type MorningBriefFrozenSelection =
  | { readonly kind: "selected"; readonly connectorId: string }
  | { readonly kind: "absent" };

/**
 * What one source's released material was actually authorized by.
 *
 * `permissions` and `endpoints` are the real effective permissions this read
 * was admitted under and one representative URL per permission — the same
 * inputs the release fence already re-evaluates. A digest of constant method
 * names names an API rather than an authority, so it cannot tell a later check
 * what to re-ask; these can, because they are exactly what the live check
 * consumes.
 */
export interface MorningBriefSourceAuthorityProof {
  readonly connectionId: string;
  /** The provider account identity actually read, never a credential. */
  readonly accountRef: string | null;
  readonly permissions: readonly string[];
  readonly endpoints: readonly string[];
}

/**
 * One source's frozen choice, and the proof its reads produced.
 *
 * The collectors return provider-shaped contract envelopes that must not grow
 * an authorization field, so the composition creates this before the read and
 * reads the proof back out afterwards. `proof` stays null unless an authorized
 * read actually happened and its payload was released: a source that was never
 * admitted has no authorized input, and inventing one would give a later
 * permission check something to pass against that nothing observed.
 */
export interface MorningBriefSourceAuthorityLedger {
  readonly selection: MorningBriefFrozenSelection;
  proof: MorningBriefSourceAuthorityProof | null;
}

/** Every gate that answers "is this still the same member, owner and account?". */
interface MorningBriefAuthorizationRequest {
  readonly scope: MorningBriefCollectionScope;
  readonly connectorSlug: ConnectorSlug;
  /** Frozen at attempt admission; never re-derived mid-attempt. */
  readonly selection: MorningBriefFrozenSelection;
  readonly db: Db;
  readonly clerk: ClerkClient;
}

interface MorningBriefReaderRequest extends MorningBriefAuthorizationRequest {
  readonly apiBase: string;
  readonly environmentName: string;
  readonly budget: MorningBriefReaderBudget;
  readonly deadline: MorningBriefSourceDeadline;
}

/** The exact account this source is pinned to for its whole lifetime. */
interface PinnedAccount {
  readonly connectorId: string;
  readonly externalEmail: string | null;
  /**
   * The provider's own account id, used when a connection carries no email.
   *
   * A later check must be able to name the exact account the material came
   * from. A null account reference is "not observed", never "any account", so a
   * connector that identifies its accounts by id rather than address still
   * proves which one this was.
   */
  readonly externalId: string | null;
}

/**
 * Admission is the first identity check, before anything has been collected, so
 * a refusal there reports why the source never started. Every later phase is a
 * change under a source that already holds data, and discards it.
 */
type AuthorizationPhase = "admission" | "request" | "release";

type IdentityOutcome =
  | { readonly kind: "allow" }
  | {
      readonly kind: "revoked";
      readonly reason: MorningBriefSourceUnavailable;
    };

const EMPTY_METADATA: MorningBriefResponseMetadata = Object.freeze({
  rateLimitRemaining: null,
  rateLimitResetAt: null,
  retryAfterMs: null,
  hasNextPage: false,
  nextPageNumber: null,
});

function unavailable<T>(
  reason: MorningBriefSourceUnavailable,
): MorningBriefAccessResult<T> {
  return { kind: "unavailable", reason };
}

/** Admission names the refusal; a later change always discards the source. */
function phaseReason(
  phase: AuthorizationPhase,
  admissionReason: MorningBriefSourceUnavailable,
): MorningBriefSourceUnavailable {
  return phase === "admission" ? admissionReason : "source-revoked";
}

/**
 * The Agent must still exist in this org and still be visible to this member.
 * A private Agent someone else owns grants nothing.
 */
async function agentIsVisible(
  db: ReadonlyDb,
  scope: MorningBriefCollectionScope,
): Promise<boolean> {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.id, scope.agentId),
        eq(agents.orgId, scope.orgId),
        or(eq(agents.visibility, "public"), eq(agents.owner, scope.userId)),
      ),
    )
    .limit(1);
  return agent !== undefined;
}

const ADMISSION_LOCK_TIMEOUT = "1s";
const ADMISSION_STATEMENT_TIMEOUT = "5s";

/**
 * Erasure admission in one short, finitely bounded transaction.
 *
 * Admission takes the subject locks before any other row and holds them through
 * commit, so a closure committed while this waited is visible here. The
 * transaction deliberately contains no network call, and finite lock and
 * statement timeouts keep it inside the source deadline rather than blocking on
 * a lock for an unbounded time.
 */
async function subjectIsWritable(
  db: Db,
  owner: { readonly orgId: string; readonly userId: string },
): Promise<boolean> {
  const settled = await settle(
    db.transaction(async (tx: Tx) => {
      await tx.execute(
        sql`SELECT set_config('lock_timeout', ${ADMISSION_LOCK_TIMEOUT}, true)`,
      );
      await tx.execute(
        sql`SELECT set_config('statement_timeout', ${ADMISSION_STATEMENT_TIMEOUT}, true)`,
      );
      await assertErasureSubjectWritable(tx, [
        { subjectKind: "organization", subjectId: owner.orgId },
        { subjectKind: "user", subjectId: owner.userId },
      ]);
      return true;
    }),
  );
  // A closed subject aborts the transaction; that is a refusal, not an outage.
  return settled.ok;
}

/**
 * The canonical brief must still be installed, enabled and the same
 * installation on the same Agent that this collection was scoped to.
 */
async function ownershipIsUnchanged(
  db: ReadonlyDb,
  scope: MorningBriefCollectionScope,
): Promise<boolean> {
  const state = await loadMorningBriefMigrationState(db, {
    orgId: scope.orgId,
    userId: scope.userId,
  });
  return (
    state.kind === "installed" &&
    state.automation.enabled &&
    state.installation.id === scope.installationId &&
    state.installation.agentId === scope.agentId
  );
}

/**
 * The raw explicit account choice, failing closed.
 *
 * `resolveWorkflowAutomationConnectorId` uses the org default only when the
 * canonical thread holds no selection at all. An explicit selection that no
 * longer resolves to a live account of this owner is a refusal, never a reason
 * to read somebody else's mailbox: this path must not adopt the Run account
 * materializer's invalid-selection fallback.
 */
async function resolveSelectedConnectorId(
  db: ReadonlyDb,
  scope: MorningBriefCollectionScope,
  connectorSlug: ConnectorSlug,
): Promise<string | null> {
  return await resolveWorkflowAutomationConnectorId(db, {
    orgId: scope.orgId,
    userId: scope.userId,
    workflowId: scope.installationId,
    connectorSlug,
  });
}

/**
 * Freeze this source's account choice for the whole attempt.
 *
 * Called once per source before any read starts. The same failing-closed
 * resolution above decides it, so an explicit selection that no longer resolves
 * is still a refusal rather than somebody else's mailbox — this only fixes
 * *when* that question is asked.
 */
export async function freezeMorningBriefSourceSelection(
  db: ReadonlyDb,
  scope: MorningBriefCollectionScope,
  connectorSlug: ConnectorSlug,
): Promise<MorningBriefSourceAuthorityLedger> {
  const connectorId = await resolveSelectedConnectorId(
    db,
    scope,
    connectorSlug,
  );
  return {
    selection:
      connectorId === null
        ? { kind: "absent" }
        : { kind: "selected", connectorId },
    proof: null,
  };
}

/**
 * The pinned account must still be this owner's live account for this source.
 *
 * A deleted account, or one the owner has been asked to reconnect, withdraws
 * the access this read was admitted under even though its ID has not changed.
 */
async function pinnedAccountIsLive(
  db: ReadonlyDb,
  scope: MorningBriefCollectionScope,
  pinned: PinnedAccount,
  connectorSlug: ConnectorSlug,
): Promise<boolean> {
  const [account] = await db
    .select({ needsReconnect: connectors.needsReconnect })
    .from(connectors)
    .where(
      and(
        eq(connectors.id, pinned.connectorId),
        eq(connectors.orgId, scope.orgId),
        eq(connectors.userId, scope.userId),
        eq(connectors.connectorSlug, connectorSlug),
      ),
    )
    .limit(1);
  return account !== undefined && !account.needsReconnect;
}

/** Accepted catalog visibility for this member. Availability is not policy. */
async function connectorIsVisible(
  db: ReadonlyDb,
  snapshot: ConnectorRuntimeSnapshot,
  scope: MorningBriefCollectionScope,
  connectorSlug: ConnectorSlug,
): Promise<boolean> {
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    scope.orgId,
    scope.userId,
  );
  return listConnectorRuntimeVisibleSlugs({
    snapshot,
    featureStates: getAllFeatureStates(featureSwitchContext),
  }).includes(connectorSlug);
}

function decisionPermissions(
  routes: readonly { readonly permissionName: string; readonly rule: string }[],
) {
  const rulesByPermission = new Map<string, string[]>();
  for (const route of routes) {
    const rules = rulesByPermission.get(route.permissionName);
    if (rules) {
      rules.push(route.rule);
      continue;
    }
    rulesByPermission.set(route.permissionName, [route.rule]);
  }
  return [...rulesByPermission].map(([name, rules]) => {
    return { name, rules };
  });
}

/**
 * The effective, current URL-level decision for this exact request.
 *
 * Routing metadata comes from the accepted catalog and the policy from the
 * Agent's active grants, so an expired or revoked grant collapses to the
 * connector's default policy rather than to a stale allow. The policy map is
 * keyed by the runtime target key, because that is the firewall name the
 * matcher looks a policy up by; a bare slug key silently misses every active
 * `deny` and `ask` and evaluates as if the member held no grants at all.
 */
async function urlPermission(args: {
  readonly db: ReadonlyDb;
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly scope: MorningBriefCollectionScope;
  readonly connectorSlug: ConnectorSlug;
  readonly url: string;
}): Promise<{ readonly allowed: boolean; readonly permission: string | null }> {
  const view = await loadConnectorDiagnosticCatalogView(
    args.snapshot.serverFirewalls,
    args.connectorSlug,
  );
  if (!view) {
    return { allowed: false, permission: null };
  }
  const { candidates } = buildConnectorDiagnosticBaseCandidates(view, null, {
    allowStructuralDynamic: false,
  });
  const refreshes = await resolveActiveNetworkPolicyRefreshes(
    args.db,
    {
      orgId: args.scope.orgId,
      userId: args.scope.userId,
      agentId: args.scope.agentId,
    },
    [args.connectorSlug],
    args.snapshot,
  );
  const firewallName = connectorRuntimeTargetKey({
    kind: "builtin",
    connectorSlug: args.connectorSlug,
  });
  const policies: NetworkPolicies = Object.fromEntries(
    refreshes.map((refresh) => {
      return [
        connectorRuntimeTargetKey({
          kind: "builtin",
          connectorSlug: refresh.connectorSlug as ConnectorSlug,
        }),
        refresh.networkPolicy,
      ];
    }),
  );
  const decision = matchFirewallRequestDecision(
    [
      {
        name: firewallName,
        apis: candidates.map((candidate) => {
          return {
            base: candidate.decisionBase,
            auth: {},
            permissions: decisionPermissions(candidate.routes),
          };
        }),
      },
    ],
    "GET",
    args.url,
    policies,
    { status: "present", value: firewallName },
  );
  // Only an unambiguous allow passes. `no_match`, every block reason and an
  // ambiguous route are refusals.
  return decision.kind === "allow"
    ? { allowed: true, permission: decision.permission ?? null }
    : { allowed: false, permission: null };
}

/**
 * Is this frozen scope still the authority it was admitted as?
 *
 * Four facts, none of which a cached request identity answers: the subjects are
 * still open, the member still holds the *same* immutable Clerk membership
 * generation, the canonical brief is still the same installed and enabled
 * installation on the same Agent, and that Agent is still visible to them. A
 * removal and rejoin issues a new membership id, and an unrelated enabled
 * installation is not a substitute for the one this scope names.
 *
 * Connector-free on purpose: the unread Chat collection has no credential and
 * no endpoint, but it decides exactly the same question, so both it and this
 * module's own endpoint authority resolve it here rather than growing a second
 * authorization engine.
 */
export async function morningBriefScopeIsCurrent(
  args: {
    readonly db: Db;
    readonly clerk: ClerkClient;
    readonly scope: MorningBriefCollectionScope;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const { db, scope } = args;
  if (!(await subjectIsWritable(db, scope))) {
    return false;
  }
  signal.throwIfAborted();

  // The member's current Clerk membership generation, not a cache row's
  // presence. A removal, and a removal followed by a rejoin under a new id,
  // both fail here.
  const membershipId = await loadCurrentMembershipId(args.clerk, scope, signal);
  signal.throwIfAborted();
  if (membershipId === null || membershipId !== scope.membershipId) {
    return false;
  }

  if (!(await ownershipIsUnchanged(db, scope))) {
    return false;
  }
  signal.throwIfAborted();
  return await agentIsVisible(db, scope);
}

/**
 * Every identity gate this source depends on, re-derived live.
 *
 * This never decides an endpoint: it answers "is this still the same member,
 * owner, Agent and account?". Endpoint authority is separate and always names a
 * real URL.
 */
async function authorizeIdentity(
  request: MorningBriefAuthorizationRequest,
  pinned: PinnedAccount | null,
  phase: AuthorizationPhase,
  signal: AbortSignal,
): Promise<IdentityOutcome> {
  const { db, scope, connectorSlug } = request;
  if (
    !(await morningBriefScopeIsCurrent(
      { db, clerk: request.clerk, scope },
      signal,
    ))
  ) {
    return { kind: "revoked", reason: phaseReason(phase, "not-authorized") };
  }
  signal.throwIfAborted();

  const frozen = request.selection;
  if (frozen.kind === "absent") {
    // This source had no selected account when the attempt was admitted.
    // Connecting one now belongs to the next attempt, not to this one.
    return { kind: "revoked", reason: phaseReason(phase, "not-connected") };
  }
  const selectedConnectorId = await resolveSelectedConnectorId(
    db,
    scope,
    connectorSlug,
  );
  if (selectedConnectorId === null) {
    return { kind: "revoked", reason: phaseReason(phase, "not-connected") };
  }
  if (selectedConnectorId !== frozen.connectorId) {
    // The owner chose a different account after this attempt was admitted. The
    // frozen attempt neither releases what the previous account produced nor
    // silently continues on the new one — including for a source whose reads
    // had not started yet when the choice changed.
    return { kind: "revoked", reason: "source-revoked" };
  }
  if (pinned && pinned.connectorId !== frozen.connectorId) {
    return { kind: "revoked", reason: "source-revoked" };
  }
  if (
    pinned &&
    !(await pinnedAccountIsLive(db, scope, pinned, connectorSlug))
  ) {
    return {
      kind: "revoked",
      reason: phaseReason(phase, "reconnect-required"),
    };
  }
  signal.throwIfAborted();

  const scopeGrants = await loadAgentConnectorScope(db, {
    orgId: scope.orgId,
    userId: scope.userId,
    agentId: scope.agentId,
  });
  if (!scopeGrants.allowedConnectorSlugs.includes(connectorSlug)) {
    return { kind: "revoked", reason: phaseReason(phase, "not-authorized") };
  }
  signal.throwIfAborted();

  const snapshot = await loadConnectorRuntimeSnapshot(db);
  signal.throwIfAborted();
  if (!(await connectorIsVisible(db, snapshot, scope, connectorSlug))) {
    return { kind: "revoked", reason: phaseReason(phase, "not-authorized") };
  }
  return { kind: "allow" };
}

type UrlAuthorization =
  | { readonly kind: "allow"; readonly permission: string | null }
  | { readonly kind: "denied" }
  | {
      readonly kind: "revoked";
      readonly reason: MorningBriefSourceUnavailable;
    };

/** Identity plus this exact endpoint's live permission. */
async function authorizeUrl(
  request: MorningBriefAuthorizationRequest,
  pinned: PinnedAccount | null,
  url: string,
  phase: AuthorizationPhase,
  signal: AbortSignal,
): Promise<UrlAuthorization> {
  const identity = await authorizeIdentity(request, pinned, phase, signal);
  if (identity.kind !== "allow") {
    return identity;
  }
  const snapshot = await loadConnectorRuntimeSnapshot(request.db);
  signal.throwIfAborted();
  const decision = await urlPermission({
    db: request.db,
    snapshot,
    scope: request.scope,
    connectorSlug: request.connectorSlug,
    url,
  });
  signal.throwIfAborted();
  return decision.allowed
    ? { kind: "allow", permission: decision.permission }
    : { kind: "denied" };
}

interface ResolvedCredential {
  readonly accessToken: string;
  readonly pinned: PinnedAccount;
}

type CredentialResult =
  | { readonly kind: "ok"; readonly credential: ResolvedCredential }
  | {
      readonly kind: "unavailable";
      readonly reason: MorningBriefSourceUnavailable;
    };

/**
 * Load the selected account's credential, refreshing it when it is expiring.
 *
 * A refresh this reader performs legitimately advances the account's own
 * credential revision. Any other change is detected as a selection or liveness
 * change on the next authorization.
 */
async function loadCredential(
  request: MorningBriefReaderRequest,
  signal: AbortSignal,
): Promise<CredentialResult> {
  const { db, scope, connectorSlug } = request;
  if (request.selection.kind === "absent") {
    return { kind: "unavailable", reason: "not-connected" };
  }
  // The frozen choice, not a fresh resolution: the credential loaded here must
  // belong to the account this attempt was admitted with.
  const connectorId = request.selection.connectorId;
  const snapshot = await loadConnectorRuntimeSnapshot(db);
  signal.throwIfAborted();
  const loaded = await loadConnectorCredentialConnection({
    db,
    snapshot,
    orgId: scope.orgId,
    userId: scope.userId,
    connectorSlug,
    connectorId,
  });
  signal.throwIfAborted();
  if (loaded.kind === "missing") {
    return { kind: "unavailable", reason: "not-connected" };
  }
  if (loaded.kind === "unavailable" || loaded.connection.needsReconnect) {
    return { kind: "unavailable", reason: "reconnect-required" };
  }
  const connection = loaded.connection;
  const valueRef = connectorCredentialRuntimeValueRef(
    connection,
    request.environmentName,
  );
  if (valueRef === null) {
    return { kind: "unavailable", reason: "reconnect-required" };
  }
  const values = await loadConnectorCredentialValues({
    connection,
    db,
    valueRefs: [valueRef],
  });
  signal.throwIfAborted();
  const storedToken = values.get(valueRef);
  if (storedToken === undefined) {
    return { kind: "unavailable", reason: "reconnect-required" };
  }
  const pinned = {
    connectorId: connection.connectorId,
    externalEmail: connection.externalEmail,
    externalId: connection.externalId,
  };
  if (!credentialNeedsRefresh(connection.tokenExpiresAt)) {
    return { kind: "ok", credential: { accessToken: storedToken, pinned } };
  }
  const refreshed = await refreshConnectorCredentialAccess(
    {
      connection,
      db,
      orgId: scope.orgId,
      userId: scope.userId,
      runtimeEnvironmentName: request.environmentName,
      persist: { db, markNeedsReconnectOnFailure: true },
    },
    signal,
  );
  signal.throwIfAborted();
  if (refreshed.kind === "configuration-unavailable") {
    return { kind: "unavailable", reason: "provider-failed" };
  }
  if (refreshed.kind !== "ok") {
    return { kind: "unavailable", reason: "reconnect-required" };
  }
  return {
    kind: "ok",
    credential: { accessToken: refreshed.accessToken, pinned },
  };
}

const CREDENTIAL_REFRESH_BUFFER_MS = 60_000;

/**
 * A null expiry means the credential does not expire, not that it expired now.
 *
 * Forcing a refresh on a non-expiring credential — a GitHub OAuth token, a
 * personal access token, any manual method — drives it into an unsupported
 * refresh that fails before a single provider request is issued. A method that
 * genuinely cannot refresh still fails closed at the next authorization.
 */
function credentialNeedsRefresh(tokenExpiresAt: Date | null): boolean {
  return (
    tokenExpiresAt !== null &&
    tokenExpiresAt.getTime() <= now() + CREDENTIAL_REFRESH_BUFFER_MS
  );
}

const MAX_RETRY_AFTER_MS = 60_000;

/** Bounded metadata only. The reader never sleeps on a provider's advice. */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) {
    return null;
  }
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000));
}

function boundedInteger(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

const MAX_PAGE_NUMBER = 10_000;

/**
 * Read only the `rel="next"` page number out of an RFC 8288 `Link` header.
 *
 * The URL itself is deliberately dropped. Adapters learn that another page
 * exists and which page number it is, and keep building their own fixed paths;
 * nothing here can become a followable provider URL.
 */
function nextPageFromLink(header: string | null): {
  readonly hasNextPage: boolean;
  readonly nextPageNumber: number | null;
} {
  if (header === null) {
    return { hasNextPage: false, nextPageNumber: null };
  }
  const next = header.split(",").find((part) => {
    return /;\s*rel\s*=\s*"?next"?/i.test(part);
  });
  if (next === undefined) {
    return { hasNextPage: false, nextPageNumber: null };
  }
  const page = /[?&]page=(\d{1,5})\b/.exec(next)?.[1];
  const parsed = page === undefined ? null : Number(page);
  return {
    hasNextPage: true,
    nextPageNumber:
      parsed !== null &&
      Number.isSafeInteger(parsed) &&
      parsed <= MAX_PAGE_NUMBER
        ? parsed
        : null,
  };
}

function responseMetadata(response: Response): MorningBriefResponseMetadata {
  const resetSeconds = boundedInteger(
    response.headers.get("x-ratelimit-reset"),
  );
  return {
    rateLimitRemaining: boundedInteger(
      response.headers.get("x-ratelimit-remaining"),
    ),
    rateLimitResetAt:
      resetSeconds === null
        ? null
        : new Date(resetSeconds * 1000).toISOString(),
    retryAfterMs: retryAfterMs(response),
    ...nextPageFromLink(response.headers.get("link")),
  };
}

/** Release an unread error body without keeping its cancellation pending. */
function cancelResponseBody(response: Response): void {
  if (response.body) {
    startUntrackedBestEffortCleanup(response.body.cancel());
  }
}

interface ReaderState {
  /** Reserved before authorization so concurrent readers cannot overspend. */
  requests: number;
  /**
   * Bytes reserved or consumed. An abandoned oversized body keeps its whole
   * reservation charged, because the bounded reader stops at the allowance and
   * cannot report an exact consumed count.
   */
  reservedBytes: number;
  revoked: MorningBriefSourceUnavailable | null;
  truncatedTotalBytes: boolean;
  /**
   * One representative URL per distinct permission whose result this source
   * still holds. The release fence re-evaluates every one of them, so losing a
   * permission used earlier withholds the payload that permission produced even
   * when a different permission admitted the final request.
   */
  readonly retainedByPermission: Map<string, string>;
  /** Resolved lazily, behind the first endpoint a live policy allowed. */
  credential: ResolvedCredential | null;
}

function budgetLimit(
  state: ReaderState,
  request: MorningBriefReaderRequest,
  deadlineAt: number,
): MorningBriefReaderLimit | null {
  if (state.requests >= request.budget.maxRequests) {
    return "total-requests";
  }
  if (now() >= deadlineAt) {
    return "deadline";
  }
  if (state.reservedBytes >= request.budget.maxTotalResponseBytes) {
    return "total-response-bytes";
  }
  return null;
}

function readerUrl(
  request: MorningBriefReaderRequest,
  pathname: string,
  query: Readonly<Record<string, string>> | undefined,
): string {
  const url = new URL(pathname.replace(/^\/+/, ""), request.apiBase);
  for (const [name, value] of Object.entries(query ?? {})) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

interface ReaderContext {
  readonly request: MorningBriefReaderRequest;
  readonly state: ReaderState;
  readonly deadlineAt: number;
  /** Caller cancellation merged with this source's absolute deadline. */
  readonly bounded: AbortSignal;
  readonly deadline: AbortSignal;
}

/**
 * Perform one authorized provider GET and classify its response.
 *
 * Split out of the reader closure so the closure stays a readable admission
 * sequence and this stays the network boundary.
 */
async function performRead<T>(
  context: ReaderContext,
  args: {
    readonly url: string;
    readonly credential: ResolvedCredential;
    readonly schema: z.ZodType<T>;
  },
  signal: AbortSignal,
): Promise<MorningBriefReadOutcome<T>> {
  const { request, state, bounded, deadline } = context;
  const settled = await settle(
    fetch(args.url, {
      method: "GET",
      // A redirect would carry this credential to an unauthorized host.
      redirect: "error",
      signal: bounded,
      headers: {
        Authorization: `Bearer ${args.credential.accessToken}`,
        Accept: "application/json",
      },
    }),
  );
  signal.throwIfAborted();
  if (!settled.ok) {
    return deadline.aborted
      ? { kind: "budget-exhausted", limit: "deadline" }
      : { kind: "provider-failed" };
  }
  const response = settled.value;
  const meta = responseMetadata(response);
  if (response.status === 404) {
    cancelResponseBody(response);
    return { kind: "not-found" };
  }
  if (response.status === 429) {
    cancelResponseBody(response);
    return { kind: "rate-limited", retryAfterMs: meta.retryAfterMs, meta };
  }
  if (!response.ok) {
    cancelResponseBody(response);
    // 401 withdraws the credential itself. 403 is endpoint-local: one resource
    // can refuse a read while its siblings stay authorized, and a provider
    // secondary rate limit arrives as 403 with `Retry-After`. Neither proves
    // the credential is gone, so the source survives with a coverage gap.
    if (response.status === 401) {
      state.revoked = "reconnect-required";
      return { kind: "revoked" };
    }
    return response.status === 403
      ? { kind: "denied", scope: "provider", meta }
      : { kind: "provider-failed" };
  }

  // Reserve the whole allowance before streaming, so concurrent readers cannot
  // each believe the same remaining bytes are theirs.
  const remainingTotal = Math.max(
    0,
    request.budget.maxTotalResponseBytes - state.reservedBytes,
  );
  const allowance = Math.min(request.budget.maxResponseBytes, remainingTotal);
  state.reservedBytes += allowance;
  const read = await settle(readBoundedResponseText(response, allowance));
  signal.throwIfAborted();
  if (!read.ok) {
    return deadline.aborted
      ? { kind: "budget-exhausted", limit: "deadline" }
      : { kind: "provider-failed" };
  }
  if (read.value.kind === "too_large") {
    // Name the allowance that actually bound this read. A response that
    // overran the per-response ceiling while the cumulative budget still had a
    // full ceiling to give says nothing about the cumulative budget, and
    // reporting it as cumulative exhaustion overstates how much of the source
    // was skipped.
    if (remainingTotal < request.budget.maxResponseBytes) {
      state.truncatedTotalBytes = true;
    }
    return { kind: "too-large" };
  }
  // Release only what this response provably did not use.
  state.reservedBytes -= allowance - Buffer.byteLength(read.value.text, "utf8");
  const parsed = args.schema.safeParse(safeJsonParse(read.value.text));
  if (!parsed.success) {
    // Provider payloads never reach a log; only the shape failed.
    L.warn("Morning Brief source returned an unusable payload", {
      connectorSlug: request.connectorSlug,
      orgId: request.scope.orgId,
    });
    return { kind: "malformed" };
  }
  return { kind: "ok", value: parsed.data, meta };
}

/**
 * The bounded, per-request-authorized GET surface handed to one collector.
 */
function createConnectorReader(
  context: ReaderContext,
  signal: AbortSignal,
): MorningBriefConnectorReader {
  const { request, state, deadlineAt, bounded } = context;
  return {
    get accountEmail() {
      return state.credential?.pinned.externalEmail ?? null;
    },
    async getJson({ pathname, query, schema }) {
      if (state.revoked !== null) {
        return { kind: "revoked" };
      }
      const limit = budgetLimit(state, request, deadlineAt);
      if (limit !== null) {
        return { kind: "budget-exhausted", limit };
      }
      // Reserve the slot before the first await. Two concurrent readers would
      // otherwise both observe the same remaining budget and both spend it.
      state.requests += 1;
      const url = readerUrl(request, pathname, query);
      const decision = await authorizeUrl(
        request,
        state.credential?.pinned ?? null,
        url,
        "request",
        bounded,
      );
      if (decision.kind !== "allow" || state.revoked !== null) {
        // Nothing was attempted, so the reserved slot goes back.
        state.requests -= 1;
        if (decision.kind === "revoked") {
          state.revoked = decision.reason;
        }
        return state.revoked !== null
          ? { kind: "revoked" }
          : { kind: "denied", scope: "policy", meta: EMPTY_METADATA };
      }
      signal.throwIfAborted();
      // Authorization takes real time. Re-read the clock before admitting a
      // provider request, so a request can never start after its own deadline.
      if (now() >= deadlineAt) {
        state.requests -= 1;
        return { kind: "budget-exhausted", limit: "deadline" };
      }

      if (state.credential === null) {
        // The credential is decrypted behind the first endpoint a live policy
        // allowed, never before any endpoint has been authorized.
        const credential = await loadCredential(request, bounded);
        signal.throwIfAborted();
        if (credential.kind === "unavailable") {
          state.requests -= 1;
          state.revoked = credential.reason;
          return { kind: "revoked" };
        }
        // Preparing that credential can await a real OAuth refresh round trip
        // and its persistence, so the decision above is no longer live. Authority
        // withdrawn during that wait must not be spent: the same live identity
        // and policy implementation answers again, for the account preparation
        // actually produced and for this exact endpoint, before the first
        // provider request of this source is issued.
        const prepared = await authorizeUrl(
          request,
          credential.credential.pinned,
          url,
          "request",
          bounded,
        );
        signal.throwIfAborted();
        if (prepared.kind === "revoked" || state.revoked !== null) {
          state.requests -= 1;
          if (prepared.kind === "revoked") {
            state.revoked = prepared.reason;
          }
          return { kind: "revoked" };
        }
        // Identity survived the wait, so this is still the source's pinned
        // account. Keeping it is what stops a denied endpoint from driving a
        // second refresh on the next sibling request.
        state.credential = credential.credential;
        if (prepared.kind !== "allow") {
          state.requests -= 1;
          return { kind: "denied", scope: "policy", meta: EMPTY_METADATA };
        }
        // The refresh spent real time out of the same source deadline.
        if (now() >= deadlineAt) {
          state.requests -= 1;
          return { kind: "budget-exhausted", limit: "deadline" };
        }
      }

      const outcome = await performRead(
        context,
        { url, credential: state.credential, schema },
        signal,
      );
      if (outcome.kind === "ok") {
        // Remember which permission this retained result was read under, so the
        // release fence can re-check every one of them.
        state.retainedByPermission.set(decision.permission ?? url, url);
      }
      return outcome;
    },
  };
}

/** `null` means the collected payload may be released. */
async function releaseIsAuthorized(
  request: MorningBriefReaderRequest,
  state: ReaderState,
  bounded: AbortSignal,
): Promise<MorningBriefSourceUnavailable | null> {
  const pinned = state.credential?.pinned ?? null;
  const identity = await authorizeIdentity(request, pinned, "release", bounded);
  if (identity.kind !== "allow") {
    return identity.reason;
  }
  for (const url of state.retainedByPermission.values()) {
    const decision = await authorizeUrl(
      request,
      pinned,
      url,
      "release",
      bounded,
    );
    if (decision.kind === "revoked") {
      return decision.reason;
    }
    if (decision.kind !== "allow") {
      // A permission that produced retained content is no longer effective.
      return "source-revoked";
    }
  }
  return null;
}

/**
 * Run `collect` against an authorized, bounded reader for one source.
 *
 * The caller supplies the source's single absolute deadline, already started
 * before the real source admission, and this reader spends what is left of it
 * rather than starting a second one. It covers the reader's own identity
 * admission, the membership and credential reads, every provider request and
 * body, and the release fence. The final payload is fenced against every
 * permission it was actually read under, not only the last one, so losing an
 * earlier permission withholds the data that permission produced. In-flight
 * provider work cannot be retracted; this promises admission and release
 * fencing, not instantaneous revocation.
 */
export async function withMorningBriefConnectorReader<T>(
  args: {
    readonly scope: MorningBriefCollectionScope;
    readonly connectorSlug: ConnectorSlug;
    readonly apiBase: string;
    readonly environmentName: string;
    readonly budget: MorningBriefReaderBudget;
    readonly deadline: MorningBriefSourceDeadline;
    readonly db: Db;
    readonly clerk: ClerkClient;
    /** The frozen account choice, and where this read's proof is recorded. */
    readonly authority: MorningBriefSourceAuthorityLedger;
  },
  collect: (reader: MorningBriefConnectorReader) => Promise<T>,
  signal: AbortSignal,
): Promise<MorningBriefAccessResult<T>> {
  const request: MorningBriefReaderRequest = {
    ...args,
    selection: args.authority.selection,
  };
  const deadlineAt = args.deadline.at;
  const deadline = args.deadline.signal;
  const bounded = AbortSignal.any([signal, deadline]);
  const state: ReaderState = {
    requests: 0,
    reservedBytes: 0,
    revoked: null,
    truncatedTotalBytes: false,
    retainedByPermission: new Map(),
    credential: null,
  };
  const context: ReaderContext = {
    request,
    state,
    deadlineAt,
    bounded,
    deadline,
  };

  // The budget the source admission already spent is not refunded here. A
  // preflight that outlived the deadline leaves nothing to read with, so the
  // source is refused before any identity, credential or provider work rather
  // than restarting on a fresh allowance.
  if (deadlineHasPassed(args.deadline.at, args.deadline.signal)) {
    return unavailable("deadline-exceeded");
  }

  // Identity admission only. No endpoint is authorized here, and no credential
  // is decrypted: the first allowed GET resolves it.
  const admission = await settle(
    authorizeIdentity(request, null, "admission", bounded),
    signal,
  );
  if (!admission.ok) {
    return unavailable(
      deadline.aborted ? "deadline-exceeded" : "provider-failed",
    );
  }
  if (admission.value.kind !== "allow") {
    return unavailable(admission.value.reason);
  }

  const collected = await settle(
    collect(createConnectorReader(context, signal)),
    signal,
  );
  if (!collected.ok) {
    return unavailable(
      deadline.aborted ? "deadline-exceeded" : "provider-failed",
    );
  }
  if (state.revoked !== null) {
    return unavailable(state.revoked);
  }
  if (deadlineHasPassed(args.deadline.at, args.deadline.signal)) {
    return unavailable("deadline-exceeded");
  }

  const release = await settle(
    releaseIsAuthorized(request, state, bounded),
    signal,
  );
  if (!release.ok) {
    return unavailable(
      deadline.aborted ? "deadline-exceeded" : "provider-failed",
    );
  }
  if (release.value !== null) {
    return unavailable(release.value);
  }
  // The release fence re-derives identity and every retained permission, which
  // takes real time and can outlast the budget. A payload handed back after the
  // source's absolute deadline is late content, so acceptance is the last thing
  // the clock guards rather than the one step it is trusted to have covered.
  if (deadlineHasPassed(args.deadline.at, args.deadline.signal)) {
    return unavailable("deadline-exceeded");
  }
  // Released, so this source now holds material a later phase has to be able to
  // re-ask about. The proof records the exact account and the real permissions
  // and endpoints the release fence just re-evaluated, which is what makes the
  // same check repeatable rather than a remembered allow.
  if (state.credential !== null) {
    args.authority.proof = {
      connectionId: state.credential.pinned.connectorId,
      accountRef:
        state.credential.pinned.externalEmail ??
        state.credential.pinned.externalId,
      permissions: [...state.retainedByPermission.keys()].sort(),
      endpoints: [...state.retainedByPermission.values()],
    };
  }
  return {
    kind: "ok",
    value: collected.value,
    requests: state.requests,
    truncatedTotalBytes: state.truncatedTotalBytes,
  };
}

/**
 * Re-run this source's existing live checks against a retained descriptor.
 *
 * It is the same authorizer the read went through — the member's current
 * membership generation, canonical ownership, Agent visibility, the frozen
 * account's selection and liveness, the Agent's grants, catalog visibility and
 * the effective URL policy for every endpoint whose result is still held. No
 * credential is decrypted and no provider request is issued: asking whether an
 * input may still be used is a permission question, not a reason to fetch it
 * again.
 *
 * `null` means the retained material may still be used.
 */
export async function revalidateMorningBriefRetainedRead(
  args: {
    readonly db: Db;
    readonly clerk: ClerkClient;
    readonly scope: MorningBriefCollectionScope;
    readonly connectorSlug: ConnectorSlug;
    /** The connection the retained material was read through. */
    readonly connectionId: string;
    /** Every endpoint whose result is still held. */
    readonly endpoints: readonly string[];
  },
  signal: AbortSignal,
): Promise<MorningBriefSourceUnavailable | null> {
  const request: MorningBriefAuthorizationRequest = {
    db: args.db,
    clerk: args.clerk,
    scope: args.scope,
    connectorSlug: args.connectorSlug,
    selection: { kind: "selected", connectorId: args.connectionId },
  };
  const pinned: PinnedAccount = {
    connectorId: args.connectionId,
    externalEmail: null,
    externalId: null,
  };
  const identity = await authorizeIdentity(request, pinned, "release", signal);
  if (identity.kind !== "allow") {
    return identity.reason;
  }
  for (const url of args.endpoints) {
    const decision = await authorizeUrl(
      request,
      pinned,
      url,
      "release",
      signal,
    );
    if (decision.kind === "revoked") {
      return decision.reason;
    }
    if (decision.kind !== "allow") {
      // A permission that produced retained material is no longer effective.
      return "source-revoked";
    }
  }
  return null;
}

/**
 * The preview entrypoint's gate: the implementation switch, a canonical,
 * installed and enabled Morning Brief the authenticated member actually owns,
 * and that member's current Clerk membership generation.
 */
type MorningBriefCollectionAdmission =
  | { readonly kind: "ok"; readonly scope: MorningBriefCollectionScope }
  | {
      readonly kind: "denied";
      readonly reason:
        | "feature-disabled"
        | "not-installed"
        | "disabled"
        | "no-membership";
    }
  /**
   * The source's own budget ran out inside this preflight. It is not a refusal
   * of authority and not a cancellation: the caller asked for a source that can
   * no longer be read in time.
   */
  | { readonly kind: "unavailable"; readonly reason: "deadline-exceeded" };

interface MorningBriefAdmissionArgs {
  readonly db: Db;
  readonly clerk: ClerkClient;
  readonly orgId: string;
  readonly userId: string;
  readonly anchor: Date;
  /**
   * The source deadline, started by this caller before admission. Composing it
   * here is what lets the preflight observe the source timeout its own reads
   * are spending, instead of only the caller's cancellation.
   */
  readonly deadline: MorningBriefSourceDeadline;
}

export async function admitMorningBriefCollection(
  args: MorningBriefAdmissionArgs,
  signal: AbortSignal,
): Promise<MorningBriefCollectionAdmission> {
  // Both boundaries reach every await below. The provider SDK is not claimed to
  // cancel a request already issued; what this guarantees is that a held answer
  // or failure released after the budget expired stops here, with no retry, no
  // further admission read and no collection.
  const bounded = AbortSignal.any([signal, args.deadline.signal]);
  const admitted = await settle(admitWithinDeadline(args, bounded), signal);
  if (admitted.ok) {
    return admitted.value;
  }
  if (deadlineHasPassed(args.deadline.at, args.deadline.signal)) {
    return { kind: "unavailable", reason: "deadline-exceeded" };
  }
  // A genuine preflight failure stays a failure; it is not relabelled as a
  // refusal this member could act on.
  throw admitted.error;
}

async function admitWithinDeadline(
  args: MorningBriefAdmissionArgs,
  signal: AbortSignal,
): Promise<MorningBriefCollectionAdmission> {
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    args.db,
    args.orgId,
    args.userId,
  );
  signal.throwIfAborted();
  if (
    !isFeatureEnabled(FeatureSwitchKey.SimpleMorningBrief, featureSwitchContext)
  ) {
    return { kind: "denied", reason: "feature-disabled" };
  }
  const state = await loadMorningBriefMigrationState(args.db, {
    orgId: args.orgId,
    userId: args.userId,
  });
  signal.throwIfAborted();
  if (state.kind !== "installed") {
    return { kind: "denied", reason: "not-installed" };
  }
  if (!state.automation.enabled) {
    return { kind: "denied", reason: "disabled" };
  }
  const membershipId = await loadCurrentMembershipId(
    args.clerk,
    { orgId: args.orgId, userId: args.userId },
    signal,
  );
  signal.throwIfAborted();
  if (membershipId === null) {
    return { kind: "denied", reason: "no-membership" };
  }
  if (!(await subjectIsWritable(args.db, args))) {
    return { kind: "denied", reason: "no-membership" };
  }
  if (deadlineHasPassed(args.deadline.at, args.deadline.signal)) {
    return { kind: "unavailable", reason: "deadline-exceeded" };
  }
  return {
    kind: "ok",
    scope: {
      orgId: args.orgId,
      userId: args.userId,
      installationId: state.installation.id,
      agentId: state.installation.agentId,
      chatThreadId: state.chatThreadId,
      anchor: args.anchor,
      timezone: state.automation.timezone,
      membershipId,
    },
  };
}
