import { enum as zodEnum, type infer as Infer } from "zod";

/**
 * The local tool an imported workflow's skill came from. The skill import
 * records it when it creates the workflow; a workflow made in Okou has none.
 */
export const workflowImportSourceSchema = zodEnum(["claudeCode", "codex"]);
export type WorkflowImportSource = Infer<typeof workflowImportSourceSchema>;
