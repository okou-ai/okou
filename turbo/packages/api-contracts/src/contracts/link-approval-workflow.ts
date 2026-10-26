import { iso, object, uuid, enum as zEnum, type infer as zInfer } from "zod";

import { initContract } from "./base";

// Only purchase identity and its original deadline cross the Workflow boundary.
export const linkApprovalWorkflowParamsSchema = object({
  spendId: uuid(),
  deadline: iso.datetime(),
});
export type LinkApprovalWorkflowParams = zInfer<
  typeof linkApprovalWorkflowParamsSchema
>;
export const linkApprovalPollResultSchema = object({
  state: zEnum(["waiting", "done"]),
});

const c = initContract();
export const linkApprovalWorkflowContract = c.router({
  poll: {
    method: "POST",
    path: "/api/internal/link-approval/poll",
    body: object({ spendId: uuid() }),
    responses: { 200: linkApprovalPollResultSchema },
  },
});
