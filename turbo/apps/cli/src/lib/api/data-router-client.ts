import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
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

export function getDataRouterUrl(): URL {
  return new URL(
    process.env.OKOU_DATA_ROUTER_URL ?? "https://data.okou.ai/mcp",
  );
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
