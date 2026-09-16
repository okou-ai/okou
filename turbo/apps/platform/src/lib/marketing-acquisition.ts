import {
  marketingAcquisitionContract,
  type ObservedAcquisitionEvent,
} from "@okouai/api-contracts/contracts/marketing-acquisition";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

export async function sendMarketingObservations(
  baseUrl: string,
  token: string,
  body: {
    checkSignup: boolean;
    sessionId?: string;
    events: ObservedAcquisitionEvent[];
  },
  signal: AbortSignal,
) {
  const response = await initClient(marketingAcquisitionContract, {
    baseUrl,
  }).events({
    headers: { authorization: `Bearer ${token}` },
    body,
    fetchOptions: { credentials: "include", keepalive: true, signal },
  });
  if (response.status !== 200) {
    throw new Error("Marketing observations unavailable");
  }
  return response.body;
}
