import type { ConnectorCheckDiagnosticResult } from "@okouai/api-contracts/contracts/connector-check";
import {
  connectorAccountTargetKey,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { getAllowedChatConnectorTargetKeys } from "../../lib/api/domains/run-connector-accounts";
import {
  customConnectorManagedStatusSchema,
  isIntegrationManagedCustomConnector,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { readMemberAccountFacts } from "./member-status";

import {
  getCustomConnector,
  type ConnectorDiagnosticRequest,
} from "../../lib/api/domains/connectors";
import { getOkouAgentId } from "../../lib/okou-env";
import { getPlatformOrigin } from "../../lib/platform-url";
import {
  CALLBACK_PROMPT_PLACEHOLDER,
  currentPermissionCallbackThread,
} from "./action-url";
import {
  AWS_INCOMPLETE_CONTEXT_GUIDANCE,
  connectorCheckDiagnosticError,
  connectorCheckRetryCommand,
  connectorPermissionRequestCommand,
  diagnosticEnvironmentNames,
  requireUrlRequest,
  type ResolvedDiagnostic,
} from "./check-diagnostic";
import {
  customConnectorSettingsGuidance,
  customUnknownEndpointPolicyGuidance,
} from "./custom-connector-guidance";
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

function diagnosticContextGuidance(
  request: ConnectorDiagnosticRequest,
): string[] {
  return request.mode === "url" && request.aws !== undefined
    ? [
        "AWS selectors describe the intended operation only; no SigV4 signature was validated and no AWS request was sent.",
      ]
    : [];
}

function customUnknownEndpointGuidance(
  diagnostic: ResolvedDiagnostic,
): string[] {
  if (
    diagnostic.connector.target.kind === "custom" &&
    diagnostic.mode === "url" &&
    diagnostic.permission.kind === "unknown-endpoint"
  ) {
    return [customUnknownEndpointPolicyGuidance(diagnostic.permission.policy)];
  }
  return [];
}

function permissionActions(
  request: ConnectorDiagnosticRequest,
  diagnostic: ResolvedDiagnostic,
  origin: string,
  awsContextIncomplete: boolean,
): CheckAction[] {
  if (
    awsContextIncomplete &&
    diagnostic.mode === "url" &&
    diagnostic.permission.kind === "unknown-endpoint" &&
    diagnostic.connector.target.kind === "builtin"
  ) {
    return [];
  }
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
        ...(currentPermissionCallbackThread()
          ? {
              callbackCommand: `${command} --callback-prompt "${CALLBACK_PROMPT_PLACEHOLDER}"`,
            }
          : {}),
      },
    ];
  });
}

function environmentPermissionName(
  request: ConnectorDiagnosticRequest,
): string {
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
) {
  const [definition, accounts, allowedTargets, origin] = await Promise.all([
    target.kind === "custom"
      ? getCustomConnector(target.customConnectorId)
      : null,
    runBound ? resolveRunConnectorAccountLookups([target]) : null,
    runBound ? getAllowedChatConnectorTargetKeys() : null,
    getPlatformOrigin(),
  ]);
  const account = accounts === null ? null : accounts[0];
  if (account === undefined) {
    throw new Error("Missing run account lookup for connector");
  }
  const memberFacts =
    !runBound &&
    !(definition && isIntegrationManagedCustomConnector(definition))
      ? await readMemberAccountFacts(target)
      : null;
  return {
    definition,
    account,
    allowedInChat:
      allowedTargets?.has(connectorAccountTargetKey(target)) ?? null,
    origin,
    accountSummary: memberFacts?.accountSummary ?? null,
    memberStatus: memberFacts?.memberStatus ?? null,
  };
}

function checkConnectionActions(
  target: ConnectorAccountTarget,
  label: string,
  evidence: Awaited<ReturnType<typeof loadCheckEvidence>>,
): ConnectorSearchAction[] {
  const { definition, account, allowedInChat, memberStatus } = evidence;
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
      memberStatus === "not-connected" ||
      memberStatus === "reconnect-required"
    ) {
      connectionActions.push({
        label: `Connect or reconnect ${label}`,
        path: `/connectors/${target.connectorSlug}/connect`,
        supportsCallback: true,
      });
    } else if (memberStatus !== "connected") {
      connectionActions.push({
        label: `Review ${label} accounts and setup`,
        path: "/connectors",
        supportsCallback: false,
      });
    }
  } else if (
    memberStatus !== null
      ? memberStatus !== "connected"
      : definition === null ||
        !isIntegrationManagedCustomConnector(definition) ||
        !definition.connected
  ) {
    connectionActions.push({
      label: `Review ${label} accounts`,
      path: "/connectors",
      supportsCallback: false,
    });
  }
  if (allowedInChat === false) {
    connectionActions.push({
      label: `Review ${label} Chat account access`,
      path: "/connectors",
      supportsCallback: false,
    });
  }
  return connectionActions;
}

export async function printConnectorCheckJson(
  request: ConnectorDiagnosticRequest,
  diagnostic: ConnectorCheckDiagnosticResult,
  awsContextIncomplete: boolean,
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
          guidance: diagnosticContextGuidance(request),
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
  const incompleteUnknown =
    awsContextIncomplete &&
    diagnostic.mode === "url" &&
    diagnostic.permission.kind === "unknown-endpoint";
  const evidence = await loadCheckEvidence(target, runBound);
  const { definition, account, allowedInChat, origin } = evidence;
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
    ...permissionActions(request, diagnostic, origin, incompleteUnknown),
  ];
  if (diagnostic.run.status === "not-configured") {
    actions.push({
      kind: "guidance",
      message:
        "Review this Chat's allowed accounts, then retry with an available account.",
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
        accountSummary: evidence.accountSummary,
        memberStatus: evidence.memberStatus,
        managedStatus:
          !runBound &&
          definition !== null &&
          isIntegrationManagedCustomConnector(definition)
            ? customConnectorManagedStatusSchema.parse(definition)
            : null,
        allowedInChat,
        guidance: [
          "Routing and permission diagnostics describe current intended state; they do not confirm that the runner has applied the latest update.",
          ...customUnknownEndpointGuidance(diagnostic),
          ...diagnosticContextGuidance(request),
          ...(incompleteUnknown ? [AWS_INCOMPLETE_CONTEXT_GUIDANCE] : []),
          ...(runBound
            ? [
                "Inspect connector account list for Chat allowance. Use connector account switch for an enabled account, or switch-request for owner approval.",
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
