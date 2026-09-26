import { expect, test } from "vitest";

import { parseChatThreadLink } from "../chat-thread-link.ts";

const THREAD_ID = "d8c257e3-0b96-4221-aabc-1ba1e6e57862";
const CURRENT_ORIGIN = "https://staging-app.omby.ai";

test("A link to a chat in this App or the production App names its thread", () => {
  for (const href of [
    `https://app.okou.ai/chats/${THREAD_ID}`,
    `https://app.okou.ai/chats/${THREAD_ID}/`,
    `https://APP.okou.ai:443/chats/${THREAD_ID}`,
    `${CURRENT_ORIGIN}/chats/${THREAD_ID}`,
    `/chats/${THREAD_ID}`,
  ]) {
    expect(parseChatThreadLink(href, CURRENT_ORIGIN)).toBe(THREAD_ID);
  }
  expect(
    parseChatThreadLink(
      `http://localhost:5173/chats/${THREAD_ID}`,
      "http://localhost:5173",
    ),
  ).toBe(THREAD_ID);
});

test("Any other link stays external", () => {
  for (const href of [
    `https://example.com/chats/${THREAD_ID}`,
    `http://app.okou.ai/chats/${THREAD_ID}`,
    `https://www.okou.ai/chats/${THREAD_ID}`,
    `https://app.okou.ai.example.com/chats/${THREAD_ID}`,
    `https://user@app.okou.ai/chats/${THREAD_ID}`,
    `//app.okou.ai/chats/${THREAD_ID}`,
    `https://app.okou.ai/chats/${THREAD_ID}?tab=files`,
    `https://app.okou.ai/chats/${THREAD_ID}#run-1`,
    `https://app.okou.ai/chats/${THREAD_ID}/files`,
    `https://app.okou.ai/chats/${THREAD_ID.toUpperCase()}`,
    "https://app.okou.ai/chats/not-a-thread",
    `https://app.okou.ai/agents/${THREAD_ID}/chat`,
    `chats/${THREAD_ID}`,
    ` /chats/${THREAD_ID}`,
  ]) {
    expect(parseChatThreadLink(href, CURRENT_ORIGIN)).toBeNull();
  }
});
