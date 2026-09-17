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
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { and, eq, or } from "drizzle-orm";
import type { z } from "zod";

import { logger } from "../../lib/log";
import type { Db, ReadonlyDb } from "../external/db";
import { readBoundedResponseText, safeJsonParse, settle } from "../utils";
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
import { loadMorningBriefMigrationState } from "./morning-brief-migration-state.service";
import { resolveActiveNetworkPolicyRefreshes } from "./user-permission-grants.service";
import { resolveWorkflowAutomationConnectorId } from "./workflow-automation-account.service";

/**
 * The shared authorization boundary every Simple Morning Brief OAuth source
 * reads through.
 *
 * A collector never holds a credential, never builds its own request and never
 * decides whether it may read. It receives a `MorningBriefConnectorReader` that
 * re-derives live authority — canonical ownership, membership and erasure
 * admission, the pinned connector account, the Agent's grants, accepted catalog
 * visibility and effective URL policy — before credential access, before every
 * request, and again before the collected payload is released.
 *
 * Holding a credential is not permission. Every gate must produce an
 * unambiguous `allow`; missing metadata, no route match, `deny`, `ask` and
 * expired grants are all refusals.
 *
 * The contract, its caps and its explicit limits are documented in
 * [Morning Brief source collection](../../../../../../docs/morning-brief-gmail-collection.md).
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
}

interface MorningBriefReaderBudget {
  /** Every attempted request counts, including the ones that fail. */
  readonly maxRequests: number;
  readonly maxResponseBytes: number;
  readonly maxTotalResponseBytes: number;
  readonly deadlineMs: number;
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
 * One bounded GET. `denied` is endpoint-specific and leaves a coverage gap;
 * `revoked` discards the entire source through the wrapper's latch.
 */
export type MorningBriefReadOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "not-found" }
  | { readonly kind: "denied" }
  | {
      readonly kind: "rate-limited";
      readonly retryAfterMs: number | null;
    }
  | { readonly kind: "too-large" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "budget-exhausted";
      readonly limit: MorningBriefReaderLimit;
    }
  | { readonly kind: "provider-failed" }
  | { readonly kind: "revoked" };

export type MorningBriefReaderLimit =
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
  /** The account this source is pinned to, for safe provider deep links. */
  readonly accountEmail: string | null;
}

interface MorningBriefReaderRequest {
  readonly scope: MorningBriefCollectionScope;
  readonly connectorSlug: ConnectorSlug;
  readonly apiBase: string;
  readonly environmentName: string;
  readonly budget: MorningBriefReaderBudget;
  readonly db: Db;
  readonly signal: AbortSignal;
}

/** The exact account this source is pinned to for its whole lifetime. */
interface PinnedAccount {
  readonly connectorId: string;
  readonly externalEmail: string | null;
}

type AuthorizationOutcome =
  | { readonly kind: "allow" }
  | { readonly kind: "denied" }
  | {
      readonly kind: "revoked";
      readonly reason: MorningBriefSourceUnavailable;
    };

