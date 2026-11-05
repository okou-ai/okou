import process from "node:process";

process.stderr.write("diagnostic before the failure record\n");
process.emitWarning("migration CLI regression warning", {
  code: "MIGRATION_CLI_TEST",
});
process.once("beforeExit", () => {
  process.stderr.write("diagnostic after the failure record\n");
});
