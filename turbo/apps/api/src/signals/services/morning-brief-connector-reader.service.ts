import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { connectorRuntimeTargetKey } from "@okouai/api-contracts/contracts/runners";
import {
  getAllFeatureStates,
  isFeatureEnabled,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isValidTimeZone } from "@okouai/core/timezone";
import { matchFirewallRequestDecision } from "@okouai/connectors/firewall-rule-matcher";
import { agents } from "@okouai/db/schema/agent";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import { nowDate } from "../../lib/time";
import { clerk$ } from "../external/clerk";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
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
  type ConnectorCredentialConnection,
} from "./connector-credential-runtime.service";
import {
  buildConnectorDiagnosticBaseCandidates,
  loadConnectorDiagnosticCatalogView,
} from "./connector-diagnostic-runtime.service";
import { loadAgentConnectorScope } from "./agent-connector-scope.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { loadMorningBriefMigrationState } from "./morning-brief-migration-state.service";
import { loadOfficialWorkflowUserTimezone } from "./official-workflow-installation.service";
import { resolveWorkflowAutomationConnectorId } from "./workflow-automation-account.service";
import { resolveActiveNetworkPolicyRefreshes } from "./user-permission-grants.service";

/**
 * The live authorization boundary every Morning Brief connector read goes
 * through.
 *
 * Direct API collection does not inherit the Runner firewall, so this composes
 * the platform's existing authorities itself rather than inventing a second
 * permission algorithm: canonical Morning Brief ownership, live Clerk
 * membership, the installation's Agent and its connector grants, the accepted
 * catalog's routing metadata, the member's active permission grants, and the
 * exact connector account the destination thread selected. The only decision
 * function is the shared firewall rule matcher.
 *
 * Shared-reader ownership belongs to
 * [#34809](https://github.com/vm0-ai/okou/issues/34809). Its Gmail slice and
 * this GitHub slice were implemented concurrently against the same published
 * semantics; whichever lands on `main` first is canonical and the later one
 * converges onto it. See
 * [the GitHub collection contract](../../../../../../docs/morning-brief-github-collection.md).
 */

/** Frozen identity a collection runs under. Never caller-supplied. */
export interface MorningBriefCollectionScope {
  readonly orgId: string;
  readonly userId: string;
  /** The canonical Morning Brief installation (workflow) id. */
  readonly installationId: string;
  readonly automationId: string;
  /** The Agent the installation pinned, revalidated as still usable. */
  readonly agentId: string;
  /** The canonical workflow/user thread, absent before the first delivery. */
  readonly chatThreadId: string | null;
  /** Clerk's immutable membership id; a rejoin issues a new one. */
  readonly membershipId: string;
  readonly timezone: string;
}

/** Why a collection never reached the provider. */
export type MorningBriefScopeDenial =
  | "feature-disabled"
  | "brief-absent"
  | "brief-pending"
  | "brief-inconsistent"
  | "brief-paused"
  | "missing-timezone"
  | "missing-agent"
  | "membership-revoked";

type MorningBriefScopeResult =
  | { readonly kind: "admitted"; readonly scope: MorningBriefCollectionScope }
  | { readonly kind: "denied"; readonly reason: MorningBriefScopeDenial };

/** Why an admitted scope still cannot read one connector. */
export type MorningBriefAccessDenial =
  | "connector-not-visible"
  | "connector-not-granted"
  | "account-missing"
  | "account-unavailable"
  | "account-needs-reconnect"
  | "endpoint-not-authorized";

interface MorningBriefReaderBudget {
  /** Attempted requests, including denials and failures. */
  readonly maxRequests: number;
  /** Cap per response body, enforced while streaming. */
  readonly maxResponseBytes: number;
  /** Cumulative streamed bytes across the whole source. */
  readonly maxTotalResponseBytes: number;
  /** Absolute wall-clock deadline, as an epoch millisecond instant. */
  readonly deadlineAt: number;
  /** Runtime environment names that may carry this connector's token. */
  readonly tokenEnvironmentNames: readonly string[];
}

