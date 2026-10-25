import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { dataRouterHistoryContract } from "@okouai/api-contracts/contracts/data-router";
import {
  dataRouterToolsPageSchema,
  type DataRouterTool,
} from "@okouai/api-contracts/contracts/data-router-tools";
import {
  ApiRequestError,
  getClientConfig,
  handleError,
} from "./core/client-factory";

const envelopeSchema = z.object({
  data: z.object({ status: z.number().int(), body: z.unknown() }),
});
const argumentsSchema = z.record(z.string(), z.json());
interface RequestOptions {
  signal: AbortSignal;
  timeout: number;
  maxTotalTimeout: number;
}

async function ownedRequestIds(): Promise<string[]> {
  const client = initClient(dataRouterHistoryContract, await getClientConfig());
  const result = await client.list({ headers: {} });
  if (result.status !== 200)
    handleError(result, "Failed to read Data request history");
  return result.body.requestIds;
}

export function getDataRouterUrl(): URL {
  return new URL(
    process.env.OKOU_DATA_ROUTER_URL ?? "https://data.okou.ai/mcp",
  );
}

async function withDataRouter<T>(
  operation: (client: Client, options: RequestOptions) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  await getClientConfig();
  const signal = AbortSignal.any([
    AbortSignal.timeout(300_000),
    ...(callerSignal ? [callerSignal] : []),
  ]);
  const transport = new StreamableHTTPClientTransport(getDataRouterUrl(), {
    requestInit: { redirect: "error", signal },
    reconnectionOptions: {
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
    onInsufficientScope: "throw",
    maxStepUpRetries: 0,
  });
  const client = new Client(
    { name: "okou-data-cli", version: "1.0.0" },
    {
      versionNegotiation: { mode: "auto", probe: { maxRetries: 0 } },
      inputRequired: { autoFulfill: false },
    },
  );
  const options = { signal, timeout: 300_000, maxTotalTimeout: 300_000 };
  try {
    await client.connect(transport, options);
    return await operation(client, options);
  } finally {
    const [closed] = await Promise.allSettled([client.close()]);
    if (closed.status === "rejected")
      process.stderr.write("Warning: Data Router connection cleanup failed.\n");
  }
}

async function discoverTools(
  client: Client,
  options: RequestOptions,
): Promise<DataRouterTool[]> {
  const tools: DataRouterTool[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const page = dataRouterToolsPageSchema.parse(
      await client.request(
        { method: "tools/list", params: cursor ? { cursor } : {} },
        options,
      ),
    );
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor))
      throw new Error("Data Router returned a repeated discovery cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return tools;
}

export async function listDataRouterTools(): Promise<DataRouterTool[]> {
  return withDataRouter(discoverTools);
}

/** The privileged MITM injects authentication and a managed request ID. */
export async function callDataRouterTool(
  name: string,
  input: Record<string, unknown>,
  callerSignal?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  return withDataRouter(async (client, options) => {
    const tools = await discoverTools(client, options);
    const tool = tools.find((entry) => {
      return entry.name === name;
    });
    const args = tool?._meta?.["ai.okou/data"]?.requestHistory
      ? { ...input, requestIds: await ownedRequestIds() }
      : input;
    const result = await client
      .request(
        {
          method: "tools/call",
          params: { name, arguments: argumentsSchema.parse(args) },
        },
        options,
      )
      .catch((cause: unknown) => {
        throw new Error(
          "Data Router did not return a complete response; a paid operation may have executed. Do not resubmit automatically; inspect saved jobs when available.",
          { cause },
        );
      });
    const parsed = envelopeSchema.safeParse(result.structuredContent);
    if (!parsed.success && result.isError) return { status: 400, body: result };
    if (!parsed.success)
      throw new ApiRequestError(
        "Data Router returned an invalid tool response; a paid operation may have executed. Do not resubmit automatically; inspect saved jobs when available.",
        "INVALID_DATA_RESPONSE",
        502,
      );
    return parsed.data.data;
  }, callerSignal);
}
