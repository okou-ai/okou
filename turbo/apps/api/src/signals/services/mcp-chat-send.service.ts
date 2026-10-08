import { randomUUID } from "node:crypto";
import type {
  McpSendChatMessageInput,
  McpSendChatMessageOutput,
  McpChatMutationResult,
} from "@okouai/api-contracts/contracts/mcp-chat-mutations";
import { command } from "ccstate";
import type { ApiOrgRole } from "../../types/auth";
import { sendNormalEvent$ } from "./chat-events.command";
import { mcpClientDisplayName } from "./mcp-client-display-name.service";

interface Principal {
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole: ApiOrgRole;
  readonly clientId: string;
}

/** Identity and text adaptation only; acceptance, ownership and dispatch are Web's. */
export const sendMcpChatMessage$ = command(
  async (
    { set },
    {
      principal,
      input,
    }: {
      readonly principal: Principal;
      readonly input: McpSendChatMessageInput;
    },
    signal: AbortSignal,
  ): Promise<McpChatMutationResult<McpSendChatMessageOutput>> => {
    const clientName = await mcpClientDisplayName(principal.clientId, signal);
    signal.throwIfAborted();
    const eventId = randomUUID();
    const sent = await set(
      sendNormalEvent$,
      {
        auth: { tokenType: "oauth", ...principal },
        mcpSource: {
          type: "source",
          kind: "mcp",
          clientId: principal.clientId,
          ...(clientName === undefined ? {} : { clientName }),
        },
        userId: principal.userId,
        orgId: principal.orgId,
        body: {
          ...input,
          clientEventId: eventId,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: input.prompt }],
          },
          hasTextContent: true,
        },
      },
      signal,
    );
    if (sent.status !== 201) {
      return {
        kind: "error",
        code: sent.body.error.code,
        message: sent.body.error.message,
        retryable: false,
      };
    }
    return {
      kind: "ok",
      data: {
        threadId: sent.body.threadId,
        eventId,
        createdAt: sent.body.createdAt,
      },
    };
  },
);
