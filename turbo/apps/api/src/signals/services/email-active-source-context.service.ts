import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { agentRunConnectorDiagnosticRegistrationPayloadSchema } from "@okouai/api-contracts/contracts/runners";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { connectors } from "@okouai/db/schema/connector";
import { connectorPermissionGrants } from "@okouai/db/schema/connector-permission-grant";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import {
  chatConnectorExecutionFromRows,
  chatConnectorExecutionReadPlan,
} from "./chat-connector-execution";
import { readConnectorRuntimeAuthSelection$ } from "./connector-catalog-slug-source.service";
import { loadEmailSourceMessageContext$ } from "./email-source-message.service";
import {
  buildEmailPrompt,
  type EmailMailboxConnection,
  type EmailPromptContext,
} from "./email-prompt";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";
import {
  activeMemberConnectorPermissionCondition,
  memberConnectorPermissionColumns,
} from "./member-connector-selection";
import { readActiveNetworkPolicyRefreshes$ } from "./user-permission-grants.service";

interface ActiveEmailScope {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly featureSwitchContext: FeatureSwitchContext;
}

/** Caller-owned reads honor cancellation before any mailbox credentials load. */
const readActiveEmailMailboxes$ = command(
  async ({ get }, args: ActiveEmailScope, signal: AbortSignal) => {
    const db = get(db$);
    const [run] = await db
      .select({
        agentId: agentRuns.agentId,
        payload: agentRunConnectorDiagnosticRegistrations.payload,
      })
      .from(agentRuns)
      .innerJoin(
        agentRunConnectorDiagnosticRegistrations,
        eq(agentRunConnectorDiagnosticRegistrations.runId, agentRuns.id),
      )
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
          eq(agentRuns.chatThreadId, args.chatThreadId),
          eq(agentRuns.status, "running"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!run?.agentId) {
      return null;
    }
    const targets = agentRunConnectorDiagnosticRegistrationPayloadSchema
      .parse(run.payload)
      .targets.flatMap<
        Pick<EmailMailboxConnection, "connectorSlug" | "connectionId">
      >((target) => {
        return target.kind === "builtin" &&
          (target.connectorSlug === "gmail" ||
            target.connectorSlug === "outlook-mail") &&
          target.sourceId
          ? [
              {
                connectorSlug: target.connectorSlug,
                connectionId: target.sourceId,
              },
            ]
          : [];
      });
    if (targets.length === 0) {
      return null;
    }
    const chatMode = isFeatureEnabled(
      FeatureSwitchKey.ConnectorChatAccountAccess,
      args.featureSwitchContext,
    );
    const selections = chatMode
      ? chatConnectorExecutionFromRows(
          await db
            .select()
            .from(
              chatConnectorExecutionReadPlan({ ...args, kind: "run" }).as(
                "email_execution_accounts",
              ),
            ),
        ).selections
      : targets.map(({ connectorSlug, connectionId }) => {
          return {
            target: { kind: "builtin" as const, connectorSlug },
            connectionId,
          };
        });
    signal.throwIfAborted();
    const bindings = new Map(
      selections.flatMap((selection) => {
        const mailbox = targets.find((target) => {
          return (
            selection.target.kind === "builtin" &&
            target.connectorSlug === selection.target.connectorSlug
          );
        });
        return mailbox
          ? [
              [
                selection.connectionId,
                { ...mailbox, connectionId: selection.connectionId },
              ] as const,
            ]
          : [];
      }),
    );
    if (bindings.size === 0) {
      return null;
    }
    const rows = await db
      .select({
        connectionId: connectors.id,
        emailAddress: connectors.externalEmail,
        displayName: connectors.displayName,
      })
      .from(connectors)
      .where(
        and(
          inArray(connectors.id, [...bindings.keys()]),
          eq(connectors.userId, args.userId),
          eq(connectors.orgId, args.orgId),
          eq(connectors.needsReconnect, false),
        ),
      );
    signal.throwIfAborted();
    const memberRules = chatMode
      ? await db
          .select(memberConnectorPermissionColumns())
          .from(connectorPermissionGrants)
          .where(activeMemberConnectorPermissionCondition(args, nowDate()))
      : undefined;
    signal.throwIfAborted();
    return {
      agentId: run.agentId,
      memberRules,
      mailboxes: rows.flatMap((row) => {
        const binding = bindings.get(row.connectionId);
        return binding ? [{ ...binding, ...row }] : [];
      }),
    };
  },
);

/** Reuse the running Run's registered targets and current account/permissions. */
export const loadActiveEmailIntegrationContext$ = command(
  async (
    { set },
    args: ActiveEmailScope & {
      readonly email: EmailPromptContext & {
        readonly messageText: string;
      };
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const selection = await set(readActiveEmailMailboxes$, args, signal);
    let messageContext = "";
    if (selection && selection.mailboxes.length > 0) {
      const connectorSlugs = selection.mailboxes.map((mailbox) => {
        return mailbox.connectorSlug;
      });
      const snapshot = await set(
        readConnectorRuntimeAuthSelection$,
        {
          connectorSlugs,
          firewallConnectorSlugs: connectorSlugs,
        },
        signal,
      );
      const refreshes = await set(readActiveNetworkPolicyRefreshes$, {
        scope: { ...args, agentId: selection.agentId },
        connectorSlugs,
        snapshot,
        memberRules: selection.memberRules,
      });
      signal.throwIfAborted();
      messageContext = await set(
        loadEmailSourceMessageContext$,
        {
          ...args,
          mailboxes: selection.mailboxes,
          snapshot,
          policies: null,
          networkPolicies: Object.fromEntries(
            refreshes.map((refresh) => {
              return [refresh.connectorSlug, refresh.networkPolicy];
            }),
          ),
        },
        signal,
      );
    }
    const mailboxes = selection?.mailboxes ?? [];
    return buildEmailPrompt(
      args.email,
      resolveIntegrationNotePrompt({
        triggerSource: "email",
        featureSwitchContext: args.featureSwitchContext,
        emailHasConnectedMailbox: mailboxes.length > 0,
      }),
      mailboxes,
      messageContext,
    );
  },
);