/** Bounded response headers a provider module may look at. */
export interface MorningBriefResponseHeaders {
  readonly retryAfterSeconds?: number;
  readonly link?: string;
}

export type MorningBriefReadResult<T> =
  /** Parsed payload. `bytes` is what this response actually streamed. */
  | {
      readonly kind: "ok";
      readonly data: T;
      readonly headers: MorningBriefResponseHeaders;
      readonly bytes: number;
    }
  /** Current policy refuses this exact endpoint: a branch coverage gap. */
  | { readonly kind: "denied" }
  /** The provider refused: 401/403/404 are distinct from a policy denial. */
  | { readonly kind: "forbidden" }
  | { readonly kind: "not-found" }
  | {
      readonly kind: "rate-limited";
      readonly retryAfterSeconds?: number;
    }
  | { readonly kind: "oversized" }
  | { readonly kind: "malformed" }
  | { readonly kind: "failed" }
  /** A documented budget stopped this request before it was attempted. */
  | { readonly kind: "budget-exhausted" }
  /** The owner's authority moved: the whole source must be discarded. */
  | { readonly kind: "revoked" };

export interface MorningBriefConnectorReader {
  /** One authorized fixed-host GET. Paths and query come from the caller. */
  getJson<T>(request: {
    readonly pathname: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly schema: z.ZodType<T>;
    readonly signal: AbortSignal;
  }): Promise<MorningBriefReadResult<T>>;
  /** Attempted requests so far, so a collector can report its own budget. */
  readonly attempted: () => number;
  /** Cumulative streamed response bytes. */
  readonly streamedBytes: () => number;
}

/**
 * Whether the collector's result may be released.
 *
 * The collector writes its own bundle; this says whether the authority that
 * produced it is still the authority that was admitted. Anything other than
 * `collected` means the caller must discard what it captured.
 */
type MorningBriefAccessResult =
  | { readonly kind: "collected" }
  | { readonly kind: "denied"; readonly reason: MorningBriefAccessDenial }
  | { readonly kind: "revoked" };

/** Refresh a token this far ahead of its expiry, when it has one. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * The Agent the canonical installation pinned, when it is still usable.
 *
 * A deleted Agent, or a private Agent owned by somebody else, is a missing
 * Agent. It is never a reason to substitute the org default.
 */
async function loadInstallationAgentId(
  db: Pick<ReadonlyDb, "select">,
  scope: { readonly orgId: string; readonly userId: string },
  agentId: string,
): Promise<string | null> {
  const [agent] = await db
    .select({
      id: agents.id,
      owner: agents.owner,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, scope.orgId)))
    .limit(1);
  if (
    !agent ||
    (agent.visibility === "private" && agent.owner !== scope.userId)
  ) {
    return null;
  }
  return agent.id;
}

/**
 * The member's current Clerk membership generation.
 *
 * Request authentication may answer from the short-lived role cache, so
 * admission repeats the exact-member lookup and pins the immutable membership
 * id. Removing the member — including as part of account erasure — makes this
 * null, and a rejoin issues a different id.
 */
const currentMembershipId$ = command(
  async (
    { get },
    scope: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const memberships = await get(
      clerk$,
    ).organizations.getOrganizationMembershipList(
      { organizationId: scope.orgId, userId: [scope.userId], limit: 1 },
      undefined,
      signal,
    );
    signal.throwIfAborted();
    const membership = memberships.data.find((entry) => {
      return (
        entry.publicUserData?.userId === scope.userId &&
        entry.organization.id === scope.orgId
      );
    });
    return membership?.id ?? null;
  },
);

/**
 * Resolve the frozen collection identity from live canonical state only.
 *
 * Nothing here reads the disposable installed-preference projection, and
 * nothing is taken from the request body beyond the anchor the caller passes
 * separately. Each failure is an explicit non-executing reason returned before
 * any provider work exists.
 */
