import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import {
  initClient,
  type ApiFetcher,
} from "@okouai/api-contracts/contracts/trpc-contract";
import { dataRouterHistoryContract } from "@okouai/api-contracts/contracts/data-router";
import {
  ApiRequestError,
  getClientConfig,
  handleError,
} from "./core/client-factory";

const envelopeSchema = z.object({
  data: z.object({ status: z.number().int(), body: z.unknown() }),
});
const argumentsSchema = z.record(z.string(), z.json());
const listTools = new Set([
  "data_list",
  "social_data_list",
  "social_download_list",
]);

async function ownedRequestIds(): Promise<string[]> {
  const client = initClient(dataRouterHistoryContract, await getClientConfig());
  const result = await client.list({ headers: {} });
  if (result.status !== 200)
    handleError(result, "Failed to read Data request history");
  return result.body.requestIds;
}

/** Uses the static tool contract. The privileged MITM injects service authentication. */
export async function callDataRouterTool(
  name: string,
  input: Record<string, unknown>,
  callerSignal?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  await getClientConfig();
  const args = listTools.has(name)
    ? { ...input, requestIds: await ownedRequestIds() }
    : input;
  const signal = AbortSignal.any([
    AbortSignal.timeout(300_000),
    ...(callerSignal ? [callerSignal] : []),
  ]);
  const transport = new StreamableHTTPClientTransport(
    new URL(process.env.OKOU_DATA_ROUTER_URL ?? "https://data.okou.ai/mcp"),
    {
      requestInit: { redirect: "error", signal },
      reconnectionOptions: {
        initialReconnectionDelay: 1_000,
        maxReconnectionDelay: 1_000,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 0,
      },
      onInsufficientScope: "throw",
      maxStepUpRetries: 0,
    },
  );
  const client = new Client(
    { name: "okou-data-cli", version: "1.0.0" },
    {
      versionNegotiation: { mode: "auto", probe: { maxRetries: 0 } },
      inputRequired: { autoFulfill: false },
    },
  );
  const requestOptions = { signal, timeout: 300_000, maxTotalTimeout: 300_000 };
  try {
    await client.connect(transport, requestOptions);
    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name,
          arguments: argumentsSchema.parse(JSON.parse(JSON.stringify(args))),
        },
      },
      requestOptions,
    );
    const parsed = envelopeSchema.safeParse(result.structuredContent);
    if (!parsed.success)
      throw new ApiRequestError(
        "Data Router returned an invalid tool response",
        "INVALID_DATA_RESPONSE",
        502,
      );
    return parsed.data.data;
  } finally {
    // Closing a completed call must never encourage an automatic paid retry.
    const [closed] = await Promise.allSettled([client.close()]);
    if (closed.status === "rejected")
      process.stderr.write("Warning: Data Router connection cleanup failed.\n");
  }
}

const routes: Record<string, string> = {
  "POST /api/web-search": "web_search",
  "POST /api/people-search": "people_search",
  "POST /api/scrape": "web_scrape",
  "POST /api/maps/search": "maps_search",
  "GET /api/social/status": "social_status",
  "POST /api/social/downloads": "social_download_create",
  "GET /api/social/downloads": "social_download_list",
  "GET /api/social/downloads/:downloadId": "social_download_get",
  "POST /api/social/data/quote": "social_data_quote",
  "POST /api/social/data/jobs": "social_data_create",
  "GET /api/social/data/jobs": "social_data_list",
  "GET /api/social/data/jobs/:jobId": "social_data_get",
  "POST /api/social/data/jobs/:jobId/continue/quote":
    "social_data_quote_continuation",
  "POST /api/social/data/jobs/:jobId/continue": "social_data_continue",
  "POST /api/social/data/jobs/:jobId/cancel": "social_data_cancel",
  "GET /api/commerce/jobs/:id": "commerce_get",
  "POST /api/commerce/search": "commerce_search",
  "POST /api/commerce/inspect": "commerce_inspect",
  "GET /api/data/capabilities": "data_capabilities",
  "POST /api/data/quote": "data_quote",
  "POST /api/data/jobs": "data_create",
  "GET /api/data/jobs": "data_list",
  "GET /api/data/jobs/:jobId": "data_get",
  "POST /api/data/jobs/:jobId/cancel": "data_cancel",
};
for (const operation of ["search", "profile", "quote", "chart"])
  routes[`POST /api/finance/${operation}`] = `finance_${operation}`;
for (const operation of [
  "serp",
  "keyword-ideas",
  "ranked-keywords",
  "backlinks-summary",
])
  routes[`POST /api/seo/${operation}`] =
    `seo_${operation.replaceAll("-", "_")}`;

const dataRouterApi: ApiFetcher = async (args) => {
  const url = new URL(args.path);
  const query = Object.fromEntries(url.searchParams);
  const querySchema = args.route.query;
  const parsedQuery =
    querySchema && "safeParse" in querySchema
      ? querySchema.safeParse(query)
      : undefined;
  const input = z
    .record(z.string(), z.unknown())
    .parse(typeof args.body === "string" ? JSON.parse(args.body) : {});
  Object.assign(input, parsedQuery?.success ? parsedQuery.data : query);
  const actual = url.pathname.split("/");
  for (const [index, segment] of args.route.path.split("/").entries()) {
    if (segment.startsWith(":"))
      input[segment.slice(1)] = decodeURIComponent(actual[index] ?? "");
  }
  let name = routes[`${args.method} ${args.route.path}`];
  let toolInput = input;
  if (args.route.path === "/api/social/request") {
    const request = z
      .object({ tool: z.string(), input: z.record(z.string(), z.unknown()) })
      .parse(input);
    name = request.tool;
    toolInput = request.input;
  }
  if (!name)
    throw new Error(
      `No Data Router tool for ${args.method} ${args.route.path}`,
    );
  const result = await callDataRouterTool(
    name,
    toolInput,
    args.fetchOptions?.signal ?? undefined,
  );
  return { ...result, headers: new Headers() };
};

export async function getDataClientConfig() {
  // Main authentication is used only for user-owned history. Its token is never sent to Router.
  return {
    baseUrl: "https://data.okou.ai",
    jsonQuery: false as const,
    api: dataRouterApi,
  };
}
