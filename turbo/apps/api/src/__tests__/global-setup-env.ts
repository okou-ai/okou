import { apiTestEnvironment } from "./test-environment";
import { apiTestDatabaseUrl } from "./test-database-url";
import { singleton } from "../lib/singleton";

// globalSetup runs outside Vitest workers, before env-stub can be loaded.
const previousEnvironment = singleton(() => {
  const environment = {
    ...apiTestEnvironment,
    DATABASE_URL: apiTestDatabaseUrl(
      process.env.DATABASE_URL,
      process.env.PGOPTIONS,
    ).toString(),
  };
  const previous = new Map(
    Object.keys(environment).map((key) => {
      return [key, process.env[key]] as const;
    }),
  );
  Object.assign(process.env, environment);
  return previous;
});
previousEnvironment();

export function restoreGlobalSetupEnvironment(): void {
  for (const [key, value] of previousEnvironment()) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
