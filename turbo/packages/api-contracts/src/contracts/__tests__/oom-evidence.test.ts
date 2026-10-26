import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { object } from "zod";
import { oomEvidenceSchema } from "../oom-evidence";
import { webhookTelemetryContract } from "../webhooks";

const fixture: unknown = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../../crates/guest-contracts/tests/fixtures/oom-evidence-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

// Compared against production collector output by the Rust test
// collector_output_matches_api_fixture; paths are never normalized by tests.
const collector = object({
  initial: oomEvidenceSchema,
  sample: oomEvidenceSchema,
  cleanup: oomEvidenceSchema,
  tasks: oomEvidenceSchema,
}).parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../../../../crates/guest-control-server/tests/fixtures/oom-evidence-collector.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);

const workload = collector.tasks.groups[0].cgroup;
const taskDomain = `${workload}/tools/task-00000000-0000-0000-0000-000000000001`;
const nestedTaskDomain = `${taskDomain}/tools/task-00000000-0000-0000-0000-000000000002`;

describe("OOM evidence wire compatibility", () => {
  it("preserves the Rust collector's single-task and nested-task victims", () => {
    const oomEvidence = collector.tasks;
    expect(
      oomEvidence.incidents.map((incident) => {
        return incident.kernel_events[0]?.task_cgroup;
      }),
    ).toEqual([
      `${taskDomain}/tools/tool-95`,
      `${nestedTaskDomain}/tools/tool-269`,
    ]);
    expect(oomEvidence.incidents[1]?.kernel_events[0]?.oom_cgroup).toBe(
      nestedTaskDomain,
    );
    const body = { runId: "collector-run", oomEvidence };
    expect(webhookTelemetryContract.send.body.parse(body)).toEqual(body);
    const metricBody = {
      runId: "collector-run",
      metrics: [
        {
          ts: oomEvidence.sampled_at,
          cpu: 1,
          mem_used: 4096,
          mem_total: 16384,
          memory: oomEvidence,
        },
      ],
    };
    expect(webhookTelemetryContract.send.body.parse(metricBody)).toEqual(
      metricBody,
    );
  });

  it("accepts canonical task domains and leaves at each nesting level", () => {
    for (const domain of [
      taskDomain,
      nestedTaskDomain,
      `${nestedTaskDomain}/tools/task-ffffffff-ffff-ffff-ffff-ffffffffffff`,
    ]) {
      for (const suffix of [
        "",
        "/runtime",
        "/tools",
        "/tools/tool-0",
        "/tools/tool-18446744073709551615",
      ]) {
        for (const field of ["task_cgroup", "oom_cgroup"] as const) {
          const evidence = structuredClone(collector.tasks);
          const event = evidence.incidents[0]?.kernel_events[0];
          assert(event, "Expected a task collector kernel event");
          event[field] = `${domain}${suffix}`;
          expect(oomEvidenceSchema.parse(evidence)).toEqual(evidence);
        }
      }
    }
  });

  it("rejects malformed, aliased, unrelated and cross-operation task paths", () => {
    for (const path of [
      `${workload}/tools/task-1/runtime`,
      `${workload}/tools/task-00000000-0000-0000-0000-00000000000A/runtime`,
      `${taskDomain}/tools/task-1/runtime`,
      `${taskDomain}/tools/task-00000000-0000-0000-0000-00000000000A/runtime`,
      `${workload}/tools/task-{00000000-0000-0000-0000-000000000001}/runtime`,
      `${workload}/tools/task-00000000000000000000000000000001/runtime`,
      `${taskDomain}/`,
      `${taskDomain}/runtime/`,
      `${taskDomain}/runtime/../tools`,
      `${taskDomain}//runtime`,
      `${taskDomain}/%72untime`,
      `${taskDomain}/task-00000000-0000-0000-0000-000000000002/runtime`,
      `${taskDomain}/runtime/nested`,
      `${taskDomain}/tools/tool-1/../runtime`,
      `${taskDomain}/tools/tool-`,
      `${taskDomain}/tools/tool-1-2`,
      `${taskDomain}/tools/tool-${"1".repeat(21)}`,
      `${nestedTaskDomain}/tools/tool-1/nested`,
      `${nestedTaskDomain}/runtime\n`,
      `${nestedTaskDomain}/runtime\r`,
      `${nestedTaskDomain}/runtime\u2028`,
      `${taskDomain}${"/tools/task-00000000-0000-0000-0000-000000000002".repeat(5)}`,
      `${nestedTaskDomain}/runtime`.slice(1),
      `/sys/fs/cgroup${nestedTaskDomain}/runtime`,
      `${nestedTaskDomain}/runtime`.replace("exec-281-10-3", "exec-281-10-30"),
      "/host/tools/task-00000000-0000-0000-0000-000000000001/runtime",
    ]) {
      for (const field of ["task_cgroup", "oom_cgroup"] as const) {
        const evidence = structuredClone(collector.tasks);
        const event = evidence.incidents[0]?.kernel_events[0];
        assert(event, "Expected a task collector kernel event");
        event[field] = path;
        expect(oomEvidenceSchema.safeParse(evidence).success).toBe(false);
      }
    }
  });

  it("keeps fixed snapshots, group ordering and observation time strict for task evidence", () => {
    const nestedSnapshot = structuredClone(collector.tasks);
    nestedSnapshot.groups[2].cgroup = `${nestedTaskDomain}/tools`;
    const reorderedGroups = structuredClone(collector.tasks);
    reorderedGroups.groups = [
      reorderedGroups.groups[1],
      reorderedGroups.groups[0],
      reorderedGroups.groups[2],
    ];
    const oldEvent = structuredClone(collector.tasks);
    const event = oldEvent.incidents[1]?.kernel_events[0];
    assert(event, "Expected a nested task collector kernel event");
    event.boottime_us = oldEvent.started_boottime_us - 1;
    for (const evidence of [nestedSnapshot, reorderedGroups, oldEvent]) {
      expect(oomEvidenceSchema.safeParse(evidence).success).toBe(false);
    }
  });

  it("accepts collector output in mixed metric batches and urgent or fallback evidence", () => {
    for (const memory of [collector.initial, collector.sample]) {
      const body = {
        runId: "collector-run",
        systemLog: "synthetic system event",
        metrics: [
          {
            ts: memory.sampled_at,
            cpu: 1,
            mem_used: 4096,
            mem_total: 16384,
            memory,
          },
        ],
        sandboxOperations: [
          {
            ts: memory.sampled_at,
            action_type: "cli",
            duration_ms: 10,
            success: true,
          },
        ],
      };
      expect(webhookTelemetryContract.send.body.parse(body)).toEqual(body);
      expect(memory.groups[1].peak).toBeNull();
      expect(memory.groups[1].status).toBe("partial");
      expect(memory.groups[2].local_events.oom).toBeNull();
    }
    for (const oomEvidence of [collector.sample, collector.cleanup]) {
      const body = { runId: "collector-run", oomEvidence };
      expect(webhookTelemetryContract.send.body.parse(body)).toEqual(body);
    }
    expect(collector.sample.incidents).toEqual(collector.cleanup.incidents);
  });

  it("keeps rejecting relative, malformed and cross-operation collector paths", () => {
    for (const path of [
      "vm0-exec/exec-281-10-3/workload",
      "//vm0-exec/exec-281-10-3/workload",
      "/sys/fs/cgroup/vm0-exec/exec-281-10-3/workload",
      "/tmp/vm0-exec/exec-281-10-3/workload",
      "/vm0-exec/exec-281-10-30/workload",
    ]) {
      const evidence = structuredClone(collector.sample);
      evidence.groups[0].cgroup = path;
      expect(oomEvidenceSchema.safeParse(evidence).success).toBe(false);
      evidence.groups = structuredClone(collector.sample.groups);
      for (const incident of evidence.incidents) {
        incident.groups[0].cgroup = path;
      }
      expect(oomEvidenceSchema.safeParse(evidence).success).toBe(false);
    }
  });

  it("preserves the Rust fixture and accepts old senders without evidence", () => {
    expect(oomEvidenceSchema.parse(fixture)).toEqual(fixture);
    expect(
      webhookTelemetryContract.send.body.parse({
        runId: "old-run",
        metrics: [],
      }),
    ).toEqual({ runId: "old-run", metrics: [] });
    expect(
      webhookTelemetryContract.send.responses[200].parse({
        success: true,
        id: "old-run",
      }),
    ).toEqual({ success: true, id: "old-run" });
  });

  it("rejects unrelated cgroups, old kernel events, excessive records and sensitive fields", () => {
    const evidence = oomEvidenceSchema.parse(fixture);
    for (const invalid of [
      { ...evidence, prompt: "private" },
      {
        ...evidence,
        incidents: Array.from({ length: 5 }, () => {
          return evidence.incidents[0];
        }),
      },
      {
        ...evidence,
        incidents: evidence.incidents.map((incident) => {
          return {
            ...incident,
            kernel_events: Array.from({ length: 5 }, () => {
              return incident.kernel_events[0];
            }),
          };
        }),
      },
      {
        ...evidence,
        incidents: evidence.incidents.map((incident) => {
          return {
            ...incident,
            kernel_events: incident.kernel_events.map((event) => {
              return { ...event, boottime_us: 999 };
            }),
          };
        }),
      },
      {
        ...evidence,
        incidents: evidence.incidents.map((incident) => {
          return {
            ...incident,
            kernel_events: incident.kernel_events.map((event) => {
              return {
                ...event,
                task_cgroup: "/vm0-exec/exec-2-3-4/workload/runtime",
              };
            }),
          };
        }),
      },
    ]) {
      expect(oomEvidenceSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
