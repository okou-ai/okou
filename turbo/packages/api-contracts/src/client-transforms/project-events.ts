import { projectsContract } from "../contracts/projects";
import type { ClientResponseTransform } from "./types";

/**
 * Archive Project's native readers adopt the new lifecycle kinds after iOS
 * 0.45.0 and Android 0.14.0. Older readers can replay them as name-preserving
 * renames without losing the event identity or stream position. Remove each
 * transform and its route wiring when that client's enforced floor excludes
 * the corresponding cutoff, as part of the Archive Project rollout cleanup.
 */
function legacyProjectEvents(body: unknown): unknown {
  const current = projectsContract.events.responses[200].parse(body);
  return {
    ...current,
    events: current.events.map((event) => {
      return event.kind === "archived" || event.kind === "restored"
        ? { ...event, kind: "renamed" }
        : event;
    }),
  };
}

export const iosProjectEventsTransform: ClientResponseTransform = {
  client: "ios",
  method: projectsContract.events.method,
  path: projectsContract.events.path,
  status: 200,
  maxVersion: "0.45.0",
  since: "#47683",
  transform: legacyProjectEvents,
};

export const androidProjectEventsTransform: ClientResponseTransform = {
  client: "android",
  method: projectsContract.events.method,
  path: projectsContract.events.path,
  status: 200,
  maxVersion: "0.14.0",
  since: "#47683",
  transform: legacyProjectEvents,
};
