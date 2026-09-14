import { AsyncLocalStorage } from "node:async_hooks";
import type { Command } from "commander";

interface CommandDiagnostic {
  phase: "startup" | "parse" | "command";
  operation?: string;
}

const invocation = new AsyncLocalStorage<CommandDiagnostic>();
const failedInvocations = new WeakMap<object, CommandDiagnostic>();
const registeredPrograms = new WeakSet<Command>();

export function getCommandDiagnostic(error: unknown): CommandDiagnostic {
  return (
    invocation.getStore() ??
    (error instanceof Object ? failedInvocations.get(error) : undefined) ?? {
      phase: "startup",
    }
  );
}

function rememberFailure(error: unknown, diagnostic: CommandDiagnostic) {
  if (error instanceof Object) {
    // A synchronous throw leaves the async context before the SDK's global
    // handler runs. Keep only its command metadata, without changing the error.
    failedInvocations.set(error, { ...diagnostic });
  }
}

export function instrumentCommand(prog: Command): void {
  if (registeredPrograms.has(prog)) return;
  registeredPrograms.add(prog);

  prog.hook("preAction", (_command, action) => {
    const diagnostic = invocation.getStore();
    if (!diagnostic) return;
    const names: string[] = [];
    for (let command: Command | null = action; command !== prog; ) {
      if (!command?.parent || !command.parent.commands.includes(command)) {
        return;
      }
      names.unshift(command.name());
      command = command.parent;
    }
    diagnostic.phase = "command";
    diagnostic.operation = names.join(" ");
  });

  // Commander has no before-parse hook: preAction misses help, unknown tokens
  // and option parsing failures. Scope both public entry points per invocation.
  const parse = prog.parse;
  prog.parse = (...args) => {
    const diagnostic: CommandDiagnostic = { phase: "parse" };
    return invocation.run(diagnostic, () => {
      try {
        return parse.apply(prog, args);
      } catch (error) {
        rememberFailure(error, diagnostic);
        throw error;
      }
    });
  };

  const parseAsync = prog.parseAsync;
  prog.parseAsync = (...args) => {
    const diagnostic: CommandDiagnostic = { phase: "parse" };
    return invocation.run(diagnostic, async () => {
      try {
        return await parseAsync.apply(prog, args);
      } catch (error) {
        rememberFailure(error, diagnostic);
        throw error;
      }
    });
  };
}
