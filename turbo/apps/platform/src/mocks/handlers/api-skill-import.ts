import {
  SKILL_IMPORT_LIMITS,
  SKILL_IMPORT_SESSION_TTL_SECONDS,
  skillImportSessionsContract,
} from "@okouai/api-contracts/contracts/skill-import";
import { mockApi } from "../msw-contract.ts";

/**
 * The onboarding skills step opens a session and renders the prompt it
 * returns. The upload route belongs to the user's own agent, so nothing here
 * mocks it: this only hands the step a session to show.
 */
export const apiSkillImportHandlers = [
  mockApi(skillImportSessionsContract.create, ({ respond }) => {
    return respond(200, {
      uploadUrl: "https://api.okou.test/api/skill-import/skills",
      token: "vm0_skillimport_mock-session-token",
      expiresAt: new Date(
        Date.now() + SKILL_IMPORT_SESSION_TTL_SECONDS * 1000,
      ).toISOString(),
      limits: SKILL_IMPORT_LIMITS,
    });
  }),
];
