import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { mockApi } from "../msw-contract.ts";

export const apiProjectsHandlers = [
  mockApi(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: [],
      latestEventId: null,
      latestSeqId: 0,
    });
  }),
  mockApi(projectsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  }),
];
