import { chatThreadsContract } from "../contracts/chat-threads";
import type { ClientResponseTransform } from "./types";

const route = chatThreadsContract.indicators;

function legacyIndicators(
  client: "ios" | "android",
  maxVersion: string,
): ClientResponseTransform {
  return {
    client,
    method: route.method,
    path: route.path,
    status: 200,
    maxVersion,
    since: "#49839",
    transform: (body) => {
      const indicators = route.responses[200].parse(body);
      return { ...indicators, agents: indicators.agents ?? {} };
    },
  };
}

export const iosLegacyIndicators = legacyIndicators("ios", "0.51.7");
export const androidLegacyIndicators = legacyIndicators("android", "0.36.0");
