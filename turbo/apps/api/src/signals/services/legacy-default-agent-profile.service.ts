import { randomUUID } from "node:crypto";
import { orgCache } from "@okouai/db/schema/org-cache";
import { eq } from "drizzle-orm";
import {
  SINGLE_AGENT_SEED_INSTRUCTIONS,
  SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE,
} from "@okouai/core/seed-instructions";
import { legacyAgentApiProfiles } from "@okouai/db/schema/legacy-agent-api-profile";
import { defaultProfileCondition } from "./agent-data.service";
import {
  DEFAULT_AGENT_AVATAR_URL,
  DEFAULT_AGENT_DISPLAY_NAME,
  DEFAULT_AGENT_SOUND,
  DEFAULT_AGENT_NAME,
} from "./default-agent-profile";
import { command } from "ccstate";
import { writeDb$ } from "../external/db";

// Legacy profile-management clients expect a public default profile after workspace creation.
export const ensureLegacyDefaultAgentProfile$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const findShared = () => {
      return db
        .select({ id: legacyAgentApiProfiles.id })
        .from(legacyAgentApiProfiles)
        .where(defaultProfileCondition(orgId))
        .limit(1);
    };
    const [existing] = await findShared();
    signal.throwIfAborted();
    if (existing) {
      return;
    }
    const [workspace] = await db
      .select({ creator: orgCache.createdBy })
      .from(orgCache)
      .where(eq(orgCache.orgId, orgId))
      .limit(1);
    signal.throwIfAborted();
    if (!workspace?.creator) {
      return;
    }
    const [created] = await db
      .insert(legacyAgentApiProfiles)
      .values({
        id: randomUUID(),
        orgId,
        owner: workspace.creator,
        name: DEFAULT_AGENT_NAME,
        visibility: "public",
        displayName: DEFAULT_AGENT_DISPLAY_NAME,
        instructions: SINGLE_AGENT_SEED_INSTRUCTIONS,
        instructionsBundle: SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE,
        sound: DEFAULT_AGENT_SOUND,
        avatarUrl: DEFAULT_AGENT_AVATAR_URL,
      })
      .onConflictDoNothing()
      .returning({ id: legacyAgentApiProfiles.id });
    signal.throwIfAborted();
    if (!created && !(await findShared()).length) {
      throw new Error("Default Agent profile name is already in use");
    }
  },
);
