import type { FeedbackNotePart, UserMessagePart } from "./chat-threads";

const notePartTypes = {
  text: true,
  chat_thread: true,
  project: true,
  template: true,
} satisfies Record<FeedbackNotePart["type"], true>;

const messagePartTypes = {
  ...notePartTypes,
  additional_info: true,
  automation: true,
  feedback: true,
  file: true,
  model: true,
  source: true,
} satisfies Record<UserMessagePart["type"], true>;

function keepStoredPart(value: unknown, types: Readonly<Record<string, true>>): boolean {
  // Keep malformed parts for normal validation. Only unknown discriminants are skipped.
  return (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    typeof value.type !== "string" ||
    Object.hasOwn(types, value.type)
  );
}

/** Project append-only records using the part kinds the current reader supports. */
export function readStoredMessageParts(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    !("parts" in value) ||
    !Array.isArray(value.parts)
  ) {
    return value;
  }
  const parts: unknown[] = value.parts;
  return {
    ...value,
    parts: parts
      .filter((part) => {return keepStoredPart(part, messagePartTypes)})
      .map((part) => {
        if (
          typeof part !== "object" ||
          part === null ||
          !("type" in part) ||
          part.type !== "feedback" ||
          !("note" in part) ||
          !Array.isArray(part.note)
        ) {
          return part;
        }
        return {
          ...part,
          note: part.note.filter((note: unknown) =>
            {return keepStoredPart(note, notePartTypes)},
          ),
        };
      }),
  };
}