function unavailable<T>(
  reason: MorningBriefSourceUnavailable,
): MorningBriefAccessResult<T> {
  return { kind: "unavailable", reason };
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

/**
 * Membership and erasure admission in one short transaction.
 *
 * Admission takes the subject locks before any other row and holds them through
 * commit, so a closure committed while this waited is visible here. The
 * transaction deliberately contains no network call.
 */
async function memberIsAdmitted(
  db: Db,
  scope: MorningBriefCollectionScope,
): Promise<boolean> {
  const settled = await settle(
    db.transaction(async (tx) => {
      await assertErasureSubjectWritable(tx, [
        { subjectKind: "organization", subjectId: scope.orgId },
        { subjectKind: "user", subjectId: scope.userId },
      ]);
      const [member] = await tx
        .select({ orgId: orgMembersCache.orgId })
        .from(orgMembersCache)
        .where(
          and(
            eq(orgMembersCache.orgId, scope.orgId),
            eq(orgMembersCache.userId, scope.userId),
          ),
        )
        .limit(1);
      return member !== undefined;
    }),
  );
  // A closed subject aborts the transaction; that is a refusal, not an outage.
  return settled.ok && settled.value;
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
 * The pinned account must still be this owner's live account for this source.
 *
 * A deleted account or one the owner has been asked to reconnect withdraws the
 * access this read was admitted under, even though its ID has not changed.
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

/**
 * The effective, current URL-level decision for this exact request.
 *
 * Routing metadata comes from the accepted catalog and the policy from the
 * Agent's active grants, so an expired or revoked grant collapses to the
 * connector's default policy rather than to a stale allow.
 */
async function requestIsAllowed(args: {
  readonly db: ReadonlyDb;
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly scope: MorningBriefCollectionScope;
  readonly connectorSlug: ConnectorSlug;
  readonly url: string;
}): Promise<boolean> {
  const view = await loadConnectorDiagnosticCatalogView(
    args.snapshot.serverFirewalls,
    args.connectorSlug,
  );
  if (!view) {
    return false;
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
  const target = {
    kind: "builtin" as const,
    connectorSlug: args.connectorSlug,
  };
  const policies: NetworkPolicies = Object.fromEntries(
    refreshes.map((refresh) => {
      return [
        connectorRuntimeTargetKey({
          kind: "builtin",
          connectorSlug: refresh.connectorSlug,
        }),
        refresh.networkPolicy,
      ];
    }),
  );
  const decision = matchFirewallRequestDecision(
    [
      {
        name: connectorRuntimeTargetKey(target),
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
    { status: "present", value: connectorRuntimeTargetKey(target) },
  );
  // Only an unambiguous allow passes. `no_match`, every block reason and an
  // ambiguous route are refusals.
  return decision.kind === "allow";
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
 * Every live gate, in the order that keeps a credential behind authority.
 *
 * `url` is absent for the admission run that precedes credential access, and
 * present for each request. An endpoint-specific policy refusal is `denied`;
 * everything that invalidates the source itself is `revoked`.
 */
async function authorize(
  request: MorningBriefReaderRequest,
  pinned: PinnedAccount | null,
  url: string | null,
): Promise<AuthorizationOutcome> {
  const { db, scope, connectorSlug } = request;
  if (!(await memberIsAdmitted(db, scope))) {
    return { kind: "revoked", reason: "source-revoked" };
  }
  request.signal.throwIfAborted();
  if (!(await ownershipIsUnchanged(db, scope))) {
    return { kind: "revoked", reason: "source-revoked" };
  }
  request.signal.throwIfAborted();
  if (!(await agentIsVisible(db, scope))) {
    return { kind: "revoked", reason: "source-revoked" };
  }
  request.signal.throwIfAborted();

  const selectedConnectorId = await resolveSelectedConnectorId(
    db,
    scope,
    connectorSlug,
  );
  if (selectedConnectorId === null) {
    return { kind: "revoked", reason: "not-connected" };
  }
  if (pinned && pinned.connectorId !== selectedConnectorId) {
    // The owner chose a different account while this source was reading. The
    // payload gathered from the previous account may not be released.
    return { kind: "revoked", reason: "source-revoked" };
  }
  if (
    pinned &&
    !(await pinnedAccountIsLive(db, scope, pinned, connectorSlug))
  ) {
    return { kind: "revoked", reason: "reconnect-required" };
  }
  request.signal.throwIfAborted();

  const scopeGrants = await loadAgentConnectorScope(db, {
    orgId: scope.orgId,
    userId: scope.userId,
    agentId: scope.agentId,
  });
  if (!scopeGrants.allowedConnectorSlugs.includes(connectorSlug)) {
    return { kind: "revoked", reason: "not-authorized" };
  }
  request.signal.throwIfAborted();

  const snapshot = await loadConnectorRuntimeSnapshot(db);
  request.signal.throwIfAborted();
  if (!(await connectorIsVisible(db, snapshot, scope, connectorSlug))) {
    return { kind: "revoked", reason: "not-authorized" };
  }
  request.signal.throwIfAborted();

  if (url === null) {
    return { kind: "allow" };
  }
  const allowed = await requestIsAllowed({
    db,
    snapshot,
    scope,
    connectorSlug,
    url,
  });
  return allowed ? { kind: "allow" } : { kind: "denied" };
}

type CredentialResult =
  | {
      readonly kind: "ok";
      readonly accessToken: string;
      readonly pinned: PinnedAccount;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: MorningBriefSourceUnavailable;
    };

/**
 * Load the pinned account's credential, refreshing it when it is expiring.
 *
 * A refresh this reader performs legitimately advances the account's own
 * credential revision, so the pin is taken after the refresh. A revision that
 * moves for any other reason is detected as a selection change on the next
 * authorization.
 */
async function loadCredential(
  request: MorningBriefReaderRequest,
  connectorId: string,
): Promise<CredentialResult> {
  const { db, scope, connectorSlug, signal } = request;
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
  };
  if (!credentialNeedsRefresh(connection.tokenExpiresAt)) {
    return { kind: "ok", accessToken: storedToken, pinned };
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
  return { kind: "ok", accessToken: refreshed.accessToken, pinned };
}

const CREDENTIAL_REFRESH_BUFFER_MS = 60_000;

function credentialNeedsRefresh(tokenExpiresAt: Date | null): boolean {
  return (
    tokenExpiresAt !== null &&
    tokenExpiresAt.getTime() <= Date.now() + CREDENTIAL_REFRESH_BUFFER_MS
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

interface ReaderState {
  requests: number;
  totalBytes: number;
  revoked: MorningBriefSourceUnavailable | null;
  truncatedTotalBytes: boolean;
}

function budgetLimit(
  state: ReaderState,
  request: MorningBriefReaderRequest,
  deadlineAt: number,
): MorningBriefReaderLimit | null {
  if (state.requests >= request.budget.maxRequests) {
    return "total-requests";
  }
  if (Date.now() >= deadlineAt) {
    return "deadline";
  }
  if (state.totalBytes >= request.budget.maxTotalResponseBytes) {
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

/**
 * The bounded reader closure handed to one collector.
 *
 * Extracted only to keep `withMorningBriefConnectorReader` inside the
 * repository's function-size limit; every gate, budget and outcome is
 * unchanged.
 */
function createSourceReader(args: {
  readonly request: MorningBriefReaderRequest;
  readonly state: ReaderState;
  readonly pinned: PinnedAccount;
  readonly accessToken: string;
  readonly deadlineAt: number;
}): MorningBriefConnectorReader {
  const { request, state, pinned, deadlineAt } = args;
  const credential = { accessToken: args.accessToken };
  return {
    accountEmail: pinned.externalEmail,
    async getJson({ pathname, query, schema }) {
      if (state.revoked !== null) {
        return { kind: "revoked" };
      }
      const limit = budgetLimit(state, request, deadlineAt);
      if (limit !== null) {
        return { kind: "budget-exhausted", limit };
      }
      const url = readerUrl(request, pathname, query);
      const decision = await authorize(request, pinned, url);
      if (decision.kind === "revoked") {
        state.revoked = decision.reason;
        return { kind: "revoked" };
      }
      if (decision.kind === "denied") {
        return { kind: "denied" };
      }
      // A revocation observed while this request waited for authorization must
      // stop it, even though the gate itself passed.
      if (state.revoked !== null) {
        return { kind: "revoked" };
      }
      request.signal.throwIfAborted();

      // Every attempt is charged, so a failing provider cannot buy retries.
      state.requests += 1;
      const settled = await settle(
        fetch(url, {
          method: "GET",
          // A redirect would carry this credential to an unauthorized host.
          redirect: "error",
          signal: request.signal,
          headers: {
            Authorization: `Bearer ${credential.accessToken}`,
            Accept: "application/json",
          },
        }),
        request.signal,
      );
      if (!settled.ok) {
        return { kind: "provider-failed" };
      }
      const response = settled.value;
      if (response.status === 404) {
        void response.body?.cancel();
        return { kind: "not-found" };
      }
      if (response.status === 429) {
        const retryAfter = retryAfterMs(response);
        void response.body?.cancel();
        return { kind: "rate-limited", retryAfterMs: retryAfter };
      }
      if (!response.ok) {
        void response.body?.cancel();
        // 401 and 403 mean this credential lost the access it was granted;
        // never a healthy empty read.
        if (response.status === 401 || response.status === 403) {
          state.revoked = "reconnect-required";
          return { kind: "revoked" };
        }
        return { kind: "provider-failed" };
      }

      const body = await readBoundedResponseText(
        response,
        Math.min(
          request.budget.maxResponseBytes,
          Math.max(0, request.budget.maxTotalResponseBytes - state.totalBytes),
        ),
      );
      request.signal.throwIfAborted();
      if (body.kind === "too_large") {
        state.truncatedTotalBytes = true;
        return { kind: "too-large" };
      }
      state.totalBytes += Buffer.byteLength(body.text, "utf8");
      const parsed = schema.safeParse(safeJsonParse(body.text));
      if (!parsed.success) {
        // Provider payloads never reach a log; only the shape failed.
        L.warn("Morning Brief source returned an unusable payload", {
          connectorSlug: request.connectorSlug,
          orgId: request.scope.orgId,
        });
        return { kind: "malformed" };
      }
      return { kind: "ok", value: parsed.data };
    },
  };
}

/**
 * Run `collect` against an authorized, bounded reader for one source.
 *
 * The final payload is fenced: the same authority is re-derived after `collect`
 * returns, so work that was already in flight when access was withdrawn is
 * discarded rather than released. In-flight provider work cannot be retracted;
 * this promises admission and release fencing, not instantaneous revocation.
 */
export async function withMorningBriefConnectorReader<T>(
  args: {
    readonly scope: MorningBriefCollectionScope;
    readonly connectorSlug: ConnectorSlug;
    readonly apiBase: string;
    readonly environmentName: string;
    readonly budget: MorningBriefReaderBudget;
    readonly db: Db;
    readonly signal: AbortSignal;
  },
  collect: (reader: MorningBriefConnectorReader) => Promise<T>,
): Promise<MorningBriefAccessResult<T>> {
  const request: MorningBriefReaderRequest = args;
  const deadlineAt = Date.now() + args.budget.deadlineMs;
  const state: ReaderState = {
    requests: 0,
    totalBytes: 0,
    revoked: null,
    truncatedTotalBytes: false,
  };

  // Authorize before any credential is decrypted or refreshed.
  const admission = await authorize(request, null, null);
  if (admission.kind !== "allow") {
    return unavailable(
      admission.kind === "revoked" ? admission.reason : "not-authorized",
    );
  }
  args.signal.throwIfAborted();

  const selectedConnectorId = await resolveSelectedConnectorId(
    args.db,
    args.scope,
    args.connectorSlug,
  );
  if (selectedConnectorId === null) {
    return unavailable("not-connected");
  }
  const credential = await loadCredential(request, selectedConnectorId);
  if (credential.kind === "unavailable") {
    return unavailable(credential.reason);
  }
  args.signal.throwIfAborted();
  const pinned = credential.pinned;

  const reader = createSourceReader({
    request,
    state,
    pinned,
    accessToken: credential.accessToken,
    deadlineAt,
  });

  const value = await collect(reader);
  args.signal.throwIfAborted();
  if (state.revoked !== null) {
    return unavailable(state.revoked);
  }
  // Release fence: the payload only leaves this wrapper while the same
  // authority that admitted the read is still current.
  const release = await authorize(request, pinned, null);
  if (release.kind !== "allow") {
    return unavailable(
      release.kind === "revoked" ? release.reason : "not-authorized",
    );
  }
  return {
    kind: "ok",
    value,
    requests: state.requests,
    truncatedTotalBytes: state.truncatedTotalBytes,
  };
}

/**
 * The preview entrypoint's gate: the implementation switch plus a canonical,
 * installed and enabled Morning Brief the authenticated member actually owns.
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
    };

export async function admitMorningBriefCollection(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly anchor: Date;
  },
): Promise<MorningBriefCollectionAdmission> {
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    args.orgId,
    args.userId,
  );
  if (
    !isFeatureEnabled(FeatureSwitchKey.SimpleMorningBrief, featureSwitchContext)
  ) {
    return { kind: "denied", reason: "feature-disabled" };
  }
  const state = await loadMorningBriefMigrationState(db, {
    orgId: args.orgId,
    userId: args.userId,
  });
  if (state.kind !== "installed") {
    return { kind: "denied", reason: "not-installed" };
  }
  if (!state.automation.enabled) {
    return { kind: "denied", reason: "disabled" };
  }
  const scope: MorningBriefCollectionScope = {
    orgId: args.orgId,
    userId: args.userId,
    installationId: state.installation.id,
    agentId: state.installation.agentId,
    chatThreadId: state.chatThreadId,
    anchor: args.anchor,
    timezone: state.automation.timezone,
  };
  if (!(await memberIsAdmitted(db, scope))) {
    return { kind: "denied", reason: "no-membership" };
  }
  return { kind: "ok", scope };
}
