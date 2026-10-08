import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const AGENT_SETUP_RESPONSIBILITY_MAX_CHARS = 4000;
export const AGENT_SETUP_PROMPT_MAX_CHARS = 8000;

export const agentSetupPromptRequestSchema = z
  .object({
    agentName: z.string().trim().min(1).max(200),
    responsibility: z
      .string()
      .trim()
      .min(1)
      .max(AGENT_SETUP_RESPONSIBILITY_MAX_CHARS),
  })
  .strict();

export const agentSetupPromptResponseSchema = z
  .object({
    prompt: z.string().trim().min(1).max(AGENT_SETUP_PROMPT_MAX_CHARS),
  })
  .strict();

export type AgentSetupPromptRequest = z.infer<
  typeof agentSetupPromptRequestSchema
>;
export type AgentSetupPromptResponse = z.infer<
  typeof agentSetupPromptResponseSchema
>;

export const agentSetupPromptsContract = c.router({
  create: {
    method: "POST",
    path: "/api/agent-setup-prompts",
    headers: authHeadersSchema,
    body: agentSetupPromptRequestSchema,
    responses: {
      200: agentSetupPromptResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary:
      "Draft the first message asking a new Agent to adopt its responsibility",
  },
});
