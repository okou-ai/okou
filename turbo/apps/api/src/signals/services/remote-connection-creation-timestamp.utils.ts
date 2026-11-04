import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { sshConnections } from "@okouai/db/runtime/ssh-connection";
import { sql } from "drizzle-orm";
import { iso } from "zod";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";

// IDs are reusable after deletion; preserve the creation instance's PostgreSQL
// precision instead of collapsing distinct instances to JavaScript milliseconds.
export const vncCreationTimestamp =
  sql`to_char(${vncConnections.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.mapWith(
    zodDriverValueDecoder(iso.datetime()),
  );

export const sshCreationTimestamp =
  sql`to_char(${sshConnections.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.mapWith(
    zodDriverValueDecoder(iso.datetime()),
  );
