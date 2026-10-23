import * as z from "zod";

/**
 * The local tool an imported workflow's skill came from. The skill import
 * records it when it creates the workflow; a workflow made in Okou has none.
 */
export const workflowImportSourceSchema = z.enum(["claudeCode", "codex"]);
export type WorkflowImportSource = z.infer<typeof workflowImportSourceSchema>;
