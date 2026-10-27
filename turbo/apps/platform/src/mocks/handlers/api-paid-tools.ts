import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { http, HttpResponse } from "msw";
import { mockApi } from "../msw-contract.ts";

const disabledTools = new Set<string>();

export function resetMockPaidTools(): void {
  disabledTools.clear();
}

const DATA_ROUTER_URLS = [
  "https://data.okou.ai/mcp",
  "https://okou-data-router-staging.vm0.workers.dev/mcp",
] as const;

function routerFamily(id: string, title: string, description: string) {
  return {
    id,
    title: { "en-US": title },
    description: { "en-US": description },
    summary: description,
  };
}

function routerTool(name: string, family: string) {
  return {
    name,
    inputSchema: { type: "object", properties: {} },
    _meta: { "ai.okou/data": { family } },
  };
}

/** Router's public catalog: tools/list without credentials. */
const dataRouterCatalog = {
  tools: [
    routerTool("web_search", "web-search"),
    routerTool("people_search", "people-search"),
    routerTool("data_quote", "data-search"),
    routerTool("finance_quote", "finance"),
    { name: "billing_get", inputSchema: { type: "object" } },
  ],
  _meta: {
    "ai.okou/data": {
      families: [
        routerFamily(
          "web-search",
          "Web search",
          "Find current information on the web.",
        ),
        routerFamily(
          "people-search",
          "People search",
          "Find public professional profiles.",
        ),
        routerFamily(
          "data-search",
          "Advanced data research",
          "Enrich professional profiles and research business data.",
        ),
        routerFamily(
          "finance",
          "Financial data",
          "Look up companies, quotes, and market data.",
        ),
      ],
    },
  },
};

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
  ...DATA_ROUTER_URLS.map((url) => {
    return http.post(url, async ({ request }) => {
      const message: unknown = await request.json();
      const id =
        typeof message === "object" && message !== null && "id" in message
          ? message.id
          : null;
      return HttpResponse.json({
        jsonrpc: "2.0",
        id,
        result: dataRouterCatalog,
      });
    });
  }),
];
