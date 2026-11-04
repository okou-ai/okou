import { Command, Option } from "commander";
import { connectorAccountTargetKey } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  listConnectorCatalog,
  listCustomConnectors,
} from "../../../lib/api/domains/connectors";
import {
  chatConnectorAccountsEnabled,
  listRunConnectorAccounts,
  selectRunConnectorAccount,
} from "../../../lib/api/domains/run-connector-accounts";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { isUuid } from "../../../lib/utils/uuid";
import { connectorDiscoveryItems } from "../discovery";
import { findConnectorBySelector } from "../connector-selector";
import { syncRunConnectorAccount } from "./switch-rpc";

export const switchConnectorAccountCommand = new Command()
  .name("switch")
  .description(
    "Use an already allowed account now and save this Chat's current selection",
  )
  .argument("<selector>", "Connector slug, custom UUID, or unique display name")
  .addOption(
    new Option(
      "--connection-id <uuid>",
      "Exact connectionId discovered for this connector",
    ).makeOptionMandatory(),
  )
  .option("--json", "Output the selected account as JSON")
  .action(
    withErrorHandler(
      async (
        selector: string,
        options: { connectionId: string; json?: boolean },
      ) => {
        if (!chatConnectorAccountsEnabled())
          throw new Error(
            "Chat connector account switching is not enabled for this Run",
          );
        const connectionId = options.connectionId.trim();
        if (!isUuid(connectionId))
          throw new Error("--connection-id must be a valid UUID");
        const [catalog, custom, inventory] = await Promise.all([
          listConnectorCatalog(),
          listCustomConnectors(),
          listRunConnectorAccounts(),
        ]);
        const connector = findConnectorBySelector(
          connectorDiscoveryItems(catalog.connectors, custom),
          selector,
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
        if (!connector) throw new Error(`Unknown connector: ${selector}`);
        const target =
          connector.kind === "catalog"
            ? { kind: "builtin" as const, connectorSlug: connector.slug }
            : {
                kind: "custom" as const,
                customConnectorId: connector.customConnector.id,
              };
        const account = inventory.accounts.find((item) => {
          return (
            item.connectionId === connectionId &&
            connectorAccountTargetKey(item.target) ===
              connectorAccountTargetKey(target)
          );
        });
        if (!account)
          throw new Error(
            "Account was not found for this connector in the current Chat",
          );
        if (!account.enabled)
          throw new Error(
            `Account is not allowed in this Chat. Request owner approval with okou connector account switch-request ${selector} --connection-id ${connectionId} --callback-prompt <prompt>`,
          );
        const selected = await selectRunConnectorAccount({
          target,
          connectionId,
        });
        await syncRunConnectorAccount(selected);
        console.log(
          options.json
            ? JSON.stringify({ ...selected, context: "run", selected: true })
            : `Using ${account.displayName ?? connectionId} for ${connector.label}. Saved as this Chat's current account for subsequent Runs.`,
        );
      },
    ),
  );