export const admitMorningBriefCollectionScope$ = command(
  async (
    { set },
    owner: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<MorningBriefScopeResult> => {
    const db = set(writeDb$);
    const featureSwitchContext = await loadUserFeatureSwitchContext(
      db,
      owner.orgId,
      owner.userId,
    );
    signal.throwIfAborted();
    if (
      !isFeatureEnabled(
        FeatureSwitchKey.SimpleMorningBrief,
        featureSwitchContext,
      )
    ) {
      return { kind: "denied", reason: "feature-disabled" };
    }

    const state = await loadMorningBriefMigrationState(db, owner);
    signal.throwIfAborted();
    if (state.kind !== "installed") {
      return {
        kind: "denied",
        reason:
          state.kind === "absent"
            ? "brief-absent"
            : state.kind === "pending"
              ? "brief-pending"
              : "brief-inconsistent",
      };
    }
    if (!state.automation.enabled) {
      return { kind: "denied", reason: "brief-paused" };
    }

    const timezone = await loadOfficialWorkflowUserTimezone(db, owner);
    signal.throwIfAborted();
    if (timezone === null || !isValidTimeZone(timezone)) {
      return { kind: "denied", reason: "missing-timezone" };
    }

    const agentId = await loadInstallationAgentId(
      db,
      owner,
      state.installation.agentId,
    );
    signal.throwIfAborted();
    if (agentId === null) {
      return { kind: "denied", reason: "missing-agent" };
    }

    const membershipId = await set(currentMembershipId$, owner, signal);
    signal.throwIfAborted();
    if (membershipId === null) {
      return { kind: "denied", reason: "membership-revoked" };
    }

    return {
      kind: "admitted",
      scope: {
        orgId: owner.orgId,
        userId: owner.userId,
        installationId: state.installation.id,
        automationId: state.automation.id,
        agentId,
        chatThreadId: state.chatThreadId,
        membershipId,
        timezone,
      },
    };
  },
);

/** Everything a single authorized request depends on, resolved live. */
interface MorningBriefConnectorAuthority {
  readonly scope: MorningBriefCollectionScope;
  readonly connectorId: string;
  /** Credential row revision; a reconnect or refresh changes it. */
  readonly stateRevision: string;
  readonly storageVersion: number;
}

function sameAuthority(
  left: MorningBriefConnectorAuthority,
  right: MorningBriefConnectorAuthority,
): boolean {
  return (
    left.scope.orgId === right.scope.orgId &&
    left.scope.userId === right.scope.userId &&
    left.scope.installationId === right.scope.installationId &&
    left.scope.automationId === right.scope.automationId &&
    left.scope.agentId === right.scope.agentId &&
    left.scope.membershipId === right.scope.membershipId &&
    left.scope.timezone === right.scope.timezone &&
    left.connectorId === right.connectorId &&
    left.storageVersion === right.storageVersion
  );
}

type ConnectorAccessResolution =
  | {
      readonly kind: "ok";
      readonly authority: MorningBriefConnectorAuthority;
      readonly connection: ConnectorCredentialConnection;
    }
  | { readonly kind: "denied"; readonly reason: MorningBriefAccessDenial }
  | { readonly kind: "revoked" };

/**
 * Accepted-catalog visibility, the Agent's grant and the exact account.
 *
 * Holding a connector is not authorization: the connector must be visible in
 * the accepted catalog for this member, granted to the installation's Agent,
 * and resolved to the account the canonical thread actually selected. An
 * explicit selection that no longer names a usable account fails closed; only
 * the absence of a selection may use the member's default account.
 */
async function resolveConnectorAccess(
  db: Db,
  scope: MorningBriefCollectionScope,
  connectorSlug: ConnectorSlug,
  snapshot: ConnectorRuntimeSnapshot,
  signal: AbortSignal,
): Promise<ConnectorAccessResolution> {
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    scope.orgId,
    scope.userId,
  );
  signal.throwIfAborted();
  const visibleSlugs = listConnectorRuntimeVisibleSlugs({
    snapshot,
    featureStates: getAllFeatureStates(featureSwitchContext),
  });
  if (
    !visibleSlugs.includes(connectorSlug) ||
    !snapshot.serverFirewalls.has(connectorSlug)
  ) {
    return { kind: "denied", reason: "connector-not-visible" };
  }

  const agentScope = await loadAgentConnectorScope(db, {
    orgId: scope.orgId,
    userId: scope.userId,
    agentId: scope.agentId,
  });
  signal.throwIfAborted();
  if (!agentScope.allowedConnectorSlugs.includes(connectorSlug)) {
    return { kind: "denied", reason: "connector-not-granted" };
  }

  const connectorId = await resolveWorkflowAutomationConnectorId(db, {
    orgId: scope.orgId,
    userId: scope.userId,
    workflowId: scope.installationId,
    connectorSlug,
  });
  signal.throwIfAborted();
  if (connectorId === null) {
    return { kind: "denied", reason: "account-missing" };
  }

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
    // An explicit selection naming a deleted or foreign account lands here.
    // Falling back to the default account would read the wrong mailbox.
    return { kind: "denied", reason: "account-missing" };
  }
  if (loaded.kind === "unavailable") {
    return { kind: "denied", reason: "account-unavailable" };
  }
  if (loaded.connection.needsReconnect) {
    return { kind: "denied", reason: "account-needs-reconnect" };
  }
  return {
    kind: "ok",
    connection: loaded.connection,
    authority: {
      scope,
      connectorId: loaded.connection.connectorId,
      stateRevision: loaded.connection.stateRevision,
      storageVersion: loaded.connection.storageVersion,
    },
  };
}

