import type {
  JobInput,
  JobAuthorizationRequest,
  JobResult,
  JobWork,
} from "@okouai/api-contracts/contracts/jobs";

export type UserJobWork = JobWork;
export type UserJobAuthorizationRequests = readonly JobAuthorizationRequest[];
export type UserJobInputs = readonly JobInput[];
export type UserJobResults = readonly JobResult[];
export type UserJobReferences = readonly string[];
export type UserJobViewedResultIds = readonly string[];
