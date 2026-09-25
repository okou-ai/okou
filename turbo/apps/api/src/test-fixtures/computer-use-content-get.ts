import { computerUseCommands } from "@okouai/db/schema/computer-use-host";
import { eq } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { db } from "../lib/db";
/**
 * Infrastructure exception: every current public completion offloads a valid
 * image data URL before persistence, while the production reader deliberately
 * retains valid legacy inline rows. This creates one exact historical shape;
 * the bytes are still observed only through the authenticated HTTP endpoint.
 */
export async function createLegacyInlineScreenshotFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly hostId: string;
  readonly screenshot: string;
  readonly createdAt: Date;
}): Promise<{ readonly commandId: string }> {
  const [created] = await db()
    .insert(computerUseCommands)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      hostId: args.hostId,
      kind: "app.state",
      status: "succeeded",
      payload: { app: "Safari" },
      result: {
        snapshotId: "legacy_inline_fixture",
        screenshot: args.screenshot,
      },
      timeoutMs: 60_000,
      createdAt: args.createdAt,
      claimedAt: args.createdAt,
      completedAt: args.createdAt,
      updatedAt: args.createdAt,
    })
    .returning({ id: computerUseCommands.id });
  if (!created) {
    throw new Error("Expected the legacy inline screenshot fixture");
  }
  onTestFinished(async () => {
    await db()
      .delete(computerUseCommands)
      .where(eq(computerUseCommands.id, created.id));
  });
  return { commandId: created.id };
}
