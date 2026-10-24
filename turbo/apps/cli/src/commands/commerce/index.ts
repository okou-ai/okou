import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Command, InvalidArgumentError } from "commander";
import {
  amazonMarketplaceSchema,
  commerceInspectRequestSchema,
  commerceSearchRequestSchema,
} from "@okouai/api-contracts/contracts/commerce";
import { printDataRouterTool } from "../data/print-result";
import { withErrorHandler } from "../../lib/command/with-error-handler";

function amazon(value: string): "amazon" {
  if (value.toLowerCase() !== "amazon")
    throw new InvalidArgumentError("platform must be amazon");
  return "amazon";
}
interface CommerceOptions {
  readonly marketplace?: string;
  readonly limit?: number;
  readonly json?: boolean;
}
const capabilities = new Command("capabilities")
  .description("List Commerce capabilities offline, without billing")
  .argument("[platform]", "Platform", amazon)
  .option("--json", "Print compact JSON")
  .action((_platform: unknown, options: { json?: boolean }) => {
    console.log(
      JSON.stringify(
        {
          capabilities: [
            {
              platform: "amazon",
              operations: ["inspect", "search"],
              marketplaces: amazonMarketplaceSchema.options,
              output: "Router JSON",
              jobs: "Read submitted jobs with okou data commerce job <id>",
            },
          ],
        },
        null,
        options.json ? undefined : 2,
      ),
    );
  });
const inspect = new Command("inspect")
  .description("Inspect an Amazon product by URL or ASIN")
  .argument("<target>", "Amazon product URL or ASIN")
  .requiredOption("--platform <platform>", "amazon", amazon)
  .option("--marketplace <domain>", "Amazon marketplace")
  .option("--json", "Print compact JSON")
  .action(
    withErrorHandler(async (target: string, options: CommerceOptions) => {
      const input = commerceInspectRequestSchema.parse({
        target,
        marketplace: options.marketplace,
        requestId: randomUUID(),
      });
      await printDataRouterTool("commerce_inspect", input, options.json);
    }),
  );
const search = new Command("search")
  .description("Search one page of Amazon products by keyword")
  .argument("<query>", "Product keywords")
  .requiredOption("--platform <platform>", "amazon", amazon)
  .option("--marketplace <domain>", "Amazon marketplace")
  .option(
    "--limit <count>",
    "Maximum products (1-48)",
    (value) => {
      return z.coerce.number().int().min(1).max(48).parse(value);
    },
    48,
  )
  .option("--json", "Print compact JSON")
  .action(
    withErrorHandler(async (query: string, options: CommerceOptions) => {
      const input = commerceSearchRequestSchema.parse({
        query,
        marketplace: options.marketplace,
        limit: options.limit,
        requestId: randomUUID(),
      });
      await printDataRouterTool("commerce_search", input, options.json);
    }),
  );
const job = new Command("job")
  .description("Read a saved Commerce job")
  .argument("<id>", "Saved job UUID", (value) => {
    return z.uuid().parse(value);
  })
  .option("--json", "Print compact JSON")
  .action(
    withErrorHandler(async (jobId: string, options: { json?: boolean }) => {
      await printDataRouterTool("commerce_get", { id: jobId }, options.json);
    }),
  );
export const commerceCommand = new Command("commerce")
  .description("Call Commerce tools and print the Router JSON unchanged")
  .addCommand(capabilities)
  .addCommand(inspect)
  .addCommand(search)
  .addCommand(job)
  .addHelpText(
    "after",
    "\nSearch and inspect return a job receipt. Read results with commerce job <id>. Each command performs one Router call; it does not poll, paginate, or transform the result. Use shell redirection to save JSON. Do not repeat an uncertain paid submission.",
  );
