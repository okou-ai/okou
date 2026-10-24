import { printDataRouterTool, printDataRouterSubmission } from "./print-result";
import { randomUUID } from "node:crypto";

import {
  dataSearchCreateRequestSchema,
  dataSearchListQuerySchema,
  dataSearchRequestSchema,
  type DataSearchRequest,
} from "@okouai/api-contracts/contracts/data-search";
import { Command, InvalidArgumentError, Option } from "commander";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { registerDataSourceCommands } from "./sources";

export interface DataProspectOptions {
  readonly json?: boolean;
  readonly backend?: "research" | "prospect";
  readonly limit?: number;
  readonly dryRun?: boolean;
  readonly maxCredits?: number;
  readonly requestId?: string;
  readonly titles?: string[];
  readonly locations?: string[];
  readonly seniorities?: string[];
  readonly companyDomains?: string[];
  readonly companyLocations?: string[];
  readonly companySizes?: string[];
}

export interface DataQueryOptions extends DataProspectOptions {
  readonly id?: string;
  readonly linkedinUrl?: string;
  readonly name?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly domain?: string;
  readonly fields?: string[];
  readonly domains?: string[];
  readonly sizes?: string[];
  readonly keywords?: string[];
}

function integer(value: string, min: number, max: number): number {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidArgumentError(`Expected an integer from ${min} to ${max}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new InvalidArgumentError(`Expected an integer from ${min} to ${max}`);
  }
  return parsed;
}

function limit(value: string): number {
  return integer(value, 1, 100);
}

function credits(value: string): number {
  return integer(value, 0, Number.MAX_SAFE_INTEGER);
}

function uuid(value: string): string {
  const result = dataSearchCreateRequestSchema.shape.requestId.safeParse(value);
  if (!result.success) throw new InvalidArgumentError("Expected a UUID");
  return result.data;
}

function list(value: string): string[] {
  const values = value.split(",").map((item) => {
    return item.trim();
  });
  if (
    values.some((item) => {
      return !item || item.length > 500;
    }) ||
    values.length > 20
  ) {
    throw new InvalidArgumentError(
      "Expected 1-20 nonempty comma-separated values (maximum 500 characters each)",
    );
  }
  return [...new Set(values)];
}

function domain(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u.test(normalized)
  ) {
    throw new InvalidArgumentError(
      "Expected a company domain, such as example.com (not a URL)",
    );
  }
  return normalized;
}

function domains(value: string): string[] {
  return list(value).map(domain);
}

function sizes(value: string): string[] {
  return list(value).map((range) => {
    const match = /^(\d{1,8})-(\d{1,8})$/u.exec(range);
    if (!match || Number(match[1]) > Number(match[2])) {
      throw new InvalidArgumentError(
        "Headcount ranges must use min-max, such as 1-10,11-50",
      );
    }
    return `${match[1]},${match[2]}`;
  });
}

function seniorities(value: string): string[] {
  const values = list(value);
  const supported = [
    "owner",
    "founder",
    "c_suite",
    "partner",
    "vp",
    "head",
    "director",
    "manager",
    "senior",
    "entry",
    "intern",
  ];
  if (
    values.some((item) => {
      return !supported.includes(item);
    })
  ) {
    throw new InvalidArgumentError(`Seniority levels: ${supported.join(", ")}`);
  }
  return values;
}

function linkedinUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError("Expected a public LinkedIn profile URL");
  }
  if (
    value.length <= 500 &&
    url.protocol === "https:" &&
    ["linkedin.com", "www.linkedin.com"].includes(url.hostname) &&
    /^\/in\/[^/]+\/?$/u.test(url.pathname) &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password
  )
    return value;
  throw new InvalidArgumentError(
    "Expected a public https://www.linkedin.com/in/<profile> URL without query parameters",
  );
}

function fields(value: string): string[] {
  const values = list(value);
  if (
    values.length !== 1 ||
    values.some((item) => {
      return item !== "profile" && item !== "work-email";
    })
  ) {
    throw new InvalidArgumentError(
      "--fields requires exactly one of profile or work-email; combined requests, private email and phone are unavailable",
    );
  }
  return values;
}
function addJobOptions(
  command: Command,
  includeLimit = true,
  maxLimit = 100,
): void {
  if (
    !command.options.some((option) => {
      return option.long === "--json";
    })
  )
    command.option("--json", "Print compact JSON");
  if (includeLimit)
    command.option(
      "--limit <count>",
      `Maximum results (1-${maxLimit})`,
      (value) => {
        return integer(value, 1, maxLimit);
      },
      Math.min(10, maxLimit),
    );
  command
    .option("--dry-run", "Get a free quote without creating a job")
    .option(
      "--max-credits <credits>",
      "Required maximum quote accepted before submission",
      credits,
    )
    .option(
      "--request-id <uuid>",
      "Client request label; resubmitting can charge again",
      uuid,
    );
  command.addHelpText(
    "after",
    "\nReturns the Router JSON unchanged. Submissions return a saved-job receipt; inspect it with okou data jobs get <job-id>. --max-credits checks a free quote before submission. An uncertain submission must not be repeated automatically. Use shell redirection to save JSON. Queries go to external sources; do not include secrets or private context.",
  );
}

export function addDataProspectOptions(command: Command): void {
  command.addOption(
    new Option(
      "--backend <backend>",
      "Professional research or structured business prospecting",
    )
      .choices(["research", "prospect"])
      .default("research"),
  );
  command
    .option(
      "--titles <titles>",
      "Comma-separated job titles (prospect only)",
      list,
    )
    .option(
      "--locations <locations>",
      "Comma-separated person locations (prospect only)",
      list,
    )
    .option(
      "--seniorities <levels>",
      "Comma-separated source-supported seniority levels",
      seniorities,
    )
    .option(
      "--company-domains <domains>",
      "Comma-separated employer domains",
      domains,
    )
    .option(
      "--company-locations <locations>",
      "Comma-separated employer locations",
      list,
    )
    .option(
      "--company-sizes <ranges>",
      "Employer headcount ranges, e.g. 1-10,11-50",
      sizes,
    );
  addJobOptions(command, false);
}

export function usesDataProspect(options: DataProspectOptions): boolean {
  return options.backend === "prospect";
}

function definedInput(
  entries: readonly (readonly [
    string,
    string | number | boolean | string[] | undefined,
  ])[],
): DataSearchRequest["input"] {
  const input: DataSearchRequest["input"] = {};
  for (const [key, value] of entries) {
    if (value !== undefined) input[key] = value;
  }
  return input;
}

export async function runDataProspect(
  query: string | undefined,
  options: DataProspectOptions,
): Promise<void> {
  await executeDataSearch(
    "people.search",
    definedInput([
      ["query", query?.trim() || undefined],
      ["titles", options.titles],
      ["locations", options.locations],
      ["seniorities", options.seniorities],
      ["companyDomains", options.companyDomains],
      ["companyLocations", options.companyLocations],
      ["companySizes", options.companySizes],
    ]),
    options,
  );
}
async function executeDataSearch(
  capability: string,
  input: DataSearchRequest["input"],
  options: DataProspectOptions,
  defaultLimit = 10,
): Promise<void> {
  const request = dataSearchRequestSchema.parse({
    capability,
    input,
    limit: options.limit ?? defaultLimit,
  });
  if (options.dryRun) {
    await printDataRouterTool("data_quote", request, options.json);
    return;
  }
  if (options.maxCredits === undefined)
    throw new InvalidArgumentError(
      "Execution requires --max-credits; use --dry-run for a free quote first",
    );
  const body = dataSearchCreateRequestSchema.parse({
    ...request,
    requestId: options.requestId ?? randomUUID(),
    maxCredits: options.maxCredits,
  });
  await printDataRouterSubmission("data_create", body, options.json === true, {
    name: "data_quote",
    input: request,
    maxCredits: options.maxCredits,
  });
}

function group(parent: Command, name: string, description: string): Command {
  const existing = parent.commands.find((command) => {
    return command.name() === name;
  });
  return existing ?? parent.command(name).description(description);
}

export function registerDataSearchCommands(dataCommand: Command): void {
  for (const name of ["discover", "capabilities"]) {
    dataCommand
      .command(name)
      .description(
        "Discover reviewed Data Search capabilities and exact input schemas",
      )
      .argument("[query]", "Filter business capability IDs and descriptions")
      .option("--json", "Print compact JSON")
      .action(
        withErrorHandler(
          async (query: string | undefined, options: { json?: boolean }) => {
            await printDataRouterTool(
              "data_capabilities",
              { query },
              options.json,
            );
          },
        ),
      );
  }

  const people = group(
    dataCommand,
    "people",
    "Professional research and business contact data",
  );
  const enrich = people
    .command("enrich")
    .description(
      "Enrich one professional profile; work email requires explicit --fields work-email",
    )
    .option("--id <id>", "Stable source person ID")
    .option("--linkedin-url <url>", "Public LinkedIn profile URL", linkedinUrl)
    .option("--name <name>", "Person name (requires --domain)")
    .option(
      "--first-name <name>",
      "First name for explicit work-email matching",
    )
    .option("--last-name <name>", "Last name for explicit work-email matching")
    .option("--domain <domain>", "Employer domain for name matching", domain)
    .option(
      "--fields <field>",
      "Exactly one of profile or work-email (default: profile)",
      fields,
      ["profile"],
    );
  addJobOptions(enrich, false);
  enrich.action(
    withErrorHandler(
      async (options: DataQueryOptions & { fields: string[] }) => {
        const workEmail = options.fields.includes("work-email");
        if (
          workEmail &&
          !(
            options.domain &&
            (options.name || (options.firstName && options.lastName))
          )
        ) {
          throw new InvalidArgumentError(
            "--fields work-email requires --domain and either --name or both --first-name and --last-name",
          );
        }
        if (
          !workEmail &&
          !options.id &&
          !options.linkedinUrl &&
          !(options.name && options.domain)
        ) {
          throw new InvalidArgumentError(
            "Provide --id, --linkedin-url, or both --name and --domain",
          );
        }
        await executeDataSearch(
          "people.enrich",
          definedInput([
            ["id", options.id],
            ["linkedinUrl", options.linkedinUrl],
            ["name", options.name],
            ["firstName", options.firstName],
            ["lastName", options.lastName],
            ["domain", options.domain],
            ["fields", options.fields],
          ]),
          options,
          1,
        );
      },
    ),
  );

  const company = group(
    dataCommand,
    "company",
    "Search business organizations",
  );
  const search = company
    .command("search")
    .description("Find companies using structured business filters")
    .option("--name <name>", "Company name")
    .option("--domains <domains>", "Comma-separated company domains", domains)
    .option(
      "--locations <locations>",
      "Comma-separated company locations",
      list,
    )
    .option(
      "--sizes <ranges>",
      "Company headcount ranges, e.g. 1-10,11-50",
      sizes,
    )
    .option("--keywords <keywords>", "Comma-separated business keywords", list);
  addJobOptions(search);
  search.action(
    withErrorHandler(async (options: DataQueryOptions) => {
      if (
        !options.name &&
        !options.domains &&
        !options.locations &&
        !options.sizes &&
        !options.keywords
      ) {
        throw new InvalidArgumentError(
          "Provide at least one company name, domain, location, size, or keyword filter",
        );
      }
      await executeDataSearch(
        "company.search",
        definedInput([
          ["name", options.name],
          ["domains", options.domains],
          ["locations", options.locations],
          ["sizes", options.sizes],
          ["keywords", options.keywords],
        ]),
        options,
      );
    }),
  );

  const inspect = company
    .command("inspect")
    .description("Enrich one company profile by its business domain")
    .requiredOption("--domain <domain>", "Company domain", domain);
  addJobOptions(inspect, false);
  inspect.action(
    withErrorHandler(async (options: DataQueryOptions) => {
      await executeDataSearch(
        "company.inspect",
        definedInput([["domain", options.domain]]),
        options,
        1,
      );
    }),
  );

  registerDataSourceCommands(dataCommand, executeDataSearch, addJobOptions);
  registerJobs(dataCommand);
}
function registerJobs(parent: Command): void {
  const jobs = parent
    .command("jobs")
    .description("Read or cancel saved Data jobs");
  jobs
    .command("list")
    .option("--limit <count>", "Maximum jobs", limit, 20)
    .option("--cursor <uuid>", "Next page cursor", uuid)
    .option("--status <status>", "Job status")
    .option("--json", "Print compact JSON")
    .action(
      withErrorHandler(async (options) => {
        await printDataRouterTool(
          "data_list",
          dataSearchListQuerySchema.parse(options),
          options.json,
        );
      }),
    );
  for (const operation of ["get", "cancel"]) {
    jobs
      .command(operation)
      .argument("<job-id>", "Saved job UUID", uuid)
      .option("--json", "Print compact JSON")
      .action(
        withErrorHandler(async (jobId: string, options: { json?: boolean }) => {
          await printDataRouterTool(
            `data_${operation}`,
            { jobId },
            options.json,
          );
        }),
      );
  }
}
