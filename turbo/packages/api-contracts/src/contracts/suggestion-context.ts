import {
  array,
  literal,
  object,
  string,
  uuid,
  type infer as zInfer,
} from "zod";
import type { UserMessageDocument, UserMessagePart } from "./chat-threads";

/** Stored in the existing agent-only context part so older chat readers remain compatible. */
export const suggestionContextSchema = object({
  suggestionId: uuid(),
  draftId: uuid(),
  optionId: literal("custom"),
  titleSnapshot: string().min(1).max(120),
  rationaleSnapshot: string().max(200),
  contextVersion: string().min(1),
  attachmentIds: array(string().min(1)),
}).strict();
export type SuggestionContext = zInfer<typeof suggestionContextSchema>;

const PREFIX = "Okou suggestion context v1:\n";

export function suggestionContextPart(
  context: SuggestionContext,
): UserMessagePart {
  return { type: "additional_info", text: PREFIX + JSON.stringify(context) };
}

export function readSuggestionContext(
  part: UserMessagePart | undefined,
): SuggestionContext | null {
  if (part?.type !== "additional_info" || !part.text.startsWith(PREFIX)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(part.text.slice(PREFIX.length));
  } catch {
    return null;
  }
  const result = suggestionContextSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** A context annotation belongs only to the immediately following quote. */
export function suggestionFeedbacks(document: UserMessageDocument) {
  return document.parts.flatMap((part, index) => {
    const context = readSuggestionContext(document.parts[index - 1]);
    return part.type === "feedback" && context ? [{ part, context }] : [];
  });
}

export function hasEmptySuggestionNote(document: UserMessageDocument): boolean {
  return suggestionFeedbacks(document).some(({ part }) => {
    return !part.note.some((note) => {
      return note.type !== "text" || note.text.trim().length > 0;
    });
  });
}
