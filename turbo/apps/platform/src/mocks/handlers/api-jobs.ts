import {
  jobsContract,
  jobSchema,
  type Job,
} from "@okouai/api-contracts/contracts/jobs";
import { mockApi } from "../msw-contract.ts";

const jobs = new Map<string, Job>();
export function resetMockJobs() {
  jobs.clear();
}
function refresh(job: Job): Job {
  return {
    ...job,
    hasPendingInput: job.inputs.length > job.work.processedInputIds.length,
    hasUnseenResult:
      job.work.currentResultId !== null &&
      !job.viewedResultIds.includes(job.work.currentResultId),
  };
}
const missing = { error: { code: "NOT_FOUND", message: "Job not found" } };
export const apiJobsHandlers = [
  mockApi(jobsContract.list, ({ query, respond }) => {
    const items = [...jobs.values()]
      .map(refresh)
      .filter((job) => {
        if (query.filter === "home")
          return (
            job.status !== "archived" &&
            (job.status !== "completed" ||
              job.hasPendingInput ||
              job.hasUnseenResult)
          );
        if (query.filter === "history")
          return job.status === "completed" && !job.hasUnseenResult;
        if (query.filter === "archived") return job.status === "archived";
        if (query.filter === "runnable")
          return (
            job.status !== "archived" &&
            (job.status === "active" || job.hasPendingInput)
          );
        return true;
      })
      .filter((job) => !query.after || job.id > query.after)
      .sort((left, right) => left.id.localeCompare(right.id));
    const limit = query.limit ?? 50;
    return respond(200, {
      jobs: items.slice(0, limit),
      nextAfter: items.length > limit ? (items[limit - 1]?.id ?? null) : null,
    });
  }),
  mockApi(jobsContract.get, ({ params, respond }) => {
    const job = jobs.get(params.id);
    return job ? respond(200, refresh(job)) : respond(404, missing);
  }),
  mockApi(jobsContract.create, ({ body, respond }) => {
    const existing = jobs.get(body.id);
    if (existing) return respond(200, refresh(existing));
    const at = new Date().toISOString();
    const job = jobSchema.parse({
      ...body,
      status: "active",
      work: {
        progress: "",
        explanation: "",
        authorization: null,
        processedInputIds: [],
        currentResultId: null,
      },
      authorizationRequests: [],
      inputs: [],
      results: [],
      viewedResultIds: [],
      hasPendingInput: false,
      hasUnseenResult: false,
      createdAt: at,
      updatedAt: at,
    });
    jobs.set(job.id, job);
    return respond(200, job);
  }),
  mockApi(jobsContract.update, ({ params, body, respond }) => {
    const job = jobs.get(params.id);
    if (!job) return respond(404, missing);
    if (
      job.status === "archived" ||
      JSON.stringify({ status: job.status, work: job.work }) !==
        JSON.stringify(body.expected)
    )
      return respond(409, {
        error: { code: "CONFLICT", message: "Read the current Job" },
      });
    const updated = refresh({
      ...job,
      status: body.status,
      work: body.work,
      results:
        body.result &&
        !job.results.some((result) => result.id === body.result?.id)
          ? [
              ...job.results,
              { ...body.result, publishedAt: new Date().toISOString() },
            ]
          : job.results,
      updatedAt: new Date().toISOString(),
    });
    jobs.set(job.id, updated);
    return respond(200, updated);
  }),
  mockApi(jobsContract.input, ({ params, body, respond }) => {
    const job = jobs.get(params.id);
    if (!job) return respond(404, missing);
    if (job.status === "archived")
      return respond(409, {
        error: { code: "CONFLICT", message: "This Job is archived" },
      });
    const updated = refresh({
      ...job,
      inputs: job.inputs.some((input) => input.id === body.id)
        ? job.inputs
        : [
            ...job.inputs,
            {
              ...body,
              authorUserId: "user_12345678",
              createdAt: new Date().toISOString(),
            },
          ],
    });
    jobs.set(job.id, updated);
    return respond(200, updated);
  }),
  mockApi(jobsContract.viewed, ({ params, body, respond }) => {
    const job = jobs.get(params.id);
    if (!job) return respond(404, missing);
    const updated = refresh({
      ...job,
      viewedResultIds: [...new Set([...job.viewedResultIds, body.resultId])],
    });
    jobs.set(job.id, updated);
    return respond(200, updated);
  }),
  mockApi(jobsContract.archive, ({ params, respond }) => {
    const job = jobs.get(params.id);
    if (!job) return respond(404, missing);
    const updated = { ...job, status: "archived" as const };
    jobs.set(job.id, updated);
    return respond(200, refresh(updated));
  }),
];
