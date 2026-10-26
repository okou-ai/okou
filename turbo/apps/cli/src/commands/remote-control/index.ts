import { randomUUID } from "node:crypto";
import { Command, Option } from "commander";
import { array, int, object, string, uuid, enum as zEnum } from "zod";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import {
  cloudflareAccessNetworks,
  tailscaleNetworks,
} from "../../lib/api/domains/remote-networks";
import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { readManagementInput } from "../../lib/management-input";
import { withErrorHandler } from "../../lib/command/with-error-handler";

const scopeSchema = zEnum(["personal", "organization"]);
const referenceSchema = object({ id: uuid(), displayName: string() });
// Strip unknown keys at every object boundary, including nested references.
const metadataSchema = object({
  id: uuid(),
  name: string().optional(),
  scope: scopeSchema.optional(),
  tags: array(string()).optional(),
  revision: int().positive().optional(),
  generation: int().positive().optional(),
  sshHosts: array(referenceSchema).optional(),
  vncHosts: array(
    referenceSchema.extend({
      roles: array(zEnum(["rfb", "kdc"]))
        .min(1)
        .max(2)
        .refine((roles) => {
          return new Set(roles).size === roles.length;
        }),
    }),
  ),
});
const impactSchema = object({
  expectedRevision: int().positive(),
  ownHostCount: int().nonnegative(),
  otherHostCount: int().nonnegative(),
  affectedOwners: array(
    object({
      userId: string(),
      displayName: string().nullable(),
    }),
  ),
  impactSnapshot: string().regex(/^[a-f0-9]{64}$/u),
});

interface OutputOptions {
  readonly json?: boolean;
}
interface InputOptions extends OutputOptions {
  readonly input: string;
}
interface ListOptions extends OutputOptions {
  readonly scope?: "personal" | "organization";
}

function requireCapability(write = false): void {
  const capability = write ? "connector:write" : "connector:read";
  const token = decodeSandboxTokenPayload();
  if (token && !token.capabilities.includes(capability)) {
    throw new Error(
      `This command requires ${capability}. Ask the owner to enable private-network management, then start a new Run.`,
    );
  }
}

function exactId(value: string): string {
  if (!uuid().safeParse(value).success) {
    throw new Error(
      "Invalid configuration ID. Use an exact ID from the configuration list.",
    );
  }
  return value;
}

function metadata(value: unknown) {
  const result = metadataSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      "Invalid private-network metadata response; credential values are not displayed.",
    );
  return result.data;
}

function print(
  value: unknown,
  json: boolean | undefined,
  guidance: string,
): void {
  console.log(JSON.stringify(value, null, 2));
  if (!json) console.log(guidance);
}

function scopeOption(): Option {
  return new Option("--scope <scope>", "Filter by configuration scope").choices(
    ["personal", "organization"],
  );
}

