import { readFile } from "node:fs/promises";
import type { output, ZodType } from "zod";
import { ApiRequestError } from "./api/core/client-factory";

const MAX_INPUT_BYTES = 1_048_576;

/** Credential-bearing input is never included in validation errors. */
export async function readManagementInput<T extends ZodType>(
  source: string,
  schema: T,
): Promise<output<T>> {
  let text: string;
  if (source === "-") {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_INPUT_BYTES) {
        throw new Error("Configuration input must not exceed 1 MiB.");
      }
      chunks.push(buffer);
    }
    text = Buffer.concat(chunks).toString("utf8");
  } else {
    text = await readFile(source, "utf8");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
    throw new Error("Configuration input must not exceed 1 MiB.");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON input. Credential values are not displayed.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "Invalid configuration input. Check the command's input contract; credential values are not displayed.",
    );
  }
  return parsed.data;
}

/** Do not reflect a server error body that could contain submitted secrets. */
export function handleManagementError(
  result: { readonly status: number },
  message: string,
): never {
  const guidance =
    result.status === 409
      ? " Refresh the resource revision and check its references before trying again."
      : result.status === 401 || result.status === 403
        ? " Check authentication, management permissions and organization role."
        : " Check the resource ID and input contract.";
  throw new ApiRequestError(
    `${message} (HTTP ${result.status}).${guidance}`,
    "MANAGEMENT_REQUEST_FAILED",
    result.status,
  );
}
