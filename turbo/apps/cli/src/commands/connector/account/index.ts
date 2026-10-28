import { Command } from "commander";

import { listConnectorAccountsCommand } from "./list";
import { switchConnectorAccountRequestCommand } from "./switch-request";
import {
  showConnectorAccountCommand,
  updateConnectorAccountCommand,
  setDefaultConnectorAccountCommand,
  connectorAccountImpactCommand,
  disconnectConnectorAccountCommand,
} from "./manage";

export const connectorAccountCommand = new Command()
  .name("account")
  .description("Inspect and manage member connector accounts")
  .addCommand(showConnectorAccountCommand)
  .addCommand(updateConnectorAccountCommand)
  .addCommand(setDefaultConnectorAccountCommand)
  .addCommand(connectorAccountImpactCommand)
  .addCommand(disconnectConnectorAccountCommand)
  .addCommand(listConnectorAccountsCommand)
  .addCommand(switchConnectorAccountRequestCommand);
