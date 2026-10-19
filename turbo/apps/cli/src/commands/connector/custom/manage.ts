import { Command } from "commander";
import {
  getCustomConnector,
  deleteCustomConnector,
  listConnectorAccountSummaries,
} from "../../../lib/api/domains/connectors";
import { decodeSandboxTokenPayload } from "../../../lib/api/sandbox-token";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { resolveCustomConnectorId } from "../custom-connector-selector";
import { customConnectorMetadata } from "../management";
import { memberConnectorFacts } from "../member-status";

export const showCustomConnectorCommand = new Command("show")
  .description(
    "Show whitelisted custom HTTP/MCP definition and member connection metadata",
  )
  .argument(
    "<selector>",
    "Custom UUID, slug, or exact unique name; custom: prefix accepted",
  )
  .option("--json", "Print whitelisted metadata as JSON")
  .action(
    withErrorHandler(async (selector: string, options: { json?: boolean }) => {
      const connector = await getCustomConnector(
        await resolveCustomConnectorId(selector),
      );
      if (!connector) throw new Error("Custom connector is unavailable.");
      const summaries = await listConnectorAccountSummaries();
      if (!options.json) console.log("Custom connector metadata:");
      console.log(
        JSON.stringify(
          {
            ...customConnectorMetadata(connector),
            ...memberConnectorFacts(connector, summaries),
          },
          null,
          2,
        ),
      );
    }),
  );

export const deleteCustomConnectorCommand = new Command("delete")
  .description(
    "Delete an org custom connector definition and its accounts (organization admin required)",
  )
  .argument(
    "<selector>",
    "Custom UUID, slug, or exact unique name; custom: prefix accepted",
  )
  .option("--json", "Print deleted definition ID as JSON")
  .action(
    withErrorHandler(async (selector: string, options: { json?: boolean }) => {
      const payload = decodeSandboxTokenPayload();
      if (payload && !payload.capabilities.includes("connector:write"))
        throw new Error(
          "Custom connector deletion is not enabled for this agent run",
        );
      const id = await resolveCustomConnectorId(selector);
      await deleteCustomConnector(id);
      if (options.json)
        console.log(JSON.stringify({ deletedCustomConnectorId: id }, null, 2));
      else console.log(`Custom connector deleted: ${id}`);
    }),
  );
