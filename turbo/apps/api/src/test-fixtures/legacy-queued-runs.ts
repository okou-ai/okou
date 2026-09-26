import { withLegacyQueuedRunAdmissionForTest } from "../signals/services/legacy-queued-run-admission.service";

/**
 * Earlier API versions queued runs at the organization capacity limit, and
 * promotion still drains them. Route tests of that promotion path create
 * legacy queued runs through the real create endpoints inside this scope.
 */
export async function createLegacyQueuedRunFixture<T>(
  create: () => Promise<T>,
): Promise<T> {
  return await withLegacyQueuedRunAdmissionForTest(create);
}
