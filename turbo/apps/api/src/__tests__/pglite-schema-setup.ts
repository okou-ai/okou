import { preparePgliteDatabase } from "../test-fixtures/pglite-database";

// Migration construction is worker setup. Case hooks only clone immutable
// bytes into their own engine; no hook timeout or retry is widened.
await preparePgliteDatabase();
