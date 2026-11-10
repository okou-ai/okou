/**
 * Coordinates for the thread this run belongs to. The prior-round transcript is
 * only replayed when the CLI session cannot carry it, so this block is what
 * lets a run reach the rest of the conversation on demand instead.
 */
export function buildCurrentThreadContext(threadId: string): string {
  return [
    "# This Chat Thread",
    "",
    `- CHAT_THREAD_ID: ${threadId}`,
    "",
    "Chat history files are temporary caches. Store them under `/tmp`, outside personal memory. If removed, synchronize again.",
    "",
    "Reading this thread, each through OKOU_TOKEN:",
    `- \`okou chat messages --thread-id ${threadId} --output-dir /tmp/okou-chat-history\` synchronizes the raw snapshot and hot events into \`/tmp/okou-chat-history/${threadId}/\` (chat-event:read)`,
    `- \`rg -n '"seqId":<SEQ_ID>' /tmp/okou-chat-history/${threadId}/\` finds an event in the synchronized history`,
    '- `okou search "<query>" --source agent-session` prints both the Claude Code and Codex session-file locations so you can analyze those files directly',
  ].join("\n");
}
