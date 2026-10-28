import { featureGuidesContract } from "@okouai/api-contracts/contracts/feature-guides";
import { mockApi } from "../msw-contract.ts";

export const apiFeatureGuidesHandlers = [
  mockApi(featureGuidesContract.current, ({ respond }) =>
    respond(200, { edition: null }),
  ),
  mockApi(featureGuidesContract.seen, ({ respond }) =>
    respond(200, { seen: true }),
  ),
];
