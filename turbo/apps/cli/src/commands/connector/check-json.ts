import type {
  ConnectorCheckRequestBody,
  ConnectorCheckTargetAwareDiagnosticResult,
} from "@okouai/api-contracts/contracts/connector-check";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";

import {
  getAgentCustomConnectorGrants,
  getAgentUserBuiltinConnectors,
} from "../../lib/api/domains/agents";
import {
  getBuiltinConnector,
  getCustomConnector,
} from "../../lib/api/domains/connectors";
import { getOkouAgentId } from "../../lib/okou-env";
import { getPlatformOrigin } from "../../lib/platform-url";
import {
  CALLBACK_PROMPT_PLACEHOLDER,
  currentChatSupportsActionCallback,
} from "./action-url";
import {
  connectorCheckDiagnosticError,
  connectorCheckRetryCommand,
  connectorPermissionRequestCommand,
  diagnosticEnvironmentNames,
  requireUrlRequest,
  type ResolvedDiagnostic,
} from "./check-diagnostic";
import { customConnectorSettingsGuidance } from "./custom-connector-guidance";
import { connectorInspectionType } from "./inspection";
import {
  isRunBoundConnectorContext,
  resolveRunConnectorAccountLookups,
} from "./run-account-context";
import {
  connectorSearchActionLinks,
  runConnectorSearchAction,
  type ConnectorSearchAction,
} from "./search-guidance";

type CheckAction =
  | {
      readonly kind: "command";
      readonly command: string;
      readonly callbackCommand?: string;
    }
  | {
      readonly kind: "link";
      readonly label: string;
      readonly url: string;
      readonly guidance?: string;
    }
  | { readonly kind: "guidance"; readonly message: string };

function permissionActions(
  request: ConnectorCheckRequestBody,
  diagnostic: ResolvedDiagnostic,
  origin: string,
  agentId: string | undefined,
): CheckAction[] {
  const permissions =
    diagnostic.mode === "url"
      ? diagnostic.permission.kind === "matched"
        ? diagnostic.permission.permissions
        : [{ name: "__unknown__", policy: diagnostic.permission.policy }]
      : diagnostic.permission === null
        ? []
        : [
            {
              name: environmentPermissionName(request),
              policy: diagnostic.permission,
            },
          ];
  const target = diagnostic.connector.target;
  return permissions.flatMap((permission): CheckAction[] => {
    if (
      permission.policy.outcome !== "deny" &&
      permission.policy.outcome !== "ask"
    ) {
      return [];
    }
    if (target.kind === "custom") {
      return [
        {
          kind: "link",
          label: `Review ${permission.name} for custom connector ${target.customConnectorId}`,
          url: new URL("/connectors", origin).toString(),
          guidance: customConnectorSettingsGuidance(
            target.customConnectorId,
            origin,
            permission.name,
          ),
        },
      ];
    }
    if (request.mode !== "url") {
      return [
        {
          kind: "guidance",
          message:
            "Diagnose the failed request with okou connector check --url <FAILED_URL> --method <METHOD> before requesting this permission.",
        },
      ];
    }
    const command = connectorPermissionRequestCommand(
      target.connectorSlug,
      permission.name,
      request,
    );
    return [
      {
        kind: "command",
        command,
        ...(currentChatSupportsActionCallback(agentId)
          ? {
              callbackCommand: `${command} --callback-prompt "${CALLBACK_PROMPT_PLACEHOLDER}"`,
            }
          : {}),
      },
    ];
  });
}

function environmentPermissionName(request: ConnectorCheckRequestBody): string {
  if (request.mode !== "environment" || request.permission === undefined) {
    throw new Error(
      "Connector diagnostic returned a permission outcome without a requested permission.",
    );
  }
  return request.permission;
}

async function loadCheckEvidence(
  target: ConnectorAccountTarget,
  runBound: boolean,
  agentId: string | undefined,
) {
  const [definition, currentConnection, accounts, authorized, origin] =
    await Promise.all([
      target.kind === "custom"
        ? getCustomConnector(target.customConnectorId)
        : null,
      !runBound && target.kind === "builtin"
        ? getBuiltinConnector(target.connectorSlug)
        : null,
      runBound ? resolveRunConnectorAccountLookups([target]) : null,
      agentId === undefined
        ? null
        : target.kind === "builtin"
          ? getAgentUserBuiltinConnectors(agentId).then((slugs) => {
              return slugs.includes(target.connectorSlug);
            })
          : getAgentCustomConnectorGrants(agentId).then((grants) => {
              return grants.some((grant) => {
                return grant.customConnectorId === target.customConnectorId;
              });
            }),
      getPlatformOrigin(),
    ]);
  const account = accounts === null ? null : accounts[0];
  if (account === undefined) {
    throw new Error("Missing run account lookup for connector");
  }
  return { definition, currentConnection, account, authorized, origin };
}

