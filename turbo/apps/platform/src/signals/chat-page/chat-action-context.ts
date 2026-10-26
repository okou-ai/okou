import { uuid } from "zod";

export interface ChatActionContext {
  readonly agentId: string;
  readonly threadId: string;
}

export type ChatActionParseResult<T> =
  | { readonly status: "unrelated" }
  | { readonly status: "invalid"; readonly originalUrl: string }
  | { readonly status: "valid"; readonly descriptor: T };

const chatActionIdSchema = uuid();

export function chatActionIdMatches(
  claimedId: string,
  authoritativeId: string,
): boolean {
  const claimed = chatActionIdSchema.safeParse(claimedId);
  const authoritative = chatActionIdSchema.safeParse(authoritativeId);
  return (
    claimed.success &&
    authoritative.success &&
    claimed.data.toLowerCase() === authoritative.data.toLowerCase()
  );
}
