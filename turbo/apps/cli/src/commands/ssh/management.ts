import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { preprocess, uuid } from "zod";
import {
  createSshConnectionRequestSchema,
  updateSshConnectionRequestSchema,
  resetSshConnectionHostKeyRequestSchema,
  deleteSshConnectionRequestSchema,
} from "@okouai/api-contracts/contracts/ssh-connections";
import {
  sshCredentialsContract,
  updateSshCredentialRequestSchema,
} from "@okouai/api-contracts/contracts/ssh-credentials";
import {
  createSshHost,
  updateSshHost,
  deleteSshHost,
  resetSshHostKey,
  showConfiguredSshHost,
  listSshCredentials,
  showSshCredential,
  createSshCredential,
  updateSshCredential,
  deleteSshCredential,
} from "../../lib/api/domains/ssh-management";
import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { readManagementInput } from "../../lib/management-input";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface OutputOptions {
  readonly json?: boolean;
}
interface InputOptions extends OutputOptions {
  readonly input: string;
}

export function requireSandboxCapability(
  capability: "connector:read" | "connector:write",
): void {
  const payload = decodeSandboxTokenPayload();
  if (payload && !payload.capabilities.includes(capability)) {
    throw new Error(
      `SSH management requires ${capability} for this Run. Ask the owner to enable it, then start a new Run.`,
    );
  }
}

function resourceId(value: string): string {
  const parsed = uuid().safeParse(value);
  if (!parsed.success)
    throw new Error(
      "Invalid SSH resource ID. Use an exact ID from the management list.",
    );
  return parsed.data;
}

function output(value: unknown, options: OutputOptions): void {
  console.log(JSON.stringify(value, null, options.json ? undefined : 2));
}

const hostCreateInputSchema = preprocess((value) => {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !("id" in value)
  ) {
    return { ...value, id: randomUUID() };
  }
  return value;
}, createSshConnectionRequestSchema);
const credentialCreateInputSchema = sshCredentialsContract.create.body.extend({
  id: uuid().default(randomUUID),
});

export function addSshHostManagementCommands(host: Command): Command {
  return host
    .addCommand(
      new Command("show")
        .description(
          "Show owned host configuration metadata (not a connectivity check)",
        )
        .argument("<connection-id>", "Configured host UUID")
        .option("--json", "Print JSON")
        .action(
          withErrorHandler(async (id: string, options: OutputOptions) => {
            requireSandboxCapability("connector:read");
            output(await showConfiguredSshHost(resourceId(id)), options);
          }),
        ),
    )
    .addCommand(
      new Command("create")
        .description(
          "Create an owned SSH host; does not grant this Run execution access",
        )
        .requiredOption("--input <file|->", "JSON file, or - for stdin")
        .option("--json", "Print safe metadata as JSON")
        .addHelpText(
          "after",
          `\nInput: {id?, displayName, host, port?, credential: {id} | {create: {name, username, authentication}}, transport?}.
An omitted id is generated. authentication is {method: "password", password} or {method: "private_key", privateKey, passphrase?}.
transport uses the API shape: {type: "direct"}, {type: "cloudflare_access", configId}, {type: "tailscale", configId} or {type: "tailscale_ssh", configId}; API-supported inline create is also accepted. Access requires port 443.
Tailscale SSH uses {displayName, host, username, transport: {type: "tailscale_ssh", configId}} with port 22 and no credential. Both Tailscale modes reuse saved network configurations.
Credentials are write-only: provide them via --input, never command-line password options.\n`,
        )
        .action(
          withErrorHandler(async (options: InputOptions) => {
            requireSandboxCapability("connector:write");
            const body = await readManagementInput(
              options.input,
              hostCreateInputSchema,
            );
            output(await createSshHost(body), options);
          }),
        ),
    )
    .addCommand(
      new Command("update")
        .description("Update an owned SSH host using its current generation")
        .argument("<connection-id>", "Configured host UUID")
        .requiredOption("--input <file|->", "JSON file, or - for stdin")
        .option("--json", "Print safe metadata as JSON")
        .addHelpText(
          "after",
          "\nInput: {expectedGeneration, displayName?, host?, port?, credential?, username?, transport?}. Read the current generation with ssh host show. Credential and transport shapes match create; unknown fields are rejected. Tailscale SSH requires port 22 and username without credential; switching to another mode requires a credential.\n",
        )
        .action(
          withErrorHandler(async (id: string, options: InputOptions) => {
            requireSandboxCapability("connector:write");
            const connectionId = resourceId(id);
            const body = await readManagementInput(
              options.input,
              updateSshConnectionRequestSchema,
            );
            output(await updateSshHost(connectionId, body), options);
          }),
        ),
    )
    .addCommand(
      new Command("delete")
        .description("Delete an owned host using the generation you reviewed")
        .argument("<connection-id>", "Configured host UUID")
        .requiredOption(
          "--input <file|->",
          "JSON {expectedGeneration}; file or - for stdin",
        )
        .option("--json", "Print JSON")
        .addHelpText(
          "after",
          "\nReview the host with okou ssh host show <connection-id>, then supply its expectedGeneration. A conflict requires another review and explicit delete; deletion never fetches or retries automatically.\n",
        )
        .action(
          withErrorHandler(async (id: string, options: InputOptions) => {
            requireSandboxCapability("connector:write");
            const connectionId = resourceId(id);
            const body = await readManagementInput(
              options.input,
              deleteSshConnectionRequestSchema.required(),
            );
            output(
              await deleteSshHost(connectionId, body.expectedGeneration),
              options,
            );
          }),
        ),
    )
    .addCommand(
      new Command("reset-host-key")
        .description(
          "Reset a learned key only after independently verifying the new host key",
        )
        .argument("<connection-id>", "Configured host UUID")
        .requiredOption(
          "--input <file|->",
          "JSON {expectedGeneration}; file or - for stdin",
        )
        .option("--json", "Print safe metadata as JSON")
        .action(
          withErrorHandler(async (id: string, options: InputOptions) => {
            requireSandboxCapability("connector:write");
            const connectionId = resourceId(id);
            const body = await readManagementInput(
              options.input,
              resetSshConnectionHostKeyRequestSchema,
            );
            output(
              await resetSshHostKey(connectionId, body.expectedGeneration),
              options,
            );
          }),
        ),
    );
}

