import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  linkApprovalWorkflowParamsSchema,
  type LinkApprovalWorkflowParams,
} from "@okouai/api-contracts/contracts/link-approval-workflow";
import { controlAuthorized } from "./auth";
import {
  FINAL_CHECK_GRACE_MS,
  pollApproval,
  pollApprovalBlock,
  type Env,
} from "./workflow";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/start")
      return new Response("Not found", { status: 404 });
    if (!(await controlAuthorized(request, env.LINK_APPROVAL_CONTROL_SECRET)))
      return new Response("Unauthorized", { status: 401 });
    if (env.LINK_APPROVAL_ENABLED !== "true")
      return new Response("Disabled", { status: 503 });
    const raw = await request.text();
    if (raw.length > 1024) return new Response("Too large", { status: 413 });
    let input: unknown;
    try {
      input = JSON.parse(raw) as unknown;
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const parsed = linkApprovalWorkflowParamsSchema.safeParse(input);
    if (!parsed.success) return new Response("Bad request", { status: 400 });
    const params = parsed.data;
    const remaining = Date.parse(params.deadline) - Date.now();
    if (remaining > 30 * 60_000 || remaining < -FINAL_CHECK_GRACE_MS)
      return new Response("Outside approval window", { status: 410 });
    // Stable identity makes ambiguous starts safe to retry. Never replace an
    // existing instance with a new deadline or a new purchase request.
    try {
      await env.LINK_APPROVAL_WORKFLOW.create({ id: params.spendId, params });
    } catch (error) {
      const instance = await env.LINK_APPROVAL_WORKFLOW.get(params.spendId);
      const status = await instance.status();
      if (status.status === "unknown") throw error;
      if (status.status === "errored") await instance.restart();
    }
    return Response.json({ ok: true });
  },
};

export class LinkApprovalWorkflow extends WorkflowEntrypoint<
  Env,
  LinkApprovalWorkflowParams
> {
  async run(
    event: WorkflowEvent<LinkApprovalWorkflowParams>,
    step: WorkflowStep,
  ) {
    const params = linkApprovalWorkflowParamsSchema.parse(event.payload);
    const deadline = Date.parse(params.deadline);
    for (let block = 0; block < 30 && Date.now() < deadline; block++) {
      const done = await step.do(
        `poll-${block}`,
        {
          timeout: "2 minutes",
          retries: { limit: 2, delay: "5 seconds", backoff: "constant" },
        },
        () => {
          return pollApprovalBlock(this.env, params);
        },
      );
      if (done) return;
    }
    // A final provider observation closes the window. Failed requests remain
    // errors, never a fabricated denial. Recovery has the same absolute bound.
    await step.do(
      "final-check",
      {
        timeout: "20 seconds",
        retries: { limit: 2, delay: "5 seconds", backoff: "constant" },
      },
      async () => {
        if (Date.now() > deadline + FINAL_CHECK_GRACE_MS)
          throw new Error("Link approval final status could not be confirmed");
        const result = await pollApproval(this.env, params.spendId);
        if (result.state !== "done")
          throw new Error("Link approval delivery is still pending");
      },
    );
  }
}
