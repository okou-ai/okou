import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  jobsContract,
  type JobCreate,
  type JobUpdate,
  type JobListQuery,
  type JobObservationCreate,
} from "@okouai/api-contracts/contracts/jobs";
import { getClientConfig, handleError } from "../core/client-factory";

export async function listJobs(query: JobListQuery) {
  const client = initClient(jobsContract, await getClientConfig());
  const result = await client.list({ query, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to list Tasks");
}
export async function deriveJobIdentity(key: string) {
  const client = initClient(jobsContract, await getClientConfig());
  const result = await client.identity({ body: { key }, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to derive Task identity");
}
export async function observeJob(id: string, body: JobObservationCreate) {
  const client = initClient(jobsContract, await getClientConfig());
  const result = await client.observe({ params: { id }, body, headers: {} });
  if (result.status === 200) return result.body;
  handleError(
    result,
    "Failed to append source context; read the current Task before retrying",
  );
}
export async function getJob(id: string) {
  const client = initClient(jobsContract, await getClientConfig());
  const result = await client.get({ params: { id }, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to read Task");
}
export async function createJob(body: JobCreate) {
  const client = initClient(jobsContract, await getClientConfig());
  const result = await client.create({ body, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to create Task");
}
export async function updateJob(id: string, body: JobUpdate) {
  const client = initClient(jobsContract, await getClientConfig());
  const result = await client.update({ params: { id }, body, headers: {} });
  if (result.status === 200) return result.body;
  handleError(
    result,
    "Failed to update Task; read its current state before another action",
  );
}