/** The accepted catalog's routing metadata, shaped for the shared matcher. */
interface DecisionFirewall {
  readonly name: string;
  readonly apis: readonly {
    readonly base: string;
    readonly auth: Record<string, never>;
    readonly permissions: readonly {
      readonly name: string;
      readonly rules: readonly string[];
    }[];
  }[];
}

/** The decision firewall for one connector, from accepted catalog metadata. */
async function loadDecisionFirewall(
  snapshot: ConnectorRuntimeSnapshot,
  connectorSlug: ConnectorSlug,
): Promise<DecisionFirewall | null> {
  const view = await loadConnectorDiagnosticCatalogView(
    snapshot.serverFirewalls,
    connectorSlug,
  );
  if (!view) {
    return null;
  }
  // Fixed provider hosts only: a base that still needs an account-supplied
  // variable is not a host this reader may call.
  const { candidates } = buildConnectorDiagnosticBaseCandidates(view, null, {
    allowStructuralDynamic: false,
  });
  if (candidates.length === 0) {
    return null;
  }
  return {
    name: connectorRuntimeTargetKey({ kind: "builtin", connectorSlug }),
    apis: candidates.map((candidate) => {
      const rulesByPermission = new Map<string, string[]>();
      for (const route of candidate.routes) {
        const rules = rulesByPermission.get(route.permissionName);
        if (rules) {
          rules.push(route.rule);
        } else {
          rulesByPermission.set(route.permissionName, [route.rule]);
        }
      }
      return {
        base: candidate.decisionBase,
        auth: {},
        permissions: [...rulesByPermission].map(([name, rules]) => {
          return { name, rules };
        }),
      };
    }),
  };
}

/** The member's active grants for this connector, expanded to a policy map. */
async function loadNetworkPolicies(
  db: Db,
  scope: MorningBriefCollectionScope,
  connectorSlug: ConnectorSlug,
  snapshot: ConnectorRuntimeSnapshot,
  firewallName: string,
): Promise<Record<string, unknown>> {
  // The grant scope is Agent-scoped on purpose: policy belongs to the exact
  // Agent the canonical installation pinned, not to the member at large.
  const refreshes = await resolveActiveNetworkPolicyRefreshes(
    db,
    {
      orgId: scope.orgId,
      userId: scope.userId,
      agentId: scope.agentId,
    },
    [connectorSlug],
    snapshot,
  );
  const refresh = refreshes.find((entry) => {
    return entry.connectorSlug === connectorSlug;
  });
  return refresh ? { [firewallName]: refresh.networkPolicy } : {};
}

