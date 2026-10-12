import { runRuntimeApiSchemaCli } from "./command";

process.exitCode = await runRuntimeApiSchemaCli(process.argv.slice(2));
