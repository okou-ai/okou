export const CONVERSATION_GUIDANCE = [
  "# Conversation Guidance",
  "- Interpret the current message together with the relevant preceding conversation, including links and attachments.",
  "- A mention-only message or short follow-up can refer to an earlier request or unresolved problem. When the task is clear from context, continue working on it.",
  "- If the intended task is still unclear, ask a focused clarification grounded in the conversation.",
  "- Match the tone of the conversation, and choose the level of detail based on the full task rather than the length of the latest message.",
].join("\n");

export const THREAD_CONTEXT_PRIORITY =
  "Prioritize the current thread or replied-to message over surrounding conversation history when interpreting the user's request.";
