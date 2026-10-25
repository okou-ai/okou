import { dataRouterToolsContract } from "@okouai/api-contracts/contracts/data-router-catalog";
import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { mockApi } from "../msw-contract.ts";

const disabledTools = new Set<string>();

export function resetMockPaidTools(): void {
  disabledTools.clear();
}

export const apiPaidToolsHandlers = [
  mockApi(dataRouterToolsContract.list, ({ respond }) =>
    respond(200, {
      tools: [
        {
          name: "finance_search",
          title: "Finance Search",
          description: "Search financial instruments.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
          _meta: { "ai.okou/data": { family: "finance" } },
        },
        {
          name: "finance_quote",
          title: "Finance Quote",
          description: "Read a current market quote.",
          inputSchema: {
            type: "object",
            properties: { symbol: { type: "string" } },
          },
          _meta: { "ai.okou/data": { family: "finance" } },
        },
      ],
    }),
  ),
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
