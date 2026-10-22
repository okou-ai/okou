import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  jobsContract,
  type JobCreate,
  type JobUpdate,
  type JobListQuery,
} from "@okouai/api-contracts/contracts/jobs";
import { getClientConfig, handleError } from "../core/client-factory";

export async function listJobs(query: JobListQuery) {
  const client = initClient(jobsContract, await getClientConfig());
  const result = await client.list({ query, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to list Jobs");
}
export async function getJob(id: string) {
  const client = initClient(jobsContract, await getClientConfig());
  const result = await client.get({ params: { id }, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to read Job");
}
export async function createJob(body: JobCreate) {
  const client = initClient(jobsContract, await getClientConfig());
  const result = await client.create({ body, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to create Job");
}
export async function updateJob(id: string, body: JobUpdate) {
  const client = initClient(jobsContract, await getClientConfig());
  const result = await client.update({ params: { id }, body, headers: {} });
  if (result.status === 200) return result.body;
  handleError(
    result,
    "Failed to update Job; read its current state before another action",
  );
}
