import * as z from "zod";

// Same bounded metadata contract as guest-contracts::oom_evidence. Null means
// unavailable, including kernels that do not expose a particular field.
const counter = z.number().int().nonnegative().nullable();
const status = z.enum([
  "available",
  "missing",
  "partial",
  "unavailable",
  "denied",
  "truncated",
  "overwritten",
  "uncorrelated",
  "recreated",
]);
const cgroup = z
  .string()
  .max(256)
  .regex(
    /^\/vm0-exec\/exec-[0-9-]+\/workload(?:\/(?:runtime|tools(?:\/tool-[0-9-]+)?))?$/,
  );
// Match guest-contracts::managed_task::owned_task_path, including canonical
// lowercase UUIDs that are not restricted to a particular UUID version.
const taskHandle =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const managedTaskCgroup = z
  .string()
  .max(256)
  .regex(
    new RegExp(
      String.raw`^/vm0-exec/exec-[0-9-]+/workload(?:/tools/task-${taskHandle})+(?:/(?:runtime|tools(?:/tool-[0-9]{1,20})?))?$(?![\s\S])`,
    ),
  );
const kernelCgroup = z.union([cgroup, managedTaskCgroup]);
const limit = z
  .string()
  .max(20)
  .regex(/^(?:max|[0-9]+)$/)
  .nullable();
const events = z
  .object({
    high: counter,
    max: counter,
    oom: counter,
    oom_kill: counter,
    oom_group_kill: counter,
  })
  .strict();
const memorySnapshotSchema = z
  .object({
    role: z.enum(["workload", "runtime", "tools"]),
    cgroup,
    inode: counter,
    status,
    current: counter,
    peak: counter,
    limit,
    initial_limit: limit,
    anon: counter,
    file: counter,
    kernel: counter,
    baseline: events,
    events,
    delta: events,
    local_baseline: events,
    local_events: events,
    local_delta: events,
  })
  .strict();
const groups = z.tuple([
  memorySnapshotSchema,
  memorySnapshotSchema,
  memorySnapshotSchema,
]);
const kernelEvent = z
  .object({
    source: z.literal("guest"),
    sequence: z.number().int().nonnegative(),
    boottime_us: z.number().int().nonnegative(),
    constraint: z.enum([
      "CONSTRAINT_NONE",
      "CONSTRAINT_MEMCG",
      "CONSTRAINT_CPUSET",
      "CONSTRAINT_MEMORY_POLICY",
    ]),
    oom_cgroup: z
      .union([
        kernelCgroup,
        z.string().regex(/^(?:\/|\/vm0-exec(?:\/exec-[0-9-]+)?)$/),
      ])
      .nullable(),
    victim_pid: z.number().int().positive().max(0xffff_ffff),
    victim_comm: z
      .string()
      .min(1)
      .max(16)
      .refine((value) => {
        return ![...value].some((character) => {
          const code = character.codePointAt(0);
          return code !== undefined && (code < 32 || code === 127);
        });
      }),
    task_cgroup: z.union([
      kernelCgroup,
      z
        .string()
        .max(256)
        .regex(/^\/vm0-exec\/exec-[0-9-]+\/control$/),
    ]),
  })
  .strict();
const incident = z
  .object({
    id: z
      .string()
      .max(40)
      .regex(/^[0-9a-f-]{36}:[1-4]$/),
    captured_at: z.iso.datetime(),
    reason: z.enum(["sample", "cli_error", "cleanup"]),
    after_observation: z.literal(true),
    before_cleanup: z.literal(true),
    kernel_status: status,
    kernel_events: z.array(kernelEvent).max(4),
    groups,
  })
  .strict();

export const oomEvidenceSchema = z
  .object({
    operation_id: z.uuid(),
    guest_boot_id: z.uuid().nullable(),
    started_boottime_us: z.number().int().nonnegative(),
    sampled_at: z.iso.datetime(),
    kernel_cursor: counter,
    kernel_status: status,
    groups,
    incidents: z.array(incident).max(4),
    dropped_incidents: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((evidence, context) => {
    const workload = evidence.groups[0].cgroup;
    const operationRoot = workload.slice(0, -"/workload".length);
    const validGroups = (value: z.infer<typeof groups>) => {
      return (
        value[0].role === "workload" &&
        value[0].cgroup === workload &&
        value[1].role === "runtime" &&
        value[1].cgroup === `${workload}/runtime` &&
        value[2].role === "tools" &&
        value[2].cgroup === `${workload}/tools`
      );
    };
    if (
      !validGroups(evidence.groups) ||
      evidence.incidents.some((item) => {
        return (
          !item.id.startsWith(`${evidence.operation_id}:`) ||
          !validGroups(item.groups) ||
          item.kernel_events.some((event) => {
            return (
              event.boottime_us < evidence.started_boottime_us ||
              (event.oom_cgroup !== null &&
                event.oom_cgroup !== "/" &&
                event.oom_cgroup !== "/vm0-exec" &&
                event.oom_cgroup !== operationRoot &&
                event.oom_cgroup !== workload &&
                !event.oom_cgroup.startsWith(`${workload}/`)) ||
              !(
                event.task_cgroup === workload ||
                event.task_cgroup ===
                  `${workload.slice(0, -"/workload".length)}/control` ||
                event.task_cgroup.startsWith(`${workload}/`)
              )
            );
          })
        );
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Evidence must belong to one containment lifecycle",
      });
    }
  });
