import { http, HttpResponse } from "msw";

import emojiGroupsUrl from "../../data/chat-thread-emoji.json?url";

// One or two emoji per category keeps every category on the rail and in the
// feed while the picker mounts a few dozen buttons instead of ~1,900. Tests
// that need a specific emoji should add it here rather than load the full set.
export const CHAT_THREAD_EMOJI_FIXTURE = [
  {
    name: "Smileys & Emotion",
    emojis: [
      { emoji: "😀", name: "grinning face" },
      { emoji: "🙄", name: "face with rolling eyes" },
    ],
  },
  {
    name: "People & Body",
    emojis: [
      { emoji: "👋", name: "waving hand" },
      { emoji: "👀", name: "eyes" },
    ],
  },
  {
    name: "Animals & Nature",
    emojis: [{ emoji: "🐶", name: "dog face" }],
  },
  {
    name: "Food & Drink",
    emojis: [{ emoji: "🍉", name: "watermelon" }],
  },
  {
    name: "Travel & Places",
    emojis: [{ emoji: "🚀", name: "rocket" }],
  },
  {
    name: "Activities",
    emojis: [{ emoji: "⚽", name: "soccer ball" }],
  },
  {
    name: "Objects",
    emojis: [{ emoji: "👓", name: "glasses" }],
  },
  {
    name: "Symbols",
    emojis: [{ emoji: "❤️", name: "red heart" }],
  },
  {
    name: "Flags",
    emojis: [{ emoji: "🏁", name: "chequered flag" }],
  },
];

export const chatThreadEmojiHandlers = [
  http.get(emojiGroupsUrl, () => {
    return HttpResponse.json(CHAT_THREAD_EMOJI_FIXTURE);
  }),
];
