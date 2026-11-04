import { strictObject, string } from "zod";

export const discordOauthProofSchema = string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const discordOauthApprovalBodySchema = strictObject({
  state: discordOauthProofSchema,
  approvalProof: discordOauthProofSchema,
});
