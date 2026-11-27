import { command } from "ccstate";
import { object, uuid } from "zod";
import { now } from "../../lib/time";
import { settleIncludingAbort } from "../utils";
import {
  claimBackgroundJob$,
  transitionBackgroundJob$,
} from "./background-job-command.service";
import {
  DOMAIN_RECHECK_MS,
  DOMAIN_ATTEMPT_TIMEOUT_MS,
  HOSTED_DOMAIN_JOB_KIND,
  recheckHostedDomain$,
} from "./hosted-site-domains.service";

const inputSchema = object({
  siteId: uuid(),
  domainId: uuid(),
  expectedRevision: uuid(),
});

export const processHostedDomainChecks$ = command(
  async ({ set }, signal: AbortSignal) => {
    let processed = 0;
    // Each attempt has an 8s I/O budget; leave room in the shared 50s cron window.
    for (let i = 0; i < 4; i++) {
      const job = await set(
        claimBackgroundJob$,
        { kind: HOSTED_DOMAIN_JOB_KIND, handlerVersion: 1 },
        signal,
      );
      signal.throwIfAborted();
      if (!job) {
        break;
      }
      const input = inputSchema.safeParse(job.input);
      if (!input.success) {
        await set(
          transitionBackgroundJob$,
          job,
          { kind: "fail", error: "Invalid domain verification job input" },
          signal,
        );
        signal.throwIfAborted();
        continue;
      }
      const attemptSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(DOMAIN_ATTEMPT_TIMEOUT_MS),
      ]);
      const result = await settleIncludingAbort(
        set(
          recheckHostedDomain$,
          { ...input.data, userId: job.userId, orgId: job.orgId },
          job.id,
          attemptSignal,
        ),
      );
      signal.throwIfAborted();
      const next = now() + DOMAIN_RECHECK_MS;
      const transition = !result.ok
        ? {
            kind: "retry" as const,
            availableAt: new Date(next),
            error: String(result.error),
          }
        : result.value?.status === "checking"
          ? {
              kind: "defer" as const,
              availableAt: new Date(
                Math.min(next, Date.parse(result.value.expiresAt)),
              ),
            }
          : { kind: "complete" as const, checkpoint: {} };
      await set(transitionBackgroundJob$, job, transition, signal);
      signal.throwIfAborted();
      processed++;
    }
    return processed;
  },
);
