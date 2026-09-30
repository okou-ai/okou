import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import {
  withBuiltInModelRuntimeRouteCandidateUnavailableForTest as withRuntimeRouteCandidateUnavailable,
  withBuiltInModelRuntimeRouteUnavailableForTest as withRuntimeRouteUnavailable,
} from "../signals/services/built-in-model-runtime-route.service";

const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.int() });

interface BuiltInModelRuntimeRouteFixtureIdentity {
  readonly selectedModel: string;
  readonly providerType: string;
  readonly upstreamModel: string;
}

interface HeldBuiltInModelRouteBoundary {
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
  readonly cancelBlockedQueries: () => Promise<number>;
}

/**
 * Missing operator-managed keys are global infrastructure state and cannot be
 * isolated through a user-facing API. This fixture scopes that state to one
 * async request chain so route tests never delete or restore shared key rows.
 */
export function withBuiltInModelRuntimeRouteUnavailableForTest<T>(
  selectedModel: string,
  work: () => Promise<T>,
): Promise<T> {
  return withRuntimeRouteUnavailable(selectedModel, work);
}

/**
 * A candidate cooldown is global infrastructure state. Scope the unavailable
 * candidate to one async test flow while preserving normal route selection.
 */
export function withBuiltInModelRuntimeRouteCandidateUnavailableForTest<T>(
  candidate: BuiltInModelRuntimeRouteFixtureIdentity,
  work: () => Promise<T>,
): Promise<T> {
  return withRuntimeRouteCandidateUnavailable(candidate, work);
}
