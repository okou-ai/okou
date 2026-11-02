import { runConnectorAccountsContract } from "@okouai/api-contracts/contracts/run-connector-accounts";
import { connectorAccountTargetKey } from "@okouai/api-contracts/contracts/connector-accounts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { connectorPermissionGrants } from "@okouai/db/schema/connector-permission-grant";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { and, eq } from "drizzle-orm";
import { command, computed } from "ccstate";

import { badRequestMessage, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import { db$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { activeMemberConnectorPermissionCondition } from "../services/member-connector-selection";
import type { RouteEntry } from "../route-entry";
import { createUserFeatureSwitchContext } from "../services/feature-switches.service";
import {
  chatConnectorExecutionReadPlan,
  chatConnectorExecutionFromRows,
} from "../services/chat-connector-execution";
import {
  setChatConnectorCurrent$,
  setChatConnectorAccessOverride$,
} from "../services/chat-connector-access.service";
import { publishChatThreadDetailChangedSafely } from "../external/realtime";

const identity$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  return Promise.resolve({ orgId: auth.orgId, userId: auth.userId });
});
const features$ = createUserFeatureSwitchContext(identity$);
const enabled$ = computed(async (get) => {
  return isFeatureEnabled(
    FeatureSwitchKey.ConnectorChatAccountAccess,
    await get(features$),
  );
});
const missing = notFound("Chat connector account access is unavailable");
const run$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    throw new Error("Run account operation requires Run authentication");
  }
  const [run] = await get(db$)
    .select({
      runId: agentRuns.id,
      chatThreadId: chatThreads.id,
    })
    .from(agentRuns)
    .innerJoin(
      chatThreads,
      and(
        eq(chatThreads.id, agentRuns.chatThreadId),
        eq(chatThreads.agentId, agentRuns.agentId),
        eq(chatThreads.userId, auth.userId),
      ),
    )
    .innerJoin(
      agents,
      and(eq(agents.id, agentRuns.agentId), eq(agents.orgId, auth.orgId)),
    )
    .where(
      and(
        eq(agentRuns.id, auth.runId),
        eq(agentRuns.orgId, auth.orgId),
        eq(agentRuns.userId, auth.userId),
        eq(agentRuns.status, "running"),
      ),
    )
    .limit(1);
  return run ?? null;
});
const inventory$ = computed(async (get) => {
  if (!(await get(enabled$))) {
    return null;
  }
  const run = await get(run$);
  if (!run) {
    return null;
  }
  const query = chatConnectorExecutionReadPlan({
    ...(await get(identity$)),
    kind: "chat",
    chatThreadId: run.chatThreadId,
  }).as("run_chat_accounts");
  const result = chatConnectorExecutionFromRows(
    await get(db$).select().from(query),
  );
  const current = new Map(
    result.selections.map((selection) => {
      return [
        connectorAccountTargetKey(selection.target),
        selection.connectionId,
      ];
    }),
  );
  const ownedTargets = new Map(
    result.accounts.map((account) => {
      return [connectorAccountTargetKey(account.target), account.target];
    }),
  );
  const rules = await get(db$)
    .select({
      connectorSlug: connectorPermissionGrants.connectorSlug,
      customConnectorId: connectorPermissionGrants.customConnectorId,
      permission: connectorPermissionGrants.permission,
      action: connectorPermissionGrants.action,
      expiresAt: connectorPermissionGrants.expiresAt,
    })
    .from(connectorPermissionGrants)
    .where(
      activeMemberConnectorPermissionCondition(await get(identity$), nowDate()),
    );
  const permissionGrants = rules.flatMap((rule) => {
    const target =
      rule.connectorSlug !== null
        ? {
            kind: "builtin" as const,
            connectorSlug: connectorSlugSchema.parse(rule.connectorSlug),
          }
        : rule.customConnectorId !== null
          ? {
              kind: "custom" as const,
              customConnectorId: rule.customConnectorId,
            }
          : null;
    if (!target) {
      throw new Error("Member connector permission has no target");
    }
    return ownedTargets.has(connectorAccountTargetKey(target))
      ? [
          {
            target,
            permission: rule.permission,
            action: rule.action,
            expiresAt: rule.expiresAt?.toISOString() ?? null,
          },
        ]
      : [];
  });
  return {
    chatThreadId: run.chatThreadId,
    permissionGrants,
    accounts: result.accounts.map((account) => {
      return {
        target: account.target,
        connectionId: account.connectionId,
        displayName: account.displayName,
        enabled: account.enabled,
        isCurrent:
          current.get(connectorAccountTargetKey(account.target)) ===
          account.connectionId,
        isDefault: account.isDefault,
      };
    }),
  };
});
const list$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const inventory = await get(inventory$);
  signal.throwIfAborted();
  return inventory ? { status: 200 as const, body: inventory } : missing;
});
const select$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(enabled$))) {
    return missing;
  }
  signal.throwIfAborted();
  const body = await get(bodyResultOf(runConnectorAccountsContract.select));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const run = await get(run$);
  signal.throwIfAborted();
  if (!run) {
    return missing;
  }
  const owner = {
    ...(await get(identity$)),
    chatThreadId: run.chatThreadId,
    target: body.data.target,
  };
  signal.throwIfAborted();
  if (
    !(await set(
      setChatConnectorCurrent$,
      owner,
      body.data.connectionId,
      signal,
    ))
  ) {
    return badRequestMessage(
      "Account is unavailable or not allowed in this Chat; request owner approval first",
    );
  }
  await publishChatThreadDetailChangedSafely(owner.userId, owner.chatThreadId);
  signal.throwIfAborted();
  return { status: 200 as const, body: body.data };
});
const approve$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(enabled$))) {
    return missing;
  }
  signal.throwIfAborted();
  const body = await get(bodyResultOf(runConnectorAccountsContract.approve));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const owner = {
    ...(await get(identity$)),
    chatThreadId: get(pathParamsOf(runConnectorAccountsContract.approve))
      .threadId,
    target: body.data.target,
  };
  signal.throwIfAborted();
  if (
    !(await set(
      setChatConnectorAccessOverride$,
      owner,
      body.data.connectionId,
      true,
      signal,
    ))
  ) {
    return missing;
  }
  if (
    !(await set(
      setChatConnectorCurrent$,
      owner,
      body.data.connectionId,
      signal,
    ))
  ) {
    return badRequestMessage("Account is unavailable in this Chat");
  }
  await publishChatThreadDetailChangedSafely(owner.userId, owner.chatThreadId);
  signal.throwIfAborted();
  return { status: 200 as const, body: body.data };
});
const runAuth = {
  accept: ["agent"],
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "connector-account:switch",
} as const;
export const runConnectorAccountRoutes: readonly RouteEntry[] = [
  {
    route: runConnectorAccountsContract.list,
    handler: authRoute(runAuth, list$),
  },
  {
    route: runConnectorAccountsContract.select,
    handler: authRoute(runAuth, select$),
  },
  {
    route: runConnectorAccountsContract.approve,
    handler: authRoute(
      {
        accept: ["session"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      approve$,
    ),
  },
];
