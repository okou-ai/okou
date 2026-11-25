export const MORNING_BRIEF_OFFICIAL_DEFINITION_NAME = "morning-brief";
/** Retained for installed identities and immutable Run provenance from before GA. */
export const INTERNAL_TEST_MORNING_BRIEF_DEFINITION_NAME =
  "internal-test-morning-brief";
export const MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES = [
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
  INTERNAL_TEST_MORNING_BRIEF_DEFINITION_NAME,
] as const;

export function isMorningBriefDefinitionName(name: string | null): boolean {
  return MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES.some((candidate) => {
    return candidate === name;
  });
}

export const MORNING_BRIEF_PREFERENCES_ROUTE = "/";
export const MORNING_BRIEF_PREFERENCES_SECTION = "preference";
export const MORNING_BRIEF_PREFERENCES_FOCUS = "morning-brief";
