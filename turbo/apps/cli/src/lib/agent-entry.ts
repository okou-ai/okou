import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

/** Ordinary CLI forwarding remains workload execution, including in a Guest. */
export function agentEntryCommand(name: string): Command {
  return new Command(name)
    .description(
      name === "__agent-loop"
        ? "Internal sandbox Pi agent loop"
        : "Internal child Pi session loop",
    )
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (_options, command: Command) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./agent/agent.js", import.meta.url)),
          name,
          ...command.args,
        ],
        { stdio: "inherit", env: process.env },
      );
      const forward = (signal: NodeJS.Signals) => {
        child.kill(signal);
      };
      const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
      const handlers = signals.map((signal) => {
        return {
          signal,
          handler: () => {
            forward(signal);
          },
        };
      });
      for (const { signal, handler } of handlers) process.on(signal, handler);
      let outcome: { code: number | null; signal: NodeJS.Signals | null };
      try {
        outcome = await new Promise<typeof outcome>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => {
            resolve({ code, signal });
          });
        });
      } finally {
        for (const { signal, handler } of handlers)
          process.off(signal, handler);
      }
      if (outcome.signal) process.kill(process.pid, outcome.signal);
      else if (outcome.code !== null) process.exitCode = outcome.code;
      else throw new Error("Private Agent exited without a terminal status.");
    });
}