export function createSshCredentialCommand(): Command {
  return new Command("credential")
    .description(
      "Manage owned reusable SSH credentials; credential values are write-only",
    )
    .addCommand(
      new Command("list")
        .description("List safe credential metadata and host references")
        .option("--json", "Print JSON")
        .action(
          withErrorHandler(async (options: OutputOptions) => {
            requireSandboxCapability("connector:read");
            output(await listSshCredentials(), options);
          }),
        ),
    )
    .addCommand(
      new Command("show")
        .description("Show safe metadata for an owned credential")
        .argument("<credential-id>", "Credential UUID")
        .option("--json", "Print JSON")
        .action(
          withErrorHandler(async (id: string, options: OutputOptions) => {
            requireSandboxCapability("connector:read");
            output(await showSshCredential(resourceId(id)), options);
          }),
        ),
    )
    .addCommand(
      new Command("create")
        .description("Create a write-only SSH credential from JSON")
        .requiredOption("--input <file|->", "JSON file, or - for stdin")
        .option("--json", "Print safe metadata as JSON")
        .addHelpText(
          "after",
          `\nInput: {id?, name, username, authentication}. An omitted id is generated.
authentication: {method: "password", password} or {method: "private_key", privateKey, passphrase?}.
Unknown fields are rejected. Credential values are never displayed.\n`,
        )
        .action(
          withErrorHandler(async (options: InputOptions) => {
            requireSandboxCapability("connector:write");
            const body = await readManagementInput(
              options.input,
              credentialCreateInputSchema,
            );
            output(await createSshCredential(body), options);
          }),
        ),
    )
    .addCommand(
      new Command("update")
        .description(
          "Update a credential using its current revision; affects referenced hosts",
        )
        .argument("<credential-id>", "Credential UUID")
        .requiredOption("--input <file|->", "JSON file, or - for stdin")
        .option("--json", "Print safe metadata as JSON")
        .addHelpText(
          "after",
          "\nInput: {expectedRevision, name?, username?, authentication?}. Read the current revision with ssh credential show. Authentication matches create; omitted fields remain unchanged.\n",
        )
        .action(
          withErrorHandler(async (id: string, options: InputOptions) => {
            requireSandboxCapability("connector:write");
            const credentialId = resourceId(id);
            const body = await readManagementInput(
              options.input,
              updateSshCredentialRequestSchema,
            );
            output(await updateSshCredential(credentialId, body), options);
          }),
        ),
    )
    .addCommand(
      new Command("delete")
        .description("Delete an unused credential using its current revision")
        .argument("<credential-id>", "Credential UUID")
        .requiredOption(
          "--input <file|->",
          "JSON {expectedRevision}; file or - for stdin",
        )
        .option("--json", "Print JSON")
        .action(
          withErrorHandler(async (id: string, options: InputOptions) => {
            requireSandboxCapability("connector:write");
            const credentialId = resourceId(id);
            const body = await readManagementInput(
              options.input,
              sshCredentialsContract.delete.body,
            );
            output(
              await deleteSshCredential(credentialId, body.expectedRevision),
              options,
            );
          }),
        ),
    );
}
