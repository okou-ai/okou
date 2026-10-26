import { uuid } from "zod";

/** Canonical entity references in declared MCP arguments and responses. */
export const mcpThreadIdSchema = uuid();
export const mcpRunIdSchema = uuid();
export const mcpEventIdSchema = uuid();
