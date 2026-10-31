import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import {
  assertWorkerRoleEntries,
  workerRoles,
} from "./worker-role-manifest.mjs";
import {
  assertWorkerDomainEntries,
  workerDomains,
} from "./worker-domain-manifest.mjs";

function selectRoleBuilds(values) {
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

function selectDomainBuilds(values) {
  const hasDomain = values.domain !== undefined;
  if (hasDomain && values.domains) {
    throw new Error("Select --domain <name> or --domains, not both");
  }
  if (hasDomain && !Object.hasOwn(workerDomains, values.domain)) {
    throw new Error(`Unknown Worker business domain: ${values.domain}`);
  }
  assertWorkerDomainEntries();
  const domains = values.domains ? Object.keys(workerDomains) : [values.domain];
  return domains.map((domain) => {
    return {
      domain,
      entry: workerDomains[domain].entry,
      directory: `dist-worker-domains/${domain}`,
    };
  });
}

export function selectWorkerBuilds(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      role: { type: "string" },
      roles: { type: "boolean" },
      domain: { type: "string" },
      domains: { type: "boolean" },
    },
  });
  const domainSelection = values.domain !== undefined || values.domains;
  const roleSelection = values.role !== undefined || values.roles;
  if (domainSelection && roleSelection) {
    throw new Error(
      "Worker role and business-domain selections cannot be mixed",
    );
  }
  return domainSelection
    ? selectDomainBuilds(values)
    : selectRoleBuilds(values);
}

function auditDefinition(apiRoot, name, definition, result, directory) {
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
    throw new Error(`${name} imports the complete API route table`);
  }
  const dispatch =
    "src/signals/services/chat-run-finished-event-dispatch.service.ts";
  const registration =
    "src/signals/services/chat-run-finished-event-registration.service.ts";
  if (retained.has(dispatch) && !definition.initializeChatRunFinishedEvents) {
    throw new Error(`${name} needs completion-event registration`);
  }
  if (
    definition.initializeChatRunFinishedEvents &&
    !retained.has(registration)
  ) {
    throw new Error(`${name} lost its required completion-event initializer`);
  }
  const javascript = result.outputFiles.find((output) => {
    return output.path.endsWith("/worker.js");
  });
  if (!javascript) {
    throw new Error(`Missing JavaScript output for ${name}`);
  }
  return {
    entry: definition.entry,
    groups: definition.groups,
    initializeChatRunFinishedEvents: definition.initializeChatRunFinishedEvents,
    javascript: relative(apiRoot, javascript.path),
    bytes: javascript.contents.length,
    sha256: createHash("sha256").update(javascript.contents).digest("hex"),
    retainedModules: retained.size,
    retainedCompletionDispatch: retained.has(dispatch),
    retainedCompletionRegistration: retained.has(registration),
    outputDirectory: resolve(apiRoot, directory),
  };
}

export function auditWorkerRole(apiRoot, role, result) {
  return {
    role,
    ...auditDefinition(
      apiRoot,
      role,
      workerRoles[role],
      result,
      `dist-worker-roles/${role}`,
    ),
  };
}

export function auditWorkerSelection(apiRoot, selection, result) {
  if (selection.domain) {
    return {
      ...auditDefinition(
        apiRoot,
        selection.domain,
        workerDomains[selection.domain],
        result,
        selection.directory,
      ),
      domain: selection.domain,
      coverage: "partial-business-domain-probe-not-a-fleet",
    };
  }
  return selection.role
    ? auditWorkerRole(apiRoot, selection.role, result)
    : undefined;
}
