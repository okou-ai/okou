import { callDataRouterTool } from "../../lib/api/data-router-client";

function printResult(
  result: { status: number; body: unknown },
  compact: boolean,
): void {
  console.log(JSON.stringify(result.body, null, compact ? undefined : 2));
  if (result.status >= 400) process.exitCode = 1;
}

/** The Router owns result schemas; the CLI only interprets the transport status. */
export async function printDataRouterTool(
  name: string,
  input: Record<string, unknown>,
  compact = false,
): Promise<void> {
  const result = await callDataRouterTool(name, input);
  printResult(result, compact);
}
