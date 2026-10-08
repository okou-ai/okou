export const API_DATABASE_SNAPSHOT = "apiDatabaseSnapshot";

declare module "vitest" {
  export interface ProvidedContext {
    apiDatabaseSnapshot: string;
  }
}