/** Decode the token for the exact pinned account, refreshing only if needed. */
async function resolveAccessToken(
  db: Db,
  scope: MorningBriefCollectionScope,
  connection: ConnectorCredentialConnection,
  tokenEnvironmentNames: readonly string[],
  signal: AbortSignal,
): Promise<
  | { readonly kind: "ok"; readonly accessToken: string }
  | { readonly kind: "denied"; readonly reason: MorningBriefAccessDenial }
> {
  const resolved = tokenEnvironmentNames.flatMap((environmentName) => {
    const valueRef = connectorCredentialRuntimeValueRef(
      connection,
      environmentName,
    );
    return valueRef === null ? [] : [{ environmentName, valueRef }];
  })[0];
  if (!resolved) {
    return { kind: "denied", reason: "account-unavailable" };
  }

  const values = await loadConnectorCredentialValues({
    connection,
    db,
    valueRefs: [resolved.valueRef],
  });
  signal.throwIfAborted();
  const accessToken = values.get(resolved.valueRef);
  if (!accessToken) {
    return { kind: "denied", reason: "account-needs-reconnect" };
  }

  const expiresAt = connection.tokenExpiresAt;
  if (
    expiresAt === null ||
    expiresAt.getTime() - nowDate().getTime() > TOKEN_REFRESH_BUFFER_MS
  ) {
    return { kind: "ok", accessToken };
  }
  // A refresh may write this account's credential revision. That is a
  // legitimate write by the selected account's own reader, and the revision
  // change it produces is not treated as somebody else's reselection.
  const refreshed = await refreshConnectorCredentialAccess(
    {
      connection,
      db,
      orgId: scope.orgId,
      userId: scope.userId,
      runtimeEnvironmentName: resolved.environmentName,
      persist: { db, markNeedsReconnectOnFailure: true },
    },
    signal,
  );
  signal.throwIfAborted();
  if (refreshed.kind !== "ok") {
    return { kind: "denied", reason: "account-needs-reconnect" };
  }
  return { kind: "ok", accessToken: refreshed.accessToken };
}

function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) {
    return undefined;
  }
  const seconds = Number.parseInt(header, 10);
  // Bounded metadata for the caller. This reader never sleeps on it.
  return Number.isSafeInteger(seconds) && seconds >= 0
    ? Math.min(seconds, 3600)
    : undefined;
}

/** Stream a bounded body. Returns null once the per-response cap is passed. */
async function readCappedText(
  response: Response,
  maxBytes: number,
): Promise<{ readonly text: string; readonly bytes: number } | null> {
  if (!response.body) {
    return { text: "", bytes: 0 };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return { text: text + decoder.decode(), bytes };
    }
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * Classify a provider response that must not have its body read.
 *
 * Returns `null` when the response is a success whose bounded body may be
 * streamed. Every other status becomes its own honest outcome: a policy
 * denial, a provider refusal, a missing item, a rate limit, or a failure.
 */
async function classifyProviderResponse(
  response: Response,
): Promise<Exclude<
  MorningBriefReadResult<never>,
  { readonly kind: "ok" }
> | null> {
  const seconds = retryAfterSeconds(response);
  if (response.status === 429) {
    await response.body?.cancel();
    return {
      kind: "rate-limited",
      ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
    };
  }
  if (response.status === 403) {
    // Secondary rate limits also arrive as 403 with `Retry-After`.
    await response.body?.cancel();
    return seconds === undefined
      ? { kind: "forbidden" }
      : { kind: "rate-limited", retryAfterSeconds: seconds };
  }
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return { kind: "not-found" };
  }
  if (response.status === 401) {
    await response.body?.cancel();
    return { kind: "forbidden" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { kind: "failed" };
  }
  return null;
}

/** Stream, bound and validate a success body. */
async function parseBoundedJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  maxBytes: number,
): Promise<MorningBriefReadResult<T>> {
  const capped = await readCappedText(response, maxBytes);
  if (capped === null) {
    return { kind: "oversized" };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(capped.text);
  } catch {
    return { kind: "malformed" };
  }
  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) {
    return { kind: "malformed" };
  }
  const link = response.headers.get("link");
  const seconds = retryAfterSeconds(response);
  return {
    kind: "ok",
    data: parsed.data,
    bytes: capped.bytes,
    headers: {
      ...(link === null ? {} : { link }),
      ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
    },
  };
}

