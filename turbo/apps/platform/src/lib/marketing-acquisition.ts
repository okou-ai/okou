import {
  marketingAcquisitionContract,
  type ObservedAcquisitionEvent,
} from "@okouai/api-contracts/contracts/marketing-acquisition";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

export async function marketingShadowConfiguration(
  baseUrl: string,
  signal: AbortSignal,
): Promise<boolean> {
  const response = await initClient(marketingAcquisitionContract, {
    baseUrl,
  }).config({ fetchOptions: { signal, cache: "no-store" } });
  if (response.status !== 200)
    throw new Error("Marketing configuration unavailable");
  return response.body.shadowEnabled;
}

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
  if (response.status !== 200)
    throw new Error("Marketing observations unavailable");
  return response.body;
}
