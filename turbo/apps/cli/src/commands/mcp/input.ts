import { createReadStream } from "node:fs";

import type { JSONObject } from "@modelcontextprotocol/client";
import { InvalidArgumentError } from "commander";
import { json, record, string } from "zod";

import { parseDurationSeconds } from "../shared/duration";

const MAX_TOOL_INPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 15 * 60;

const toolInputSchema = record(string(), json());

interface McpCallInputOptions {
  readonly input?: string;
  readonly inputFile?: string;
}

class InputTooLargeError extends Error {}

async function readBoundedUtf8(
  source: AsyncIterable<Buffer | string>,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of source) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += buffer.byteLength;
    if (bytes > MAX_TOOL_INPUT_BYTES) {
      throw new InputTooLargeError();
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, bytes).toString("utf8");
}

async function readInputFile(path: string): Promise<string> {
  try {
    return await readBoundedUtf8(createReadStream(path));
  } catch (error) {
    if (error instanceof InputTooLargeError) {
      throw error;
    }
    throw new Error(`Unable to read MCP tool input file "${path}"`);
  }
}

function parseToolInput(rawInput: string): JSONObject {
  if (Buffer.byteLength(rawInput, "utf8") > MAX_TOOL_INPUT_BYTES) {
    throw new InputTooLargeError();
  }

  const normalizedInput = rawInput.trim() === "" ? "{}" : rawInput;
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedInput);
  } catch {
    throw new Error("MCP tool input must be valid JSON");
  }

  const result = toolInputSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("MCP tool input must be a JSON object");
  }
  return result.data;
}

export async function resolveMcpToolInput(
  options: McpCallInputOptions,
): Promise<JSONObject> {
  if (options.input !== undefined && options.inputFile !== undefined) {
    throw new Error("Use only one of --input or --input-file");
  }

  try {
    if (options.input !== undefined) {
      return parseToolInput(options.input);
    }
    if (options.inputFile !== undefined) {
      return parseToolInput(await readInputFile(options.inputFile));
    }
    if (!process.stdin.isTTY) {
      return parseToolInput(await readBoundedUtf8(process.stdin));
    }
    return {};
  } catch (error) {
    if (error instanceof InputTooLargeError) {
      throw new Error("MCP tool input exceeds the 1 MiB limit");
    }
    throw error;
  }
}

export function parseMcpTimeoutSeconds(value: string): number {
  let seconds: number;
  try {
    seconds = parseDurationSeconds(value);
  } catch {
    throw new InvalidArgumentError(
      "timeout must use <number><unit> with unit s or m",
    );
  }

  if (seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
    throw new InvalidArgumentError("timeout must be between 1s and 15m");
  }
  return seconds;
}

export { DEFAULT_TIMEOUT_SECONDS };
