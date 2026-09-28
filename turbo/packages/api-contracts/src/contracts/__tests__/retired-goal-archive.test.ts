import { describe, expect, it } from "vitest";
import { chatEventFromRow } from "../chat-event-row-projection";
import { chatEventRowSchema } from "../chat-event-rows";
import { visiblePiMemoryCitationText } from "../pi-memory-citations";
import {
  isRetiredGoalArchiveRow,
  visibleChatEventRowContent,
} from "../retired-goal-archive";

const goalId = "00000000-0000-4000-8000-000000000001";
function notice(status: string, objective: string): string {
  const explanation =
    status === "active"
      ? "Retirement changed this Goal from active to paused; this does not mark the objective complete."
      : "The recorded status is preserved; retirement does not mark the objective complete.";
  return `Okou Goal retired.\nGoal ID: ${goalId}\nOriginal recorded status: ${status}\n${explanation}\n\nFull original objective:\n${objective}`;
}
function source(content: string) {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    chatThreadId: "00000000-0000-4000-8000-000000000003",
    eventType: "output.message",
    runId: null,
    revokesEventId: null,
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId: 2,
    createdAt: "2026-09-09T00:00:00.000Z",
    payload: { content },
  };
}
const objectives = [
  "Before <oai-mem-citation>USER OBJECTIVE CONTENT</oai-mem-citation> after",
  "Explain <oai-mem-citation> and retain the rest of this objective",
  "Keep <oai-mem-cit",
  "Keep </oai-mem-citation> and later text",
  "Inline `<oai-mem-citation>` remains exact",
  "Inline `<oai-mem-citation>literal</oai-mem-citation>`",
  "```xml\n<oai-mem-citation>\nfenced literal\n```\nafter",
  "```\n<oai-mem-citation>fenced</oai-mem-citation>\n```",
  " \n完整目标 🧭 e\u0301\t\r\n'quoted' \"double\"\n\n",
  notice("active", "nested <oai-mem-citation>arbitrary suffix"),
  "",
];

describe.each(["active", "paused", "blocked", "complete"])(
  "1094 %s history",
  (status) => {
    it.each(objectives)(
      "preserves the literal objective %j through raw wire projection",
      (objective) => {
        const content = notice(status, objective);
        const raw = source(content);
        const row = chatEventRowSchema.parse(JSON.parse(JSON.stringify(raw)));
        expect(chatEventFromRow(row)?.content).toBe(content);
        expect(row).toStrictEqual(raw);
      },
    );
  },
);

describe("1094 provenance and grammar boundary", () => {
  const content = notice(
    "active",
    "Before <oai-mem-citation>private</oai-mem-citation> after",
  );
  it.each([
    { runId: goalId },
    { revokesEventId: goalId },
    { contextType: "web" },
    { contextId: goalId },
    { runEventSequenceNumber: 0 },
    { runEventId: goalId },
    { eventType: "output.followups" },
    { payload: { content, error: "extra leaf" } },
  ])("retains citation filtering with other provenance %j", (overrides) => {
    const row = chatEventRowSchema.parse({ ...source(content), ...overrides });
    expect(chatEventFromRow(row)?.content).toBe(
      visiblePiMemoryCitationText(content),
    );
  });
  it.each([
    content.replace(goalId, "not-a-uuid"),
    content.replace("status: active", "status: paused"),
    content.replace("status: active", "status: unknown"),
    content.replace("\n\nFull original", "\nFull original"),
    content.replace("Full original objective:", "Original objective:"),
    content.replaceAll("\n", "\r\n"),
    `prefix\n${content}`,
    "Okou Goal retired.\n<oai-mem-citation>ordinary assistant text",
  ])("keeps unknown formats on the ordinary projection %j", (text) => {
    expect(
      chatEventFromRow(chatEventRowSchema.parse(source(text)))?.content,
    ).toBe(visiblePiMemoryCitationText(text));
  });
  it("requires every raw provenance field and exactly the content payload", () => {
    for (const field of [
      "runId",
      "revokesEventId",
      "contextType",
      "contextId",
      "runEventSequenceNumber",
      "runEventId",
    ]) {
      const incomplete = Object.fromEntries(
        Object.entries(source(content)).filter(([key]) => {
          return key !== field;
        }),
      );
      expect(isRetiredGoalArchiveRow(incomplete)).toBe(false);
    }
    expect(
      isRetiredGoalArchiveRow({
        ...source(content),
        payload: { content, unknown: null },
      }),
    ).toBe(false);
  });

  it("checks original payload keys before a decoder can discard them", () => {
    const payload: unknown = Object.fromEntries([
      ["content", content],
      ["__proto__", "extra"],
    ]);
    expect(visibleChatEventRowContent({ ...source(content), payload })).toBe(
      visiblePiMemoryCitationText(content),
    );
  });
});
