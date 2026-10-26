import {
  array,
  iso,
  literal,
  number,
  object,
  string,
  tuple,
  union,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

// Same bounded metadata contract as guest-contracts::oom_evidence. Null means
// unavailable, including kernels that do not expose a particular field.
const counter = number().int().nonnegative().nullable();
const status = zEnum([
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
const cgroup = string()
  .max(256)
  .regex(
    /^\/vm0-exec\/exec-[0-9-]+\/workload(?:\/(?:runtime|tools(?:\/tool-[0-9-]+)?))?$/,
  );
// Match guest-contracts::managed_task::owned_task_path, including canonical
// lowercase UUIDs that are not restricted to a particular UUID version.
const taskHandle =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const managedTaskCgroup = string()
  .max(256)
  .regex(
    new RegExp(
      String.raw`^/vm0-exec/exec-[0-9-]+/workload(?:/tools/task-${taskHandle})+(?:/(?:runtime|tools(?:/tool-[0-9]{1,20})?))?$(?![\s\S])`,
    ),
  );
const kernelCgroup = union([cgroup, managedTaskCgroup]);
const limit = string()
  .max(20)
  .regex(/^(?:max|[0-9]+)$/)
  .nullable();
const events = object({
  high: counter,
  max: counter,
  oom: counter,
  oom_kill: counter,
  oom_group_kill: counter,
}).strict();
const memorySnapshotSchema = object({
  role: zEnum(["workload", "runtime", "tools"]),
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
}).strict();
const groups = tuple([
  memorySnapshotSchema,
  memorySnapshotSchema,
  memorySnapshotSchema,
]);
const kernelEvent = object({
  source: literal("guest"),
  sequence: number().int().nonnegative(),
  boottime_us: number().int().nonnegative(),
  constraint: zEnum([
    "CONSTRAINT_NONE",
    "CONSTRAINT_MEMCG",
    "CONSTRAINT_CPUSET",
    "CONSTRAINT_MEMORY_POLICY",
  ]),
  oom_cgroup: union([
    kernelCgroup,
    string().regex(/^(?:\/|\/vm0-exec(?:\/exec-[0-9-]+)?)$/),
  ]).nullable(),
  victim_pid: number().int().positive().max(0xffff_ffff),
  victim_comm: string()
    .min(1)
    .max(16)
    .refine((value) => {
      return ![...value].some((character) => {
        const code = character.codePointAt(0);
        return code !== undefined && (code < 32 || code === 127);
      });
    }),
  task_cgroup: union([
    kernelCgroup,
    string()
      .max(256)
      .regex(/^\/vm0-exec\/exec-[0-9-]+\/control$/),
  ]),
}).strict();
const incident = object({
  id: string()
    .max(40)
    .regex(/^[0-9a-f-]{36}:[1-4]$/),
  captured_at: iso.datetime(),
  reason: zEnum(["sample", "cli_error", "cleanup"]),
  after_observation: literal(true),
  before_cleanup: literal(true),
  kernel_status: status,
  kernel_events: array(kernelEvent).max(4),
  groups,
}).strict();

export const oomEvidenceSchema = object({
  operation_id: uuid(),
  guest_boot_id: uuid().nullable(),
  started_boottime_us: number().int().nonnegative(),
  sampled_at: iso.datetime(),
  kernel_cursor: counter,
  kernel_status: status,
  groups,
  incidents: array(incident).max(4),
  dropped_incidents: number().int().nonnegative(),
})
  .strict()
  .superRefine((evidence, context) => {
    const workload = evidence.groups[0].cgroup;
    const operationRoot = workload.slice(0, -"/workload".length);
    const validGroups = (value: zInfer<typeof groups>) => {
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
