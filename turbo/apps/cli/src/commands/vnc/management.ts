import { Command } from "commander";
import { uuid, type output, type ZodType } from "zod";

import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { readManagementInput } from "../../lib/management-input";

export interface ManagementOptions {
  readonly json?: boolean;
}

export function requireVncManagementCapability(
  capability: "connector:read" | "connector:write",
) {
  const payload = decodeSandboxTokenPayload();
  if (payload && !payload.capabilities.includes(capability)) {
    throw new Error(
      `VNC management requires ${capability} for this Run. Ask the owner to enable connector management access, then start a new Run.`,
    );
  }
}

export function managementId(value: string): string {
  const parsed = uuid().safeParse(value);
  if (!parsed.success)
    throw new Error(
      "Use an exact UUID from the configured host or credential list.",
    );
  return parsed.data.toLowerCase();
}

export function outputManagement(
  value: unknown,
  options: ManagementOptions,
  next: string,
) {
  console.log(JSON.stringify(value, null, options.json ? undefined : 2));
  if (!options.json) console.log(next);
}

export function managementWriteCommand<T extends ZodType>(
  name: "create" | "update" | "delete",
  resource: "host" | "credential",
  schema: T,
  operation: (body: output<T>, id?: string) => Promise<unknown>,
) {
  const command = new Command(name)
    .description(
      `${name[0]?.toUpperCase()}${name.slice(1)} an owned VNC ${resource}`,
    )
    .requiredOption(
      "--input <file|->",
      "JSON input file, or - for stdin; never put secrets in command arguments",
    )
    .option("--json", "Print safe metadata JSON")
    .addHelpText(
      "after",
      `\nInput follows the VNC ${resource} ${name} contract. ${name === "create" ? "id is optional and defaults to a UUID." : resource === "host" ? "Include expectedGeneration from the current configured host metadata." : "Include expectedRevision from the current credential metadata."} Security profiles and transport bindings are enforced by the API. Management does not grant execution access. Credential values and PEM are never displayed.`,
    );
  if (resource === "host" && name !== "delete") {
    command.addHelpText(
      "after",
      `\nNative setup: list reusable configurations with okou remote-control cloudflare-access list or okou remote-control tailscale list. Set transport to {"type":"cloudflare_access","configId":"<uuid>"} with the TCP application hostname and port 443, or {"type":"tailscale","configId":"<uuid>"} with the exact peer IP/name and service port. Cloudflare X509 profiles need an explicit security.serverName independent of the gateway. Mac and authentication-only RSA-AES need SSH to literal server loopback, native Tailscale, or Cloudflare originTls {serverName,trust}; TLS must terminate on the selected server and forward only to local VNC. KDC transport is configured independently in security.kdc; ticket imports have no online KDC. Detached routes require an explicit configuration ID to rebind; configuration never grants chat execution access.`,
    );
  }
  if (name !== "create")
    command.argument("<id>", `Exact UUID from the configured ${resource} list`);
  const act = async (
    id: string | undefined,
    options: ManagementOptions & { input: string },
  ) => {
    requireVncManagementCapability("connector:write");
    const validatedId = id === undefined ? undefined : managementId(id);
    const body = await readManagementInput(options.input, schema);
    outputManagement(
      await operation(body, validatedId),
      options,
      resource === "host"
        ? "Inspect current configuration with okou vnc host list --scope configured --json."
        : "Inspect current metadata with okou vnc credential list --json.",
    );
  };
  if (name === "create") {
    command.action(
      withErrorHandler(
        async (options: ManagementOptions & { input: string }) => {
          await act(undefined, options);
        },
      ),
    );
  } else {
    command.action(
      withErrorHandler(
        async (id: string, options: ManagementOptions & { input: string }) => {
          await act(id, options);
        },
      ),
    );
  }
  return command;
}
