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
import { writeDb$ } from "../external/db";
import { setResHeader$ } from "../context/hono";
import { connectorOAuthCompletionReceipt } from "../services/connector-oauth-completion.service";
import type { RouteEntry } from "../route-entry";
import { bestEffort, settle } from "../utils";
import {
  connectorAccount,
  connectorAccountDeletionImpact,
  connectorAccountSummaries,
  connectorAccountsForTarget,
  isConnectorAccountDefaultConflict,
  connectorAccountsByIds,
  renameConnectorAccount$,
  setDefaultConnectorAccount$,
  setDefaultGoogleFormsAccount$,
} from "../services/connector-account-lifecycle.service";
import { publishConnectorRuntimeSyncWakeups$ } from "../services/connector-runtime-wakeup.service";
import {
  builtinConnectorScopeDiff,
  deleteBuiltinConnectorLocalState$,
} from "../services/connector-data.service";
import { deleteCustomConnectorAccount$ } from "../services/custom-connector.service";
import { reconcileGmailWatchesForUser$ } from "../services/gmail-automation-watch.service";
import { reconcileGoogleCalendarWatchesForUser$ } from "../services/google-calendar-automation-watch.service";
import { reconcileGoogleFormsWatchesForUser$ } from "../services/google-forms-automation-watch.service";
import { reconcileGoogleMeetSubscriptionsForUser$ } from "../services/google-meet-automation-watch.service";

function targetFromQuery(
  query: ConnectorAccountTarget,
): ConnectorAccountTarget {
  return query.kind === "builtin"
    ? { kind: "builtin", connectorSlug: query.connectorSlug }
    : { kind: "custom", customConnectorId: query.customConnectorId };
}

const oauthCompletionScope$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  const { attemptId } = get(
    pathParamsOf(connectorAccountsContract.oauthCompletion),
  );
  const target = get(queryOf(connectorAccountsContract.oauthCompletion));
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    attemptId,
    target: targetFromQuery(target),
  };
});

const oauthCompletionReceipt$ = connectorOAuthCompletionReceipt(
  oauthCompletionScope$,
);

const oauthCompletionAccountScope$ = computed(async (get) => {
  const scope = get(oauthCompletionScope$);
  const completion = await get(oauthCompletionReceipt$);
  return completion
    ? { ...scope, connectionId: completion.connectionId }
    : null;
});
const oauthCompletionAccount$ = connectorAccount(oauthCompletionAccountScope$);

const oauthCompletionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    get(oauthCompletionScope$);
    set(setResHeader$, "Cache-Control", "no-store");
    const completion = await get(oauthCompletionReceipt$);
    signal.throwIfAborted();
    if (!completion) {
      return notFound("OAuth completion not found");
    }
    const account = await get(oauthCompletionAccount$);
    signal.throwIfAborted();
    return account
      ? { status: 200 as const, body: completion }
      : notFound("OAuth completion not found");
  },
);

const inspectionScope$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const body = await get(bodyResultOf(connectorAccountsContract.inspect));
  return body.ok
    ? {
        orgId: auth.orgId,
        userId: auth.userId,
        connectionIds: body.data.selections.map((selection) => {
          return selection.connectionId;
        }),
      }
    : null;
});
const inspectedAccounts$ = connectorAccountsByIds(inspectionScope$);

const inspectInner$ = computed(async (get) => {
  const body = await get(bodyResultOf(connectorAccountsContract.inspect));
  if (!body.ok) {
    return body.response;
  }
  const accounts = await get(inspectedAccounts$);
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
          setupStatus: account.setupStatus,
          missingRequiredFields: account.missingRequiredFields,
          configuredFieldKeys: account.configuredFieldKeys,
        };
      }),
    },
  };
});

const accountSummaryScope$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(connectorAccountsContract.summaries));
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    ...(query?.includeScopeMismatch === "true"
      ? { includeScopeMismatch: true as const }
      : {}),
  };
});
const accountSummaries$ = connectorAccountSummaries(accountSummaryScope$);

const summariesInner$ = computed(async (get) => {
  const summaries = await get(accountSummaries$);
  return { status: 200 as const, body: { summaries: [...summaries] } };
});

const connectionsScope$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(connectorAccountsContract.connections));
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    target: targetFromQuery(query),
    limit: query.limit,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.search ? { search: query.search } : {}),
    ...(query.kind === "builtin" && query.includeScopeMismatch === "true"
      ? { includeScopeMismatch: true as const }
      : {}),
  };
});
const accountsForTarget$ = connectorAccountsForTarget(connectionsScope$);

const connectionsInner$ = computed(async (get) => {
  const result = await get(accountsForTarget$);
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
      defaultConnection: result.defaultConnection,
    },
  };
});

const connectionScope$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(connectorAccountsContract.connection));
  const query = get(queryOf(connectorAccountsContract.connection));
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    target: targetFromQuery(query),
    connectionId: params.connectionId,
  };
});
const account$ = connectorAccount(connectionScope$);

const connectionInner$ = computed(async (get) => {
  const account = await get(account$);
  return account
    ? { status: 200 as const, body: account }
    : notFound("Connector account not found");
});

