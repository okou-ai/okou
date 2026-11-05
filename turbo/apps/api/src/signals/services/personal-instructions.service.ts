import { instructions } from "@okouai/db/schema/instructions";
import { SINGLE_AGENT_SEED_INSTRUCTIONS } from "@okouai/core/seed-instructions";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { writeDb$ } from "../external/db";
import { publishContentBundle$ } from "./content-bundle.service";

/** Publish before insertion; the business key arbitrates concurrent first use. */
export const initializePersonalInstructions$ = command(
  async (
    { set },
    scope: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const condition = and(
      eq(instructions.orgId, scope.orgId),
      eq(instructions.userId, scope.userId),
    );
    const [existing] = await db
      .select()
      .from(instructions)
      .where(condition)
      .limit(1);
    signal.throwIfAborted();
    if (existing) {
      return existing;
    }
    const bundle = await set(
      publishContentBundle$,
      [
        {
          path: "instructions.md",
          content: Buffer.from(SINGLE_AGENT_SEED_INSTRUCTIONS, "utf8"),
        },
      ],
      signal,
    );
    const [inserted] = await db
      .insert(instructions)
      .values({ ...scope, content: SINGLE_AGENT_SEED_INSTRUCTIONS, bundle })
      .onConflictDoNothing({
        target: [instructions.orgId, instructions.userId],
      })
      .returning();
    signal.throwIfAborted();
    if (inserted) {
      return inserted;
    }
    const [retained] = await db
      .select()
      .from(instructions)
      .where(condition)
      .limit(1);
    signal.throwIfAborted();
    if (!retained) {
      throw new Error(
        "Personal Instructions disappeared during initialization",
      );
    }
    return retained;
  },
);

/** Account/org erasure is separate from ordinary membership departure. */
export const deletePersonalInstructions$ = command(
  async (
    { set },
    owner:
      | { readonly kind: "user"; readonly userId: string }
      | { readonly kind: "organization"; readonly orgId: string },
    signal: AbortSignal,
  ) => {
    await set(writeDb$)
      .delete(instructions)
      .where(
        owner.kind === "user"
          ? eq(instructions.userId, owner.userId)
          : eq(instructions.orgId, owner.orgId),
      );
    signal.throwIfAborted();
  },
);
