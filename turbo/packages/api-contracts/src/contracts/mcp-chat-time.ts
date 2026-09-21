import { z } from "zod";

export const mcpChatOutputTimestampSchema = z.iso.datetime({ precision: 6 });

export const mcpFilterTimestampSchema = z.iso
  .datetime()
  .regex(/:\d{2}(?:\.\d{1,6})?Z$/u, "Use at most six fractional-second digits");

export function formatMcpChatTimestamp(value: Date | string): string {
  const timestamp =
    value instanceof Date
      ? value.toISOString()
      : mcpFilterTimestampSchema.parse(value);
  const withoutZone = timestamp.slice(0, -1);
  const normalized = timestamp.includes(".")
    ? withoutZone.padEnd(26, "0")
    : `${withoutZone}.000000`;
  return mcpChatOutputTimestampSchema.parse(`${normalized}Z`);
}

export function mcpTimestampKey(value: string): string {
  return formatMcpChatTimestamp(value).slice(0, -1);
}
