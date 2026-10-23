import * as z from "zod";
import { initContract } from "./base";

// Only purchase identity and its original deadline cross the Workflow boundary.
export const linkApprovalWorkflowParamsSchema = z.object({
  spendId: z.uuid(),
  deadline: z.iso.datetime(),
});
export type LinkApprovalWorkflowParams = z.infer<
  typeof linkApprovalWorkflowParamsSchema
>;
export const linkApprovalPollResultSchema = z.object({
  state: z.enum(["waiting", "done"]),
});

const c = initContract();
export const linkApprovalWorkflowContract = c.router({
  poll: {
    method: "POST",
    path: "/api/internal/link-approval/poll",
    body: z.object({ spendId: z.uuid() }),
    responses: { 200: linkApprovalPollResultSchema },
  },
});
