import { instructions } from "@okouai/db/schema/instructions";
import {
  SINGLE_AGENT_SEED_INSTRUCTIONS,
  SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE,
} from "@okouai/core/seed-instructions";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { writeDb$ } from "../external/db";
import { publishContentBundle$ } from "./content-bundle.service";

/** Deployments publish the default before serving; requests only reference it. */
export const publishDefaultPersonalInstructions$ = command(
  async ({ set }, signal: AbortSignal) => {
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
    if (
      bundle.sha256 !== SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE.sha256 ||
      bundle.archiveBytes !== SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE.archiveBytes
    ) {
      throw new Error(
        `SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE must be ${JSON.stringify(bundle)}`,
      );
    }
    return bundle;
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
