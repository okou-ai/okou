import { command, computed } from "ccstate";
import {
  connectorAccountTargetKey,
  connectorAccountsContract,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";

import { badRequestMessage, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { setResHeader$ } from "../context/hono";
import { readConnectorOAuthCompletion } from "../services/connector-oauth-completion.service";
import type { RouteEntry } from "../route-entry";
import { bestEffort } from "../utils";
import {
  connectorAccountDeletionImpact,
  getConnectorAccount,
  listConnectorAccountsByIds,
  listConnectorAccountsForTarget,
  listConnectorAccountSummaries,
  renameConnectorAccount,
  setDefaultConnectorAccount,
} from "../services/connector-account-lifecycle.service";
import { commitConnectorRuntimeMutation } from "../services/connector-runtime-wakeup.service";
import {
  connectorScopeDiff,
  deleteConnectorLocalState$,
} from "../services/connector-data.service";
import { deleteCustomConnectorAccount$ } from "../services/custom-connector.service";
import { reconcileGmailWatchesForUser } from "../services/gmail-automation-event.service";
import { reconcileGoogleCalendarWatchesForUser } from "../services/google-calendar-automation-event.service";
import { reconcileGoogleFormsWatchesForUser } from "../services/google-forms-automation-event.service";
import { reconcileGoogleMeetSubscriptionsForUser } from "../services/google-meet-automation-event.service";

function targetFromQuery(
  query: ConnectorAccountTarget,
): ConnectorAccountTarget {
  return query.kind === "builtin"
    ? { kind: "builtin", connectorSlug: query.connectorSlug }
    : { kind: "custom", customConnectorId: query.customConnectorId };
}

const oauthCompletionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const { attemptId } = get(
      pathParamsOf(connectorAccountsContract.oauthCompletion),
    );
    const target = get(queryOf(connectorAccountsContract.oauthCompletion));
    set(setResHeader$, "Cache-Control", "no-store");
    const completion = await readConnectorOAuthCompletion(
      set(writeDb$),
      {
        orgId: auth.orgId,
        userId: auth.userId,
        attemptId,
        target,
      },
      signal,
    );
    return completion
      ? { status: 200 as const, body: completion }
      : notFound("OAuth completion not found");
  },
);

const inspectInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const body = await get(bodyResultOf(connectorAccountsContract.inspect));
  if (!body.ok) {
    return body.response;
  }
  const accounts = await listConnectorAccountsByIds(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    connectionIds: body.data.selections.map((selection) => {
      return selection.connectionId;
    }),
  });
  const accountsById = new Map(
    accounts.map((account) => {
      return [account.id, account];
    }),
  );
  return {
    status: 200 as const,
    body: {
      results: body.data.selections.map((selection) => {
        const account = accountsById.get(selection.connectionId);
        if (
          !account ||
          connectorAccountTargetKey(account.target) !==
            connectorAccountTargetKey(selection.target)
        ) {
          return { kind: "unavailable" as const, ...selection };
        }
        return {
          kind: "available" as const,
          connectionId: account.id,
          target: account.target,
          authMethod: account.authMethod,
          displayName: account.displayName,
          externalId: account.externalId,
          externalUsername: account.externalUsername,
          externalEmail: account.externalEmail,
          connectionStatus: account.connectionStatus,
          reconnectReason: account.reconnectReason,
        };
      }),
    },
  };
});

const summariesInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const summaries = await listConnectorAccountSummaries(get(db$), auth);
  return { status: 200 as const, body: { summaries: [...summaries] } };
});

const connectionsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(connectorAccountsContract.connections));
  const result = await listConnectorAccountsForTarget(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    target: targetFromQuery(query),
    limit: query.limit,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.search ? { search: query.search } : {}),
    ...(query.kind === "builtin" && query.includeScopeMismatch === "true"
      ? { includeScopeMismatch: true }
      : {}),
  });
  if (result.kind === "invalid-cursor") {
    return badRequestMessage("Invalid connector account cursor");
  }
  if (result.kind === "missing") {
    return notFound("Connector target not found");
  }
  return {
    status: 200 as const,
    body: {
      connections: [...result.connections],
      nextCursor: result.nextCursor,
      ...(result.defaultConnection !== undefined
        ? { defaultConnection: result.defaultConnection }
        : {}),
    },
  };
});

const connectionInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(connectorAccountsContract.connection));
  const query = get(queryOf(connectorAccountsContract.connection));
  const account = await getConnectorAccount(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    target: targetFromQuery(query),
    connectionId: params.connectionId,
  });
  return account
    ? { status: 200 as const, body: account }
    : notFound("Connector account not found");
});

const scopeDiffInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(connectorAccountsContract.scopeDiff));
  const query = get(queryOf(connectorAccountsContract.scopeDiff));
  const diff = await get(
    connectorScopeDiff({
      orgId: auth.orgId,
      userId: auth.userId,
      connectorSlug: query.connectorSlug,
      selection: { kind: "exact", connectorId: params.connectionId },
    }),
  );
  return diff
    ? { status: 200 as const, body: diff }
    : notFound("Connector account not found");
});

const renameInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(connectorAccountsContract.rename));
    const body = await get(bodyResultOf(connectorAccountsContract.rename));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const request = {
      orgId: auth.orgId,
      userId: auth.userId,
      target: body.data.target,
      connectionId: params.connectionId,
    };
    const existing = await getConnectorAccount(get(db$), request);
    signal.throwIfAborted();
    if (!existing) {
      return notFound("Connector account not found");
    }
    const writeDb = set(writeDb$);
    const updatedAt = await renameConnectorAccount(writeDb, {
      ...request,
      displayName: body.data.displayName,
    });
    signal.throwIfAborted();
    if (!updatedAt) {
      return notFound("Connector account not found");
    }
    return {
      status: 200 as const,
      body: {
        ...existing,
        displayName: body.data.displayName,
        updatedAt: updatedAt.toISOString(),
      },
    };
  },
);

const setDefaultInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(connectorAccountsContract.setDefault));
    const body = await get(bodyResultOf(connectorAccountsContract.setDefault));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const request = {
      orgId: auth.orgId,
      userId: auth.userId,
      target: body.data.target,
      connectionId: params.connectionId,
    };
    const existing = await getConnectorAccount(get(db$), request);
    signal.throwIfAborted();
    if (!existing) {
      return notFound("Connector account not found");
    }
    const writeDb = set(writeDb$);
    const updatedAt = await commitConnectorRuntimeMutation(
      setDefaultConnectorAccount(writeDb, request, signal),
      (changed) => {
        return changed
          ? {
              db: writeDb,
              scope: { orgId: auth.orgId, userId: auth.userId },
              targets: [body.data.target],
            }
          : undefined;
      },
    );
    signal.throwIfAborted();
    if (!updatedAt) {
      return notFound("Connector account not found");
    }
    if (
      body.data.target.kind === "builtin" &&
      (body.data.target.connectorSlug === "gmail" ||
        body.data.target.connectorSlug === "google-calendar" ||
        body.data.target.connectorSlug === "google-forms" ||
        body.data.target.connectorSlug === "google-meet")
    ) {
      await bestEffort(
        body.data.target.connectorSlug === "gmail"
          ? reconcileGmailWatchesForUser(
              { db: writeDb, orgId: auth.orgId, userId: auth.userId },
              signal,
            )
          : body.data.target.connectorSlug === "google-calendar"
            ? reconcileGoogleCalendarWatchesForUser(
                { db: writeDb, orgId: auth.orgId, userId: auth.userId },
                signal,
              )
            : body.data.target.connectorSlug === "google-forms"
              ? reconcileGoogleFormsWatchesForUser(
                  { db: writeDb, orgId: auth.orgId, userId: auth.userId },
                  signal,
                )
              : reconcileGoogleMeetSubscriptionsForUser(
                  { db: writeDb, orgId: auth.orgId, userId: auth.userId },
                  signal,
                ),
        signal,
      );
    }
    return {
      status: 200 as const,
      body: {
        ...existing,
        isDefault: true,
        updatedAt: updatedAt.toISOString(),
      },
    };
  },
);

const deletionImpactInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(connectorAccountsContract.deletionImpact));
  const query = get(queryOf(connectorAccountsContract.deletionImpact));
  const request = {
    orgId: auth.orgId,
    userId: auth.userId,
    target: targetFromQuery(query),
    connectionId: params.connectionId,
  };
  if (!(await getConnectorAccount(get(db$), request))) {
    return notFound("Connector account not found");
  }
  const impact = await connectorAccountDeletionImpact(get(db$), request);
  if (!impact) {
    return notFound("Connector account not found");
  }
  return {
    status: 200 as const,
    body: { connectionId: params.connectionId, ...impact },
  };
});

const deleteInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(connectorAccountsContract.delete));
    const body = await get(bodyResultOf(connectorAccountsContract.delete));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const request = {
      orgId: auth.orgId,
      userId: auth.userId,
      target: body.data.target,
      connectionId: params.connectionId,
    };
    if (!(await getConnectorAccount(get(db$), request))) {
      return notFound("Connector account not found");
    }
    const result =
      body.data.target.kind === "builtin"
        ? await set(
            deleteConnectorLocalState$,
            {
              orgId: auth.orgId,
              userId: auth.userId,
              connectorSlug: body.data.target.connectorSlug,
              sourceId: params.connectionId,
            },
            signal,
          )
        : await set(
            deleteCustomConnectorAccount$,
            {
              orgId: auth.orgId,
              userId: auth.userId,
              connectorId: body.data.target.customConnectorId,
              memberConnectorId: params.connectionId,
            },
            signal,
          );
    signal.throwIfAborted();
    if (result === "missing") {
      return notFound("Connector account not found");
    }
    if (result.kind === "missing" || result.kind === "managed") {
      return notFound("Connector account not found");
    }
    return {
      status: 200 as const,
      body: {
        deletedConnectionId: params.connectionId,
        resolvedSelectionCount: result.resolvedSelectionCount,
        promotedDefaultConnectionId: result.promotedDefaultConnectionId,
      },
    };
  },
);

const readAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "connector:read",
} as const;

const writeAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "connector:write",
} as const;

export const connectorAccountRoutes: readonly RouteEntry[] = [
  {
    route: connectorAccountsContract.oauthCompletion,
    handler: authRoute(readAuth, oauthCompletionInner$),
  },
  {
    route: connectorAccountsContract.inspect,
    handler: authRoute(readAuth, inspectInner$),
  },
  {
    route: connectorAccountsContract.summaries,
    handler: authRoute(readAuth, summariesInner$),
  },
  {
    route: connectorAccountsContract.connections,
    handler: authRoute(readAuth, connectionsInner$),
  },
  {
    route: connectorAccountsContract.scopeDiff,
    handler: authRoute(readAuth, scopeDiffInner$),
  },
  {
    route: connectorAccountsContract.connection,
    handler: authRoute(readAuth, connectionInner$),
  },
  {
    route: connectorAccountsContract.rename,
    handler: authRoute(writeAuth, renameInner$),
  },
  {
    route: connectorAccountsContract.setDefault,
    handler: authRoute(writeAuth, setDefaultInner$),
  },
  {
    route: connectorAccountsContract.deletionImpact,
    handler: authRoute(readAuth, deletionImpactInner$),
  },
  {
    route: connectorAccountsContract.delete,
    handler: authRoute(writeAuth, deleteInner$),
  },
];
