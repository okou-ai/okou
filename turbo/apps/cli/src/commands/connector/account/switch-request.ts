import {
  connectorAccountTargetKey,
  type ConnectorAccountTarget,
  type ConnectorAccountInspectionResult,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { Command, Option } from "commander";

import {
  inspectConnectorAccounts,
  listConnectorCatalog,
  listCustomConnectors,
} from "../../../lib/api/domains/connectors";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { getOkouAgentId } from "../../../lib/okou-env";
import { listRunConnectorAccounts } from "../../../lib/api/domains/run-connector-accounts";
import { isUuid } from "../../../lib/utils/uuid";
import { getPlatformOrigin } from "../../../lib/platform-url";
import { connectorAccountCliLabel } from "../account-label";
import {
  CALLBACK_PROMPT_GUIDANCE,
  CALLBACK_PROMPT_MAX_LENGTH,
  finalizeActionUrl,
  printCallbackTurnInstruction,
} from "../action-url";
import {
  connectorDiscoveryItems,
  connectorDiscoveryTarget,
} from "../discovery";
import { findConnectorBySelector } from "../connector-selector";

interface SwitchConnectorAccountRequestOptions {
  readonly connectionId: string;
  readonly callbackPrompt: string;
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
  results: readonly ConnectorAccountInspectionResult[],
  connectorSlug: string,
  connectionId: string,
): Extract<ConnectorAccountInspectionResult, { kind: "available" }> {
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
    "Ask the owner to allow and select one exact account in this Chat",
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
      `Start the next web chat round with this prompt after confirmation (max ${CALLBACK_PROMPT_MAX_LENGTH} characters)`,
    ).makeOptionMandatory(),
  )
  .addHelpText(
    "after",
    `
Example:
  okou connector account switch-request github --connection-id <uuid> --callback-prompt "Continue the task with the selected GitHub account"

Notes:
  - First run okou connector account list <slug> --json and use an exact returned connectionId
  - Owner confirmation allows and selects this exact account in the current Chat
  - ${CALLBACK_PROMPT_GUIDANCE}
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
            "Connector account switches require the current web chat execution context",
          );
        }
        const [{ connectors }, customConnectors, inventory] = await Promise.all(
          [
            listConnectorCatalog(),
            listCustomConnectors(),
            listRunConnectorAccounts(),
          ],
        );
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
        const target = connectorDiscoveryTarget(connector);
        const targetKey = connectorAccountTargetKey(target);
        if (
          !inventory.accounts.some((account) => {
            return (
              account.connectionId === connectionId &&
              connectorAccountTargetKey(account.target) === targetKey
            );
          })
        ) {
          throw new Error(
            `Connector account ${connectionId} is unavailable for ${connector.slug}`,
          );
        }
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
          `Allow and select ${label} for ${connector.label} in this Chat: [Confirm account switch](${url})`,
        );
        printCallbackTurnInstruction();
      },
    ),
  );