function checkConnectionActions(
  target: ConnectorAccountTarget,
  label: string,
  evidence: Awaited<ReturnType<typeof loadCheckEvidence>>,
): ConnectorSearchAction[] {
  const { definition, currentConnection, account, authorized } = evidence;
  const connectionActions: ConnectorSearchAction[] = [];
  if (account !== null) {
    const action = runConnectorSearchAction(
      {
        kind: target.kind === "builtin" ? "catalog" : "custom",
        slug:
          target.kind === "builtin"
            ? target.connectorSlug
            : `custom:${target.customConnectorId}`,
        label,
      },
      account,
    );
    if (action !== null) {
      connectionActions.push(action);
    }
  } else if (target.kind === "builtin") {
    if (
      currentConnection === null ||
      currentConnection.connectionStatus === "reconnect-required"
    ) {
      connectionActions.push({
        label: `Connect or reconnect ${label}`,
        path: `/connectors/${target.connectorSlug}/connect`,
        supportsCallback: true,
      });
    }
  } else if (definition === null || !definition.connected) {
    connectionActions.push({
      label: `Review ${label} accounts and agent access`,
      path: "/connectors",
      supportsCallback: false,
    });
  }
  if (authorized === false) {
    connectionActions.push(
      target.kind === "builtin"
        ? {
            label: `Authorize ${label}`,
            path: `/connectors/${target.connectorSlug}/authorize`,
            supportsCallback: true,
          }
        : {
            label: `Review ${label} agent access`,
            path: "/connectors",
            supportsCallback: false,
          },
    );
  }
  return connectionActions;
}

export async function printConnectorCheckJson(
  request: ConnectorCheckRequestBody,
  diagnostic: ConnectorCheckTargetAwareDiagnosticResult,
): Promise<void> {
  const runBound = isRunBoundConnectorContext();
  const context = runBound ? "run" : "current";
  const agentId = getOkouAgentId();
  const retry: CheckAction = {
    kind: "command",
    command: `${connectorCheckRetryCommand(request)} --json`,
  };
  if (diagnostic.outcome !== "resolved") {
    console.log(
      JSON.stringify(
        {
          context,
          request,
          diagnostic,
          message: connectorCheckDiagnosticError(request, diagnostic).message,
          actions: [retry],
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }
  if (diagnostic.mode === "url") {
    requireUrlRequest(request);
  }
  const target = diagnostic.connector.target;
  const evidence = await loadCheckEvidence(target, runBound, agentId);
  const { definition, currentConnection, account, authorized, origin } =
    evidence;
  const label =
    target.kind === "builtin"
      ? diagnostic.connector.label
      : (definition?.displayName ?? target.customConnectorId);
  const connectionActions = checkConnectionActions(target, label, evidence);
  const actions: CheckAction[] = [
    ...connectorSearchActionLinks({
      actions: connectionActions,
      origin,
      agentId,
      callbackPrompt: undefined,
    }).map((link): CheckAction => {
      return { kind: "link", ...link };
    }),
    ...permissionActions(request, diagnostic, origin, agentId),
  ];
  if (diagnostic.run.status === "not-configured") {
    actions.push({
      kind: "guidance",
      message:
        "Review the connector's agent access and selected account, then start a new run.",
    });
  }
  actions.push(retry);
  const environmentNames = diagnosticEnvironmentNames(diagnostic);
  console.log(
    JSON.stringify(
      {
        context,
        request,
        diagnostic,
        connector: {
          ...diagnostic.connector,
          label,
          connectorType: connectorInspectionType(target, definition),
          definitionAvailable:
            target.kind === "custom"
              ? definition !== null
              : diagnostic.connector.visibility === "available",
        },
        environment:
          environmentNames === null
            ? null
            : environmentNames.map((name) => {
                return { name, present: Boolean(process.env[name]) };
              }),
        account,
        connection: runBound
          ? null
          : target.kind === "builtin"
            ? currentConnection
            : definition === null
              ? null
              : {
                  connected: definition.connected,
                  connectionId: definition.connectedAccountId ?? null,
                  missingRequiredFields: definition.missingRequiredFields,
                },
        authorization: agentId === undefined ? null : { agentId, authorized },
        guidance: [
          "Routing and permission diagnostics describe current intended state; they do not confirm that the runner has applied the latest update.",
          ...(runBound
            ? [
                "Connector changes apply to future runs. Reconnect or change the thread selection, then start a new run.",
              ]
            : []),
        ],
        actions,
      },
      null,
      2,
    ),
  );
}
