import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { ChatFollowupOrigin } from "@okouai/api-contracts/contracts/chat-threads";

interface TrackedFollowup {
  readonly origin: ChatFollowupOrigin;
  readonly from: number;
  readonly to: number;
}

class FollowupSelection implements TrackedFollowup {
  constructor(
    readonly origin: ChatFollowupOrigin,
    readonly from: number,
    readonly to: number,
  ) {}
}

const followupOriginsKey = Object.freeze(
  new PluginKey<readonly TrackedFollowup[]>("composerFollowupOrigins"),
);

/** Editor-session metadata only; never serialized into a draft or message. */
export const ComposerFollowupOrigins = Extension.create({
  name: "composerFollowupOrigins",
  addProseMirrorPlugins() {
    return [
      new Plugin<readonly TrackedFollowup[]>({
        key: followupOriginsKey,
        state: {
          init: () => {
            return [];
          },
          apply(transaction, previous) {
            const change: unknown = transaction.getMeta(followupOriginsKey);
            if (change === "clear") {
              return [];
            }
            const surviving = previous.flatMap((tracked) => {
              // Opposite associations make a complete replacement collapse the
              // range. Partial edits keep their source, while deleting a pick
              // cannot attribute later text typed in the same place to it.
              const from = transaction.mapping.map(tracked.from, 1);
              const to = transaction.mapping.map(tracked.to, -1);
              return from < to && transaction.doc.textBetween(from, to).trim()
                ? [{ ...tracked, from, to }]
                : [];
            });
            if (!(change instanceof FollowupSelection)) {
              return surviving;
            }
            return [
              ...surviving.filter(({ origin }) => {
                return (
                  origin.eventId !== change.origin.eventId ||
                  origin.index !== change.origin.index
                );
              }),
              change,
            ].slice(-3);
          },
        },
      }),
    ];
  },
});

export function trackComposerFollowupOrigin(
  editor: Editor,
  origin: ChatFollowupOrigin,
  range: { readonly from: number; readonly to: number },
): void {
  editor.view.dispatch(
    editor.state.tr.setMeta(
      followupOriginsKey,
      new FollowupSelection(origin, range.from, range.to),
    ),
  );
}

export function readComposerFollowupOrigins(
  editor: Editor,
): ChatFollowupOrigin[] {
  return (followupOriginsKey.getState(editor.state) ?? []).map(({ origin }) => {
    return origin;
  });
}

export function clearComposerFollowupOrigins(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(followupOriginsKey, "clear"));
}
