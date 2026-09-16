import { Command } from "commander";
import { checkConnectorCommand } from "./check";
import { connectCommand } from "./connect";
import { listCommand } from "./list";
import { searchCommand } from "./search";
import { statusCommand } from "./status";
import { customConnectorCommand } from "./custom";
import { permissionRequestCommand } from "./permission-request";
import { connectorAccountCommand } from "./account";

export const connectorCommand = new Command()
  .name("connector")
  .description("Manage and diagnose third-party service connections")
  .addCommand(connectorAccountCommand)
  .addCommand(checkConnectorCommand)
  .addCommand(customConnectorCommand)
  .addCommand(connectCommand)
  .addCommand(listCommand)
  .addCommand(searchCommand)
  .addCommand(statusCommand)
  .addCommand(permissionRequestCommand)
  .addHelpText(
    "after",
    `
Choose a command:
  list/status   Inspect the current run's admitted accounts. Outside a run,
                list includes builtin and custom connectors; status is builtin-only.
  search        Discover builtin and custom HTTP/MCP connectors and connection guidance.
  custom        Create/update definitions and inspect org custom connector metadata.
  connect       Connect builtin connectors using manual grant values.
  check         Diagnose a failed URL or a builtin environment name.
  permission-request
                Request a diagnosed builtin permission; custom permissions use settings.

Connection and access:
  A definition describes the service and its authentication setup. Members then
  connect their own accounts, grant Agent access, and select any fine-grained
  permissions. Creating a custom definition alone does not complete these steps.
  OAuth and custom account connections use the web connection flow; search and
  custom create provide guidance for the next action.

Run context:
  Inside a run, omit --agent to use the current Agent (OKOU_AGENT_ID).
  An explicit --agent must match the current Agent.
  Agent selection does not replace the accounts admitted to that run. Missing
  run account context means unavailable; it does not select another account.
  Outside a run, commands exposing --agent can inspect that Agent's authorization.

Selectors:
  Use a full slug, a custom UUID, or an exact unique display name.
  Qualify a target with builtin:<slug-or-name> or custom:<uuid-slug-or-name>.
  Full identifiers take precedence over display names; ambiguous matches are rejected.
  Each command retains its supported connector types. Use UUIDs for stable custom automation.

Account selection:
  Inspect the account used by this Run with connector status <slug> --json, and
  list alternatives with connector account list <slug> --json. Use only an
  exact returned connectionId; never invent one or reuse it for another connector.
  Account switches affect future runs in the current chat, not this Run or a
  global default.

Permission recovery:
  Diagnose the exact failed URL and method with connector check before trying
  ad hoc fixes or requesting access. Check okou whoami --permissions first,
  plan only the concrete operations needed now, and use the exact
  permission-request command emitted for a deny/ask result. Provider OAuth
  scope names are not Okou permissions.
  Use a callback only when the current turn has exactly one access action. For
  multiple actions, return ordinary links separately and wait for all of them.
  Always return action URLs verbatim with every query parameter.

Examples:
  okou connector status builtin:github
  okou connector account list github --json
  okou connector custom status "Acme Search"
  okou connector check --connector custom:_acme-search --url https://api.acme.test/items

Use each command's --help for its supported selectors and callback limits.`,
  );