/** Deps one authorized reader closure needs; all resolved before any request. */
interface ConnectorReaderRuntime {
  readonly db: Db;
  readonly scope: MorningBriefCollectionScope;
  readonly connectorSlug: ConnectorSlug;
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly firewall: DecisionFirewall;
  readonly base: string;
  readonly accessToken: string;
  readonly budget: MorningBriefReaderBudget;
  readonly signal: AbortSignal;
  readonly stillAuthorized: () => Promise<boolean>;
}

/** Mutable per-source counters and the terminal revocation flag. */
interface ConnectorReaderState {
  attempted: number;
  streamedBytes: number;
  revoked: boolean;
}

function connectorReaderUrl(
  runtime: ConnectorReaderRuntime,
  pathname: string,
  query: Readonly<Record<string, string>> | undefined,
): URL {
  // Paths and parameters are built by the provider module from validated
  // segments; nothing provider-supplied reaches this URL.
  const url = new URL(`${runtime.base}${pathname}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
}

/**
 * Re-authorize this exact URL against live policy, then allow or refuse it.
 *
 * `no_match`, `ambiguous`, `block` and every missing-metadata case stay
 * refusals. Only an unambiguous allow reaches the provider, and a context that
 * moved since admission terminates the whole source instead.
 */
async function authorizeConnectorRequest(
  runtime: ConnectorReaderRuntime,
  state: ConnectorReaderState,
  url: URL,
): Promise<"allow" | "denied" | "revoked"> {
  const policies = await loadNetworkPolicies(
    runtime.db,
    runtime.scope,
    runtime.connectorSlug,
    runtime.snapshot,
    runtime.firewall.name,
  );
  if (!(await runtime.stillAuthorized())) {
    state.revoked = true;
    return "revoked";
  }
  const decision = matchFirewallRequestDecision(
    [runtime.firewall],
    "GET",
    url.toString(),
    policies,
    { status: "present", value: runtime.firewall.name },
  );
  return decision.kind === "allow" ? "allow" : "denied";
}

function budgetExhausted(
  runtime: ConnectorReaderRuntime,
  state: ConnectorReaderState,
): boolean {
  return (
    state.attempted >= runtime.budget.maxRequests ||
    state.streamedBytes >= runtime.budget.maxTotalResponseBytes ||
    nowDate().getTime() >= runtime.budget.deadlineAt
  );
}

/**
 * One authorized fixed-host GET reader over an already-resolved authority.
 *
 * It is not an arbitrary authenticated fetch proxy: the host comes from the
 * accepted catalog, the method is always GET, credential-bearing redirects are
 * refused, and each request is authorized again immediately before it is sent.
 */
function createConnectorReader(
  runtime: ConnectorReaderRuntime,
  state: ConnectorReaderState,
): MorningBriefConnectorReader {
  return {
    attempted: () => {
      return state.attempted;
    },
    streamedBytes: () => {
      return state.streamedBytes;
    },
    getJson: async <T>(request: {
      readonly pathname: string;
      readonly query?: Readonly<Record<string, string>>;
      readonly schema: z.ZodType<T>;
      readonly signal: AbortSignal;
    }): Promise<MorningBriefReadResult<T>> => {
      if (state.revoked || request.signal.aborted || runtime.signal.aborted) {
        return { kind: "revoked" };
      }
      if (budgetExhausted(runtime, state)) {
        return { kind: "budget-exhausted" };
      }

      const url = connectorReaderUrl(runtime, request.pathname, request.query);
      const authorized = await authorizeConnectorRequest(runtime, state, url);
      if (authorized !== "allow") {
        return { kind: authorized === "revoked" ? "revoked" : "denied" };
      }

      state.attempted += 1;
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          redirect: "error",
          signal: request.signal,
          headers: {
            Authorization: `Bearer ${runtime.accessToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "okou-morning-brief",
          },
        });
      } catch {
        // Provider errors are never stored or logged verbatim.
        return request.signal.aborted || runtime.signal.aborted
          ? { kind: "revoked" }
          : { kind: "failed" };
      }

      const refusal = await classifyProviderResponse(response);
      if (refusal) {
        return refusal;
      }
      const result = await parseBoundedJson(
        response,
        request.schema,
        Math.min(
          runtime.budget.maxResponseBytes,
          runtime.budget.maxTotalResponseBytes - state.streamedBytes,
        ),
      );
      if (result.kind === "ok") {
        state.streamedBytes += result.bytes;
      }
      return result;
    },
  };
}

