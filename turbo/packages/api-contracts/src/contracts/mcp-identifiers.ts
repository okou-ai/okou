import * as z from "zod";

/** Canonical entity references in declared MCP arguments and responses. */
export const mcpThreadIdSchema = z.uuid();
export const mcpRunIdSchema = z.uuid();
export const mcpEventIdSchema = z.uuid();
