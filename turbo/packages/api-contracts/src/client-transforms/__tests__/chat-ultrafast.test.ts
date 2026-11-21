import { expect, it } from "vitest";
import {
  androidChatUltrafastTransforms,
  iosChatUltrafastTransforms,
} from "../chat-ultrafast";

const id = "f1000000-0000-4000-8000-000000000001";
const createdAt = "2026-11-18T00:00:00.000Z";
const thread = { id, title: null, selectedModel: "gpt-6.1-sol" };

it.each([iosChatUltrafastTransforms, androidChatUltrafastTransforms])(
  "keeps lifecycle responses readable by installed native clients",
  (transforms) => {
    const created = { ...thread, createdAt, serviceTier: "ultrafast" };
    expect(transforms.create.transform(created)).toEqual({
      ...created,
      serviceTier: null,
    });
    const event = {
      ...created,
      seqId: 1,
      kind: "service_tier_updated",
      chatThreadId: id,
      computerUseHostId: null,
    };
    const fast = { ...event, seqId: 2, serviceTier: "priority" };
    expect(
      transforms.events.transform({ events: [event, fast], hasMore: true }),
    ).toEqual({
      events: [{ ...event, serviceTier: null }, fast],
      hasMore: true,
    });
  },
);

it("maps only the tier on metadata sent to installed iOS clients", () => {
  const metadata = {
    ...thread,
    serviceTier: "ultrafast",
    modelSettings: {},
    pinnedAt: null,
    archived: false,
    muted: false,
    computerUseHostId: null,
    cloudBrowserEnabled: false,
  };
  expect(iosChatUltrafastTransforms.metadata.transform(metadata)).toEqual({
    ...metadata,
    serviceTier: null,
  });
});
