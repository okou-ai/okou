import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import {
  assertWorkerRoleEntries,
  workerRoles,
} from "./worker-role-manifest.mjs";

export function selectWorkerBuilds(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: { role: { type: "string" }, roles: { type: "boolean" } },
  });
  const hasRole = values.role !== undefined;
  if (hasRole && values.roles) {
    throw new Error("Select --role <name> or --roles, not both");
  }
  if (hasRole && !Object.hasOwn(workerRoles, values.role)) {
    throw new Error(`Unknown Worker role: ${values.role}`);
  }
  if (hasRole || values.roles) {
    assertWorkerRoleEntries();
  }
  const roles = values.roles ? Object.keys(workerRoles) : [values.role];
  return roles.map((role) => {
    return {
      role,
      entry: role ? workerRoles[role].entry : "src/worker.ts",
      directory: role ? `dist-worker-roles/${role}` : "dist-worker",
    };
  });
}

export function auditWorkerRole(apiRoot, role, result) {
  const definition = workerRoles[role];
  const retained = new Set(
    Object.values(result.metafile.outputs).flatMap((output) => {
      return Object.entries(output.inputs)
        .filter(([, contribution]) => {
          return contribution.bytesInOutput > 0;
        })
        .map(([path]) => {
          return path.replaceAll("\\", "/");
        });
    }),
  );
  if (retained.has("src/signals/route.ts")) {
    throw new Error(`${role} imports the complete API route table`);
  }
  const dispatch =
    "src/signals/services/chat-run-finished-event-dispatch.service.ts";
  const registration =
    "src/signals/services/chat-run-finished-event-registration.service.ts";
  if (retained.has(dispatch) && !definition.initializeChatRunFinishedEvents) {
    throw new Error(`${role} needs completion-event registration`);
  }
  if (
    definition.initializeChatRunFinishedEvents &&
    !retained.has(registration)
  ) {
    throw new Error(`${role} lost its required completion-event initializer`);
  }
  const javascript = result.outputFiles.find((output) => {
    return output.path.endsWith("/worker.js");
  });
  if (!javascript) {
    throw new Error(`Missing JavaScript output for ${role}`);
  }
  return {
    role,
    entry: definition.entry,
    groups: definition.groups,
    initializeChatRunFinishedEvents: definition.initializeChatRunFinishedEvents,
    javascript: relative(apiRoot, javascript.path),
    bytes: javascript.contents.length,
    sha256: createHash("sha256").update(javascript.contents).digest("hex"),
    retainedModules: retained.size,
    retainedCompletionDispatch: retained.has(dispatch),
    retainedCompletionRegistration: retained.has(registration),
    outputDirectory: resolve(apiRoot, `dist-worker-roles/${role}`),
  };
}
