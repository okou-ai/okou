import { projectsContract } from "../contracts/projects";
import type { ClientResponseTransform } from "./types";

/**
 * Keep installed native readers on their known event enum without dropping
 * events or losing pagination frontiers. Sort writers already capture the
 * unchanged Project name, so a legacy rename preserves their existing state.
 * Remove each transform when its enforced native floor exceeds maxVersion.
 */
function legacyProjectEvents(body: unknown): unknown {
  const current = projectsContract.events.responses[200].parse(body);
  return {
    ...current,
    events: current.events.map((event) => {
      if (event.kind === "sort_updated" && event.name === null) {
        throw new Error("Project sort event has no captured name");
      }
      return {
        id: event.id,
        seqId: event.seqId,
        projectId: event.projectId,
        kind: event.kind === "sort_updated" ? "renamed" : event.kind,
        name: event.name,
        createdAt: event.createdAt,
      };
    }),
  };
}

export const iosProjectSortOrderTransform: ClientResponseTransform = {
  client: "ios",
  method: projectsContract.events.method,
  path: projectsContract.events.path,
  status: 200,
  maxVersion: "0.47.3",
  since: "#48352",
  transform: legacyProjectEvents,
};

export const androidProjectSortOrderTransform: ClientResponseTransform = {
  client: "android",
  method: projectsContract.events.method,
  path: projectsContract.events.path,
  status: 200,
  maxVersion: "0.19.1",
  since: "#48352",
  transform: legacyProjectEvents,
};