function networkCommand(kind: "cloudflare-access" | "tailscale"): Command {
  const cloudflare = kind === "cloudflare-access";
  const api = cloudflare ? cloudflareAccessNetworks : tailscaleNetworks;
  const contracts = cloudflare ? cloudflareAccessContract : tailscaleContract;
  const group = new Command(kind)
    .description(
      `Manage ${cloudflare ? "Cloudflare Access" : "Tailscale"} private-network configurations (not host access grants)`,
    )
    .addHelpText(
      "after",
      `
Credentials are accepted only inside JSON through --input <file|->, never flags.
Create input: { id?: UUID, name, scope?: "personal"|"organization", credentials: { clientId, clientSecret }${cloudflare ? "" : ', tags: ["tag:example"]'} }.
Omitting id generates a UUID. Save the returned ID; an uncertain write is not retried.
Update input: { expectedRevision, name?, credentials?${cloudflare ? "" : ", tags?"} }.
Delete input: { expectedRevision, impactSnapshot? }. Backend-required impact snapshots remain mandatory.
Set-scope input for organization: { expectedRevision }; for personal: { expectedRevision, impactSnapshot }.
Use impact --operation convert|delete before a scope conversion or referenced deletion.
No automatic revision refresh, retry, confirmation, reference binding, or access-grant changes.
Feature availability and organization administrator checks are enforced by the backend.
`,
    );

  group.addCommand(
    new Command("list")
      .description(
        "List safe configuration metadata and SSH/VNC host references",
      )
      .addOption(scopeOption())
      .option("--json", "Print JSON only")
      .action(
        withErrorHandler(async (options: ListOptions) => {
          requireCapability();
          const configs = (await api.list()).map(metadata).filter((config) => {
            return !options.scope || config.scope === options.scope;
          });
          print(
            { configs },
            options.json,
            configs.length
              ? "Use show <id> to inspect a configuration; update requires its revision."
              : `No configurations. Use okou remote-control ${kind} create --help.`,
          );
        }),
      ),
  );

  group.addCommand(
    new Command("show")
      .description(
        "Select one exact configuration ID from the scoped inventory",
      )
      .argument("<id>", "Configuration UUID")
      .addOption(scopeOption())
      .option("--json", "Print JSON only")
      .action(
        withErrorHandler(async (id: string, options: ListOptions) => {
          requireCapability();
          exactId(id);
          const config = (await api.list()).map(metadata).find((item) => {
            return (
              item.id === id && (!options.scope || item.scope === options.scope)
            );
          });
          if (!config)
            throw new Error(
              "Configuration unavailable in the selected scope. Refresh the configuration list.",
            );
          print(
            config,
            options.json,
            "Use the current revision in update input; credentials are never displayed.",
          );
        }),
      ),
  );

  group.addCommand(
    new Command("create")
      .description("Create a personal or organization configuration from JSON")
      .requiredOption(
        "--input <file|->",
        "JSON file or stdin; credentials are never echoed",
      )
      .option("--json", "Print JSON only")
      .action(
        withErrorHandler(async (options: InputOptions) => {
          requireCapability(true);
          const result = cloudflare
            ? await cloudflareAccessNetworks.create(
                await readManagementInput(
                  options.input,
                  cloudflareAccessContract.create.body.extend({
                    id: uuid().default(() => {
                      return randomUUID();
                    }),
                  }),
                ),
              )
            : await tailscaleNetworks.create(
                await readManagementInput(
                  options.input,
                  tailscaleContract.create.body.extend({
                    id: uuid().default(() => {
                      return randomUUID();
                    }),
                  }),
                ),
              );
          print(
            result.status === 204 ? result.body : metadata(result.body),
            options.json,
            `Created. Use okou remote-control ${kind} show <id> for current metadata.`,
          );
        }),
      ),
  );

  group.addCommand(
    new Command("update")
      .description(
        "Update fields using the caller's expectedRevision (no automatic retry)",
      )
      .argument("<id>", "Configuration UUID")
      .requiredOption("--input <file|->", "JSON update with expectedRevision")
      .option("--json", "Print JSON only")
      .action(
        withErrorHandler(async (id: string, options: InputOptions) => {
          requireCapability(true);
          exactId(id);
          const result = cloudflare
            ? await cloudflareAccessNetworks.update(
                id,
                await readManagementInput(
                  options.input,
                  cloudflareAccessContract.update.body,
                ),
              )
            : await tailscaleNetworks.update(
                id,
                await readManagementInput(
                  options.input,
                  tailscaleContract.update.body,
                ),
              );
          print(
            metadata(result),
            options.json,
            "Updated. Refresh host references before further changes; generation is backend-owned.",
          );
        }),
      ),
  );

  group.addCommand(
    new Command("delete")
      .description(
        "Delete with expectedRevision and any required impactSnapshot",
      )
      .argument("<id>", "Configuration UUID")
      .requiredOption(
        "--input <file|->",
        "JSON deletion with expectedRevision and optional impactSnapshot",
      )
      .option("--json", "Print JSON only")
      .action(
        withErrorHandler(async (id: string, options: InputOptions) => {
          requireCapability(true);
          exactId(id);
          const body = await readManagementInput(
            options.input,
            contracts.delete.body,
          );
          print(
            await api.delete(id, body),
            options.json,
            "Deleted. Refresh the configuration and host inventories.",
          );
        }),
      ),
  );

  group.addCommand(
    new Command("impact")
      .description(
        "Preview conversion/deletion references and obtain the required impactSnapshot",
      )
      .argument("<id>", "Configuration UUID")
      .addOption(
        new Option("--operation <operation>", "Intended mutation")
          .choices(["convert", "delete"])
          .makeOptionMandatory(),
      )
      .option("--json", "Print JSON only")
      .action(
        withErrorHandler(
          async (
            id: string,
            options: OutputOptions & {
              readonly operation: "convert" | "delete";
            },
          ) => {
            requireCapability();
            exactId(id);
            const result = impactSchema.safeParse(
              await api.impact(id, options.operation),
            );
            if (!result.success)
              throw new Error(
                "Invalid private-network impact response; credential values are not displayed.",
              );
            print(
              {
                revision: result.data.expectedRevision,
                references: {
                  ownHostCount: result.data.ownHostCount,
                  otherHostCount: result.data.otherHostCount,
                  affectedOwners: result.data.affectedOwners.map((owner) => {
                    return {
                      id: owner.userId,
                      name: owner.displayName,
                    };
                  }),
                  impactSnapshot: result.data.impactSnapshot,
                },
              },
              options.json,
              "Copy revision into expectedRevision and references.impactSnapshot into impactSnapshot in the mutation input. A changed snapshot must be reviewed again.",
            );
          },
        ),
      ),
  );

  group.addCommand(
    new Command("set-scope")
      .description(
        "Use existing scope conversion contracts without bypassing impact checks",
      )
      .argument("<id>", "Configuration UUID")
      .addOption(
        new Option("--scope <scope>", "Destination scope")
          .choices(["personal", "organization"])
          .makeOptionMandatory(),
      )
      .requiredOption(
        "--input <file|->",
        "JSON expectedRevision; personal also requires impactSnapshot",
      )
      .option("--json", "Print JSON only")
      .action(
        withErrorHandler(
          async (
            id: string,
            options: InputOptions & {
              readonly scope: "personal" | "organization";
            },
          ) => {
            requireCapability(true);
            exactId(id);
            const result =
              options.scope === "personal"
                ? await api.toPersonal(
                    id,
                    await readManagementInput(
                      options.input,
                      contracts.convertToPersonal.body,
                    ),
                  )
                : await api.toOrganization(
                    id,
                    await readManagementInput(
                      options.input,
                      contracts.convertToOrganization.body,
                    ),
                  );
            print(
              metadata(result),
              options.json,
              "Scope changed. Refresh the configuration and SSH/VNC host inventories.",
            );
          },
        ),
      ),
  );
  return group;
}

/** A fresh tree also prevents Commander option state leaking across parses. */
export function createRemoteControlCommand(): Command {
  return new Command("remote-control")
    .description(
      "Manage private-network configurations with connector read/write capabilities",
    )
    .addCommand(networkCommand("cloudflare-access"))
    .addCommand(networkCommand("tailscale"));
}

export const remoteControlCommand = createRemoteControlCommand();
