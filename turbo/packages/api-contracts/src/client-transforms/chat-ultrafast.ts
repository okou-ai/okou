import {
  chatThreadMetadataContract,
  chatThreadsContract,
} from "../contracts/chat-threads";
import type { ClientResponseTransform } from "./types";

function legacySpeed<T extends { readonly serviceTier?: string | null }>(
  response: T,
) {
  return response.serviceTier === "ultrafast"
    ? { ...response, serviceTier: null }
    : response;
}

/** Retire each transform after its enforced native floor reads the new tier. */
function forClient(client: "ios" | "android") {
  const common = { client, maxVersion: null, since: "#48736" } as const;
  return {
    events: {
      ...common,
      method: chatThreadsContract.events.method,
      path: chatThreadsContract.events.path,
      status: 200,
      transform(body) {
        const response = chatThreadsContract.events.responses[200].parse(body);
        return { ...response, events: response.events.map(legacySpeed) };
      },
    },
    metadata: {
      ...common,
      method: chatThreadMetadataContract.get.method,
      path: chatThreadMetadataContract.get.path,
      status: 200,
      transform(body) {
        return legacySpeed(
          chatThreadMetadataContract.get.responses[200].parse(body),
        );
      },
    },
    create: {
      ...common,
      method: chatThreadsContract.create.method,
      path: chatThreadsContract.create.path,
      status: 201,
      transform(body) {
        return legacySpeed(
          chatThreadsContract.create.responses[201].parse(body),
        );
      },
    },
  } satisfies Record<string, ClientResponseTransform>;
}

export const iosChatUltrafastTransforms = forClient("ios");
const android = forClient("android");
export const androidChatUltrafastTransforms = {
  events: android.events,
  create: android.create,
};
