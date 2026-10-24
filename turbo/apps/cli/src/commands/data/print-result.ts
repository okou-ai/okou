import { callDataRouterTool } from "../../lib/api/data-router-client";
import { InvalidArgumentError } from "commander";
import { z } from "zod";

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

/** Quote metadata is a Router control contract, independent of provider result data. */
export async function printDataRouterSubmission(
  name: string,
  input: Record<string, unknown>,
  compact: boolean,
  quote?: { name: string; input: Record<string, unknown>; maxCredits: number },
): Promise<void> {
  if (quote) {
    const result = await callDataRouterTool(quote.name, quote.input);
    if (result.status >= 400) {
      printResult(result, compact);
      return;
    }
    const cost = z
      .object({ maxCredits: z.number().finite().nonnegative() })
      .parse(result.body);
    if (cost.maxCredits > quote.maxCredits) {
      throw new InvalidArgumentError(
        `Quoted cost ${cost.maxCredits} credits exceeds --max-credits ${quote.maxCredits}; no job was submitted`,
      );
    }
  }
  await printDataRouterTool(name, input, compact);
}
