import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { JobStatus } from "@okouai/api-contracts/contracts/jobs";
import type {
  UserJobInputs,
  UserJobAuthorizationRequests,
  UserJobReferences,
  UserJobResults,
  UserJobViewedResultIds,
  UserJobWork,
} from "../jsonb-contracts/user-job";

export const userJobs = pgTable(
  "user_jobs",
  {
    id: uuid("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    sourceReferences: jsonb("source_references")
      .$type<UserJobReferences>()
      .notNull()
      .default([]),
    status: text("status").$type<JobStatus>().notNull().default("active"),
    work: jsonb("work").$type<UserJobWork>().notNull().default({
      progress: "",
      explanation: "",
      authorization: null,
      processedInputIds: [],
      currentResultId: null,
    }),
    authorizationRequests: jsonb("authorization_requests")
      .$type<UserJobAuthorizationRequests>()
      .notNull()
      .default([]),
    inputs: jsonb("inputs").$type<UserJobInputs>().notNull().default([]),
    results: jsonb("results").$type<UserJobResults>().notNull().default([]),
    viewedResultIds: jsonb("viewed_result_ids")
      .$type<UserJobViewedResultIds>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => {
    return [
      index("user_jobs_owner_id_idx").on(
        table.orgId,
        table.ownerUserId,
        table.id,
      ),
      index("user_jobs_runnable_owner_idx")
        .on(table.orgId, table.ownerUserId)
        .where(
          sql`${table.status} <> 'archived' AND (${table.status} = 'active' OR jsonb_array_length(${table.inputs}) > jsonb_array_length(${table.work}->'processedInputIds'))`,
        ),
      check(
        "user_jobs_status_check",
        sql`${table.status} IN ('active', 'waiting_decision', 'waiting_authorization', 'completed', 'archived')`,
      ),
      check(
        "user_jobs_arrays_check",
        sql`jsonb_typeof(${table.inputs}) = 'array' AND jsonb_typeof(${table.results}) = 'array' AND jsonb_typeof(${table.viewedResultIds}) = 'array' AND jsonb_typeof(${table.work}->'processedInputIds') = 'array'`,
      ),
    ];
  },
);
