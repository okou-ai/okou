import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { PiMemoryCitationStreamParser } from "@okouai/api-contracts/contracts/pi-memory-citations";
import type { PiApiTextStream } from "./api-types";

/** Preserve native block identities even when thinking or empty text is omitted. */
export function createPiApiTextStream(stream: PiApiTextStream) {
  const pending = new Map<number, string>();
  const indices = new Map<number, number>();
  const parser = new PiMemoryCitationStreamParser((source, text) => {
    pending.set(source, (pending.get(source) ?? "") + text);
  });
  return (event: AssistantMessageEvent): void => {
    if (
      event.type === "text_start" &&
      event.partial.api === "anthropic-messages"
    ) {
      // Only Messages carries initial text. Other adapters share a mutable
      // partial with their delta event, so reading it here can duplicate text.
      const block = event.partial.content[event.contentIndex];
      if (block?.type === "text") {
        parser.push(block.text, event.contentIndex);
      }
    } else if (event.type === "text_delta") {
      parser.push(event.delta, event.contentIndex);
    } else if (event.type === "done") {
      parser.finish();
    } else {
      return;
    }
    for (const [source, text] of pending) {
      const chunkIndex = indices.get(source) ?? 0;
      const delta = chunkIndex === 0 ? text.trimStart() : text;
      if (!delta) {
        continue;
      }
      // This advances even if the publisher has no subscribers. A late viewer
      // must never receive a new chunk zero halfway through an existing block.
      for (let offset = 0; offset < delta.length; offset += 4096) {
        const index = indices.get(source) ?? 0;
        indices.set(source, index + 1);
        stream.onDelta({
          runEventId: `${stream.eventIdPrefix}:${source}`,
          chunkIndex: index,
          delta: delta.slice(offset, offset + 4096),
        });
      }
    }
    pending.clear();
  };
}
