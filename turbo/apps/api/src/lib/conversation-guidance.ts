export type ConversationVoiceMode = "transcribe" | "native-audio";

export function voiceModeForFramework(
  framework: string | null | undefined,
): ConversationVoiceMode {
  return framework === "antigravity" ? "native-audio" : "transcribe";
}

export function buildConversationGuidance(options?: {
  readonly voiceMode?: ConversationVoiceMode;
}): string {
  const voiceGuidance =
    options?.voiceMode === "native-audio"
      ? "- When Okou supplies voice clip file IDs, download each clip with `okou web download-file <file-id>` and read each downloaded audio file in recording order with `read_file` to listen directly before sending any visible reply or progress update. Do not call `okou transcribe`. Answer the request directly if possible. If further work is needed, make the first update about that work."
      : "- When Okou supplies voice clip file IDs, use `okou transcribe` on those clips before sending any visible reply or progress update. Answer the request directly if possible. If further work is needed, make the first update about that work.";
  return [
    "# Conversation Guidance",
    "- Interpret the current message together with the relevant preceding conversation, including links and attachments.",
    voiceGuidance,
    "- A mention-only message or short follow-up can refer to an earlier request or unresolved problem. When the task is clear from context, continue working on it.",
    "- If the intended task is still unclear, ask a focused clarification grounded in the conversation.",
    "- Match the tone of the conversation, and choose the level of detail based on the full task rather than the length of the latest message.",
  ].join("\n");
}

export const CONVERSATION_GUIDANCE = buildConversationGuidance();

export const THREAD_CONTEXT_PRIORITY =
  "Prioritize the current thread or replied-to message over surrounding conversation history when interpreting the user's request.";
