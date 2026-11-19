import { Command } from "commander";
import { checkConnectorCommand } from "./check";
import { connectCommand } from "./connect";
import { listCommand } from "./list";
import { searchCommand } from "./search";
import { statusCommand } from "./status";
import { customConnectorCommand } from "./custom";
import { permissionRequestCommand } from "./permission-request";
import { connectorAccountCommand } from "./account";
import { connectorOAuthCommand } from "./oauth";

export const connectorCommand = new Command()
  .name("connector")
  .description("Manage and diagnose third-party service connections")
  .addCommand(connectorAccountCommand)
  .addCommand(checkConnectorCommand)
  .addCommand(customConnectorCommand)
  .addCommand(connectCommand)
  .addCommand(connectorOAuthCommand)
  .addCommand(listCommand)
  .addCommand(searchCommand)
  .addCommand(statusCommand)
  .addCommand(permissionRequestCommand)
  .addHelpText(
    "after",
    `
Account scope
  Inside a Run, list/status report the exact accounts used by the Run.
  Outside a Run, they report your saved accounts. Use connector custom status
  for a custom definition and its saved-account status.
  Use account list <selector> --json for exact connection IDs and Chat
  allowance. Switch an enabled account with account switch. Use switch-request
  for owner approval of a disabled account.

Permission recovery
  Firewall permissions are shared across your Chats and accounts. Inspect
  whoami --permissions and diagnose the failed URL and method with connector
  check. Use the permission-request command emitted for a deny/ask result.
  Custom connector permissions are managed in Connectors settings.
  Add a callback only for one access action in the current Web Chat.
  Use ordinary links for multiple confirmations. Return each URL verbatim.

Examples
  okou connector status builtin:github
  okou connector account list github --json
  okou connector custom status "Acme Search"
  okou connector check --connector custom:_acme-search --url https://api.acme.test/items

Use each subcommand's --help for its selectors, input and output.
`,
  );
