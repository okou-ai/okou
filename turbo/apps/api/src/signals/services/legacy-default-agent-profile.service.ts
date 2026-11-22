import { randomUUID } from "node:crypto";
import { publishContentBundle$ } from "./content-bundle.service";
import { SEED_INSTRUCTIONS } from "@okouai/core/seed-instructions";
import { agents } from "@okouai/db/schema/agent";
import { defaultProfileCondition } from "./agent-data.service";
import {
  DEFAULT_AGENT_AVATAR_URL,
  DEFAULT_AGENT_DISPLAY_NAME,
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_SOUND,
} from "./default-agent-profile";
import { command } from "ccstate";
import { writeDb$ } from "../external/db";

// Legacy profile-management clients expect a public default profile after workspace creation.
export const ensureLegacyDefaultAgentProfile$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly ownerUserId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const findShared = () => {
      return db
        .select({ id: agents.id })
        .from(agents)
        .where(defaultProfileCondition(args.orgId))
        .limit(1);
    };
    const [existing] = await findShared();
    signal.throwIfAborted();
    if (existing) {
      return;
    }
    const instructionsBundle = await set(
      publishContentBundle$,
      [
        {
          path: "instructions.md",
          content: Buffer.from(SEED_INSTRUCTIONS, "utf8"),
        },
      ],
      signal,
    );
    signal.throwIfAborted();
    const [created] = await db
      .insert(agents)
      .values({
        id: randomUUID(),
        orgId: args.orgId,
        owner: args.ownerUserId,
        name: DEFAULT_AGENT_NAME,
        visibility: "public",
        displayName: DEFAULT_AGENT_DISPLAY_NAME,
        instructions: SEED_INSTRUCTIONS,
        instructionsBundle,
        sound: DEFAULT_AGENT_SOUND,
        avatarUrl: DEFAULT_AGENT_AVATAR_URL,
      })
      .onConflictDoNothing()
      .returning({ id: agents.id });
    signal.throwIfAborted();
    if (!created && !(await findShared()).length) {
      throw new Error("Default Agent profile name is already in use");
    }
  },
);
