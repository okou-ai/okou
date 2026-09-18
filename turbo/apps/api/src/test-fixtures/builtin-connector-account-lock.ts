import { connectors } from "@okouai/db/schema/connector";
import { and, eq } from "drizzle-orm";
import { holdDeferredRow } from "./pi-deferred-lock";

/** Pause an API reconnect at its account row; all resulting state is asserted through routes. */
export async function holdBuiltinConnectorAccountFixture(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
  },
  signal: AbortSignal,
) {
  return await holdDeferredRow(signal, async (tx) => {
    const [account] = await tx
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.id, args.connectorId),
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
        ),
      )
      .for("update");
    if (!account) {
      throw new Error("Expected the test-owned builtin connector account");
    }
  });
}
