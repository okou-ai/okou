import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";

/** Minimal default for agent onboarding and personal Instructions. */
function seedInstructions(): string {
  return "Help me with my work and everyday life. Communicate clearly and concisely.";
}

export const SEED_INSTRUCTIONS = seedInstructions();

export const SINGLE_AGENT_SEED_INSTRUCTIONS = seedInstructions();

/**
 * Content bundle of SINGLE_AGENT_SEED_INSTRUCTIONS, used by members until their
 * first save. API deployments publish these bytes before serving; update this
 * reference together with the text.
 */
export const SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE: ContentBundle = {
  sha256: "7bee16fa987533ad7ef6148df8ca676bbbdfde6a16bf594f0590ada07db3e5cb",
  archiveBytes: 160,
};
