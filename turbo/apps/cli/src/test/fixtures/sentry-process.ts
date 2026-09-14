import "../../instrument";
import { Command } from "commander";
import { instrumentCommand } from "../../sentry-command";

const prog = new Command("okou");
instrumentCommand(prog);
const command = prog.command("probe");
if (process.argv[2] === "rejection") {
  command.action(async () => {
    await Promise.resolve();
    throw new TypeError("PRIVATE_UNHANDLED_REJECTION_33940");
  });
} else {
  command.action(() => {
    throw new TypeError("PRIVATE_UNCAUGHT_EXCEPTION_33940");
  });
}
prog.parse(["probe"], { from: "user" });
