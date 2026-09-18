import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { mockApi } from "../msw-contract.ts";

const disabledTools = new Set<string>();

export function resetMockPaidTools(): void {
  disabledTools.clear();
}

export const apiPaidToolsHandlers = [
  mockApi(paidToolsContract.get, ({ respond }) => {
    return respond(200, { disabledTools: [...disabledTools] });
  }),
  mockApi(paidToolsContract.update, ({ params, body, respond }) => {
    if (body.disabled) {
      disabledTools.add(params.toolId);
    } else {
      disabledTools.delete(params.toolId);
    }
    return respond(200, { toolId: params.toolId, disabled: body.disabled });
  }),
];