/**
 * Run one collector under a live-authorized, fixed-host GET reader.
 *
 * Authorization happens before the credential is decrypted, again before every
 * single request, and once more before the collected value is released. A
 * denied endpoint is a per-request outcome the collector turns into a coverage
 * gap; a changed owner, membership, Agent, installation or account selection
 * discards the entire source. Work already in flight at the provider cannot be
 * retracted — what is promised is that no further request is issued and no
 * payload from a revoked context is ever returned.
 */
export const withMorningBriefConnectorReader$ = command(
  async (
    { set },
    args: {
      readonly scope: MorningBriefCollectionScope;
      readonly connectorSlug: ConnectorSlug;
      readonly budget: MorningBriefReaderBudget;
      readonly signal: AbortSignal;
    },
    collect: (reader: MorningBriefConnectorReader) => Promise<void>,
  ): Promise<MorningBriefAccessResult> => {
    const db = set(writeDb$);
    const { scope, connectorSlug, budget, signal } = args;

    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    const firewall = await loadDecisionFirewall(snapshot, connectorSlug);
    if (!firewall) {
      return { kind: "denied", reason: "connector-not-visible" };
    }
    const base = firewall.apis[0]?.base;
    if (base === undefined) {
      return { kind: "denied", reason: "connector-not-visible" };
    }

    const access = await resolveConnectorAccess(
      db,
      scope,
      connectorSlug,
      snapshot,
      signal,
    );
    if (access.kind !== "ok") {
      return access;
    }
    const pinned = access.authority;

    const token = await resolveAccessToken(
      db,
      scope,
      access.connection,
      budget.tokenEnvironmentNames,
      signal,
    );
    if (token.kind !== "ok") {
      return token;
    }

    const state: ConnectorReaderState = {
      attempted: 0,
      streamedBytes: 0,
      revoked: false,
    };

    const stillAuthorized = async (): Promise<boolean> => {
      const rescoped = await set(
        admitMorningBriefCollectionScope$,
        { orgId: scope.orgId, userId: scope.userId },
        signal,
      );
      if (rescoped.kind !== "admitted") {
        return false;
      }
      const current = await resolveConnectorAccess(
        db,
        rescoped.scope,
        connectorSlug,
        snapshot,
        signal,
      );
      return current.kind === "ok" && sameAuthority(current.authority, pinned);
    };

    const reader = createConnectorReader(
      {
        db,
        scope,
        connectorSlug,
        snapshot,
        firewall,
        base,
        accessToken: token.accessToken,
        budget,
        signal,
        stillAuthorized,
      },
      state,
    );

    await collect(reader);
    if (state.revoked || signal.aborted) {
      return { kind: "revoked" };
    }
    // Final release gate: a payload collected under an authority that has
    // since moved is discarded rather than returned.
    if (!(await stillAuthorized())) {
      return { kind: "revoked" };
    }
    return { kind: "collected" };
  },
);
