import {
  type ConnectorAccountTarget,
  type ConnectorAccountInspectionResult,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { Command, Option } from "commander";

import {
  inspectConnectorAccounts,
  listConnectorCatalogStatus,
  listCustomConnectors,
} from "../../../lib/api/domains/connectors";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { getOkouAgentId } from "../../../lib/okou-env";
import { isUuid } from "../../../lib/utils/uuid";
import { getPlatformOrigin } from "../../../lib/platform-url";
import { connectorAccountCliLabel } from "../account-label";
import { finalizeActionUrl, printCallbackTurnInstruction } from "../action-url";
import {
  connectorDiscoveryItems,
  isConnectorDiscoveryAuthorized,
  type ConnectorDiscoveryItem,
} from "../discovery";
import { resolveConnectorDiscoveryAgentContext } from "../agent-context";
import { findConnectorBySelector } from "../connector-selector";

interface SwitchConnectorAccountRequestOptions {
  readonly connectionId: string;
  readonly callbackPrompt: string;
}

function accountTarget(
  connector: ConnectorDiscoveryItem,
): ConnectorAccountTarget {
  return connector.kind === "catalog"
    ? { kind: "builtin", connectorSlug: connector.slug }
    : {
        kind: "custom",
        customConnectorId: connector.customConnector.id,
      };
}

function addTargetSearchParams(
  params: URLSearchParams,
  target: ConnectorAccountTarget,
): void {
  params.set("kind", target.kind);
  if (target.kind === "builtin") {
    params.set("connectorSlug", target.connectorSlug);
    return;
  }
  params.set("customConnectorId", target.customConnectorId);
}

function availableInspection(
  results: readonly ConnectorAccountInspectionResult[] | null,
  connectorSlug: string,
  connectionId: string,
): Extract<ConnectorAccountInspectionResult, { kind: "available" }> {
  if (results === null) {
    throw new Error("Connector account switching is unavailable");
  }
  const [result] = results;
  if (result === undefined) {
    throw new Error("Connector account inspection returned no result");
  }
  if (result.kind === "unavailable") {
    throw new Error(
      `Connector account ${connectionId} is unavailable for ${connectorSlug}`,
    );
  }
  return result;
}

export const switchConnectorAccountRequestCommand = new Command()
  .name("switch-request")
  .description(
    "Ask the user to use one exact connector account for future runs in this chat",
  )
  .argument(
    "<selector>",
    "Connector slug, custom UUID, or unique display name; builtin:/custom: prefixes accepted",
  )
  .addOption(
    new Option(
      "--connection-id <uuid>",
      "Exact connection ID returned by connector account list",
    ).makeOptionMandatory(),
  )
  .addOption(
    new Option(
      "--callback-prompt <prompt>",
      "Start the next web chat round with this prompt after confirmation",
    ).makeOptionMandatory(),
  )
  .addHelpText(
    "after",
    `
Example:
  okou connector account switch-request github --connection-id <uuid> --callback-prompt "Continue the task with the selected GitHub account"

Notes:
  - First run okou connector account list <slug> --json and use an exact returned connectionId
  - This changes only future runs in the current web chat thread, not the current run or global default
  - Callback prompts are included in the URL; keep them concise and do not include secrets
  - Use this callback flow only when account switching is this turn's single access action
  - Return the generated URL verbatim with all query parameters, then end the current turn`,
  )
  .action(
    withErrorHandler(
      async (
        slug: string,
        options: SwitchConnectorAccountRequestOptions,
      ): Promise<void> => {
        const connectionId = options.connectionId.trim();
        if (!isUuid(connectionId)) {
          throw new Error("--connection-id must be a valid UUID");
        }
        const agentId = getOkouAgentId()?.trim();
        if (!agentId) {
          throw new Error(
            "Connector account switches require the current web chat agent",
          );
        }
        const [{ connectors }, customConnectors, agentContext] =
          await Promise.all([
            listConnectorCatalogStatus(),
            listCustomConnectors(),
            resolveConnectorDiscoveryAgentContext(agentId),
          ]);
        if (!agentContext) {
          throw new Error(
            "Connector account switches require the current web chat agent",
          );
        }
        const discoveredConnectors = connectorDiscoveryItems(
          connectors,
          customConnectors,
        );
        const connector = findConnectorBySelector(
          discoveredConnectors,
          slug,
          (item) => {
            return item.kind === "custom"
              ? {
                  kind: "custom",
                  id: item.customConnector.id,
                  slug: item.slug,
                  label: item.label,
                }
              : { kind: "builtin", slug: item.slug, label: item.label };
          },
        );
        if (!connector) {
          throw new Error(`Unknown or unavailable connector: ${slug}`, {
            cause: new Error(
              `Available connectors: ${discoveredConnectors
                .map((item) => {
                  return item.slug;
                })
                .sort()
                .join(", ")}`,
            ),
          });
        }
        if (!isConnectorDiscoveryAuthorized(connector, agentContext)) {
          throw new Error(
            `Connector ${slug} is not authorized for the current web chat agent`,
          );
        }

        const target = accountTarget(connector);
        const inspection = availableInspection(
          await inspectConnectorAccounts([{ connectionId, target }]),
          connector.slug,
          connectionId,
        );
        const origin = await getPlatformOrigin();
        const path = `/agents/${encodeURIComponent(agentId)}/connector-accounts/${encodeURIComponent(connectionId)}/select`;
        const actionUrl = new URL(path, origin);
        addTargetSearchParams(actionUrl.searchParams, target);
        const url = finalizeActionUrl(
          actionUrl,
          options.callbackPrompt,
          agentId,
        );
        const label = connectorAccountCliLabel({
          ...inspection,
          connectionId: inspection.connectionId,
        });

        console.log(
          `You can use ${label} for ${connector.label} in future runs of this chat: [Confirm account switch](${url})`,
        );
        printCallbackTurnInstruction();
      },
    ),
  );
