import { presentationTemplatesContract } from "@okouai/api-contracts/contracts/presentation-templates";

import { mockApi } from "../msw-contract.ts";

export const apiPresentationTemplatesHandlers = [
  mockApi(presentationTemplatesContract.list, ({ respond }) => {
    return respond(200, []);
  }),
];