const scopeDiffScope$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(connectorAccountsContract.scopeDiff));
  const query = get(queryOf(connectorAccountsContract.scopeDiff));
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    connectorSlug: query.connectorSlug,
    selection: { kind: "exact" as const, connectorId: params.connectionId },
  };
});
const scopeDiff$ = builtinConnectorScopeDiff(scopeDiffScope$);

const scopeDiffInner$ = computed(async (get) => {
  const diff = await get(scopeDiff$);
  return diff
    ? { status: 200 as const, body: diff }
    : notFound("Connector account not found");
});

const renameAccountScope$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(connectorAccountsContract.rename));
  const body = await get(bodyResultOf(connectorAccountsContract.rename));
  return body.ok
    ? {
        orgId: auth.orgId,
        userId: auth.userId,
        target: body.data.target,
        connectionId: params.connectionId,
      }
    : null;
});
const renameAccount$ = connectorAccount(renameAccountScope$);

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
    const existing = await get(renameAccount$);
    signal.throwIfAborted();
    if (!existing) {
      return notFound("Connector account not found");
    }
    const updatedAt = await set(renameConnectorAccount$, {
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
const defaultAccountScope$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(connectorAccountsContract.setDefault));
  const body = await get(bodyResultOf(connectorAccountsContract.setDefault));
  return body.ok
    ? {
        orgId: auth.orgId,
        userId: auth.userId,
        target: body.data.target,
        connectionId: params.connectionId,
      }
    : null;
});
const defaultAccount$ = connectorAccount(defaultAccountScope$);

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
    const existing = await get(defaultAccount$);
    signal.throwIfAborted();
    if (!existing) {
      return notFound("Connector account not found");
    }
    set(writeDb$);
    const updatedAt =
      request.target.kind === "builtin" &&
      request.target.connectorSlug === "google-forms"
        ? await set(
            setDefaultGoogleFormsAccount$,
            {
              orgId: request.orgId,
              userId: request.userId,
              connectionId: request.connectionId,
            },
            signal,
          )
        : await set(setDefaultConnectorAccount$, request, signal);
    if (updatedAt instanceof Date) {
      await set(
        publishConnectorRuntimeSyncWakeups$,
        {
          scope: { orgId: auth.orgId, userId: auth.userId },
          targets: [body.data.target],
        },
        signal,
      );
    }
    signal.throwIfAborted();
    if (updatedAt === "conflict") {
      return badRequestMessage("Another default change won; please save again");
    }
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
          ? set(
              reconcileGmailWatchesForUser$,
              { orgId: auth.orgId, userId: auth.userId },
              signal,
            )
          : body.data.target.connectorSlug === "google-calendar"
            ? set(
                reconcileGoogleCalendarWatchesForUser$,
                { orgId: auth.orgId, userId: auth.userId },
                signal,
              )
            : body.data.target.connectorSlug === "google-forms"
              ? set(
                  reconcileGoogleFormsWatchesForUser$,
                  { orgId: auth.orgId, userId: auth.userId },
                  signal,
                )
              : set(
                  reconcileGoogleMeetSubscriptionsForUser$,
                  { orgId: auth.orgId, userId: auth.userId },
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

const deletionImpactScope$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(connectorAccountsContract.deletionImpact));
  const query = get(queryOf(connectorAccountsContract.deletionImpact));
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    target: targetFromQuery(query),
    connectionId: params.connectionId,
  };
});
const deletionImpactAccount$ = connectorAccount(deletionImpactScope$);
const accountDeletionImpact$ =
  connectorAccountDeletionImpact(deletionImpactScope$);

const deletionImpactInner$ = computed(async (get) => {
  const request = get(deletionImpactScope$);
  if (!(await get(deletionImpactAccount$))) {
    return notFound("Connector account not found");
  }
  const impact = await get(accountDeletionImpact$);
  if (!impact) {
    return notFound("Connector account not found");
  }
  return {
    status: 200 as const,
    body: { connectionId: request.connectionId, ...impact },
  };
});

const deleteAccountScope$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(connectorAccountsContract.delete));
  const body = await get(bodyResultOf(connectorAccountsContract.delete));
  return body.ok
    ? {
        orgId: auth.orgId,
        userId: auth.userId,
        target: body.data.target,
        connectionId: params.connectionId,
      }
    : null;
});
const deleteAccount$ = connectorAccount(deleteAccountScope$);

const deleteInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(connectorAccountsContract.delete));
    const body = await get(bodyResultOf(connectorAccountsContract.delete));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    if (!(await get(deleteAccount$))) {
      return notFound("Connector account not found");
    }
    const deletion =
      body.data.target.kind === "builtin"
        ? await settle(
            set(
              deleteBuiltinConnectorLocalState$,
              {
                orgId: auth.orgId,
                userId: auth.userId,
                connectorSlug: body.data.target.connectorSlug,
                sourceId: params.connectionId,
              },
              signal,
            ),
          )
        : await settle(
            set(
              deleteCustomConnectorAccount$,
              {
                orgId: auth.orgId,
                userId: auth.userId,
                connectorId: body.data.target.customConnectorId,
                memberConnectorId: params.connectionId,
              },
              signal,
            ),
          );
    signal.throwIfAborted();
    if (!deletion.ok) {
      if (isConnectorAccountDefaultConflict(deletion.error)) {
        return badRequestMessage(
          "Another default change won; please delete again",
        );
      }
      throw deletion.error;
    }
    const result = deletion.value;
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
