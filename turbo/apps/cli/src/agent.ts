import "./instrument";
import { Command } from "commander";

import { configureGlobalProxyFromEnv } from "./lib/network/proxy";
import {
  observePiCliEntryImports,
  startPiCliObservation,
} from "./lib/pi-startup-timing";

observePiCliEntryImports();

// Paired private payload. Execution of this file grants no caller authority;
// native launch and the mandatory Guest policy own that boundary.
if (process.argv[1]?.endsWith("/agent.js")) {
  const finishProxy = startPiCliObservation("cli_proxy");
  let proxyOutcome: "success" | "error" = "error";
  try {
    await configureGlobalProxyFromEnv();
    proxyOutcome = "success";
  } finally {
    finishProxy(proxyOutcome);
  }
  const finishImport = startPiCliObservation("cli_command_import");
  let importOutcome: "success" | "error" = "error";
  let commands: readonly [Command, Command];
  try {
    const [{ agentLoopCommand }, { subagentLoopCommand }] = await Promise.all([
      import("./commands/__agent-loop"),
      import("./commands/__subagent_loop__"),
    ]);
    commands = [agentLoopCommand, subagentLoopCommand];
    importOutcome = "success";
  } finally {
    finishImport(importOutcome);
  }
  await new Command("okou-agent")
    .addCommand(commands[0])
    .addCommand(commands[1])
    .parseAsync(process.argv);
}
