import { randomBytes } from "node:crypto";

import {
  forgetClerkResource,
  readClerkResourceRecords,
  recordClerkResource,
  type ClerkResourceRecord,
} from "./clerk-resource-records";

const DEFAULT_CLERK_API_BASE = "https://api.clerk.com/v1";
const CLERK_PAGE_LIMIT = 500;
const CLERK_RETRY_DELAYS_MS = [500, 1_500, 3_500] as const;
const CLERK_MAX_RETRY_AFTER_MS = 30_000;
/**
 * Syscall and undici codes that can only be raised while the connection is
 * still being established, so no request byte reached Clerk and replaying a
 * non-idempotent create cannot duplicate a resource. `ECONNRESET`,
 * `UND_ERR_SOCKET` and the header/body timeouts are deliberately absent: they
 * can surface after the request was written and the response was lost.
 */
const CLERK_CONNECT_FAILURE_CODES = new Set([
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const CLERK_BULK_REQUEST_PACE_MS = 110;
const CLERK_TEST_DOMAIN = "vm0-e2e.ai";
const CLERK_TEST_MARKER = "clerk_test";
const CLERK_STAGING_BROWSER_TEST_DOMAIN = "example.com";
const LOCAL_JOB_REF = "local";
const LOCAL_GENERATION = "local-1";

export const CLERK_TEST_ROLES = [
  "browser",
  "playwright",
  "paid-onboarding",
  "runner",
  "runner-real-codex",
  "runner-real-claude",
  "runner-mock-claude",
] as const;

export type ClerkTestRole = (typeof CLERK_TEST_ROLES)[number];

export interface ClerkTestOwner {
  readonly jobRef: string;
  readonly generation: string;
  readonly role: ClerkTestRole;
}

export interface RunnerTestAccounts {
  readonly runner: string;
  readonly codex: string;
  readonly claude: string;
  readonly mockClaude: string;
}

export interface ClerkCleanupOptions {
  readonly dryRun?: boolean;
}

export interface ClerkStaleCleanupOptions extends ClerkCleanupOptions {
  readonly stagingBrowserCreatedBefore?: Date;
}

export interface ClerkCleanupResult {
  readonly scannedOrganizations: number;
  readonly selectedOrganizations: number;
  readonly deletedOrganizations: number;
  readonly alreadyAbsentOrganizations: number;
  readonly skippedOrganizations: number;
  readonly scannedUsers: number;
  readonly selectedUsers: number;
  readonly deletedUsers: number;
  readonly alreadyAbsentUsers: number;
  readonly skippedUsers: number;
}

interface ClerkEmailAddress {
  readonly email_address: string;
}

interface ClerkUserSummary {
  readonly id: string;
  readonly created_at?: number;
  readonly email_addresses: readonly ClerkEmailAddress[];
}

interface ClerkOrganizationSummary {
  readonly id: string;
  readonly created_at?: number;
  readonly created_by?: string | null;
  readonly private_metadata?: unknown;
}

interface ClerkOrganizationList {
  readonly data: readonly ClerkOrganizationSummary[];
  readonly total_count: number;
}

interface ClerkOrganizationMembershipSummary {
  readonly public_user_data: {
    readonly user_id: string;
  };
}

interface ClerkOrganizationMembershipList {
  readonly data: readonly ClerkOrganizationMembershipSummary[];
  readonly total_count: number;
}

interface ClerkCleanupResources {
  readonly organizations: readonly ClerkOrganizationSummary[];
  readonly users: readonly ClerkUserSummary[];
}

interface RetryableClerkRequestInit extends RequestInit {
  readonly method: "GET" | "DELETE" | "PATCH";
}

interface CreateClerkRequestInit extends RequestInit {
  readonly method: "POST";
}

type ClerkCleanupSelection =
  | {
      readonly kind: "generation";
      readonly jobRef: string;
      readonly generation: string;
      readonly roles: readonly ClerkTestRole[];
    }
  | {
      readonly kind: "run";
      readonly jobRef: string;
      readonly runId: string;
      readonly roles: readonly ClerkTestRole[];
    }
  | { readonly kind: "job-ref"; readonly jobRef: string }
  | {
      readonly kind: "stale";
      readonly ciCreatedBeforeMs: number;
      readonly stagingBrowserCreatedBeforeMs?: number;
      readonly roles: readonly ClerkTestRole[];
    };

function getClerkApiBase(): string {
  const testApiBase = process.env.CLERK_API_TEST_BASE_URL;
  if (!testApiBase) {
    return DEFAULT_CLERK_API_BASE;
  }

  const testApiUrl = new URL(testApiBase);
  if (testApiUrl.protocol !== "http:" || testApiUrl.hostname !== "127.0.0.1") {
    throw new Error("CLERK_API_TEST_BASE_URL must use an HTTP 127.0.0.1 URL");
  }
  return testApiBase;
}

function getClerkHeaders(): Record<string, string> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY environment variable is required");
  }
  return {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/json",
  };
}

export function currentClerkTestJobRef(): string {
  const jobRef = process.env.JOB_REF ?? LOCAL_JOB_REF;
  if (!isClerkTestJobRef(jobRef)) {
    throw new Error(`Invalid Clerk test JOB_REF: ${jobRef}`);
  }
  return jobRef;
}

export function currentClerkTestGeneration(): string {
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  if (!runId && !runAttempt) {
    return LOCAL_GENERATION;
  }
  if (
    !runId ||
    !runAttempt ||
    !isPositiveIntegerString(runId) ||
    !isPositiveIntegerString(runAttempt)
  ) {
    throw new Error(
      "GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must both be positive integers",
    );
  }
  return `${runId}-${runAttempt}`;
}

export function currentClerkTestOwner(role: ClerkTestRole): ClerkTestOwner {
  return {
    jobRef: currentClerkTestJobRef(),
    generation: currentClerkTestGeneration(),
    role,
  };
}

export function generateTestEmail(role: ClerkTestRole): string {
  const nonce = roleSupportsNonce(role)
    ? randomBytes(4).toString("hex")
    : undefined;
  return formatClerkTestEmail(currentClerkTestOwner(role), nonce);
}

export function runnerTestAccounts(): RunnerTestAccounts {
  return {
    runner: generateTestEmail("runner"),
    codex: generateTestEmail("runner-real-codex"),
    claude: generateTestEmail("runner-real-claude"),
    mockClaude: generateTestEmail("runner-mock-claude"),
  };
}

export function parseClerkTestRole(value: string): ClerkTestRole | null {
  return CLERK_TEST_ROLES.find((role) => role === value) ?? null;
}

export function parseClerkTestEmail(email: string): ClerkTestOwner | null {
  const addressParts = email.split("@");
  if (addressParts.length !== 2 || addressParts[1] !== CLERK_TEST_DOMAIN) {
    return null;
  }

  const localParts = addressParts[0]?.split("+");
  if (!localParts || localParts.length !== 4) {
    return null;
  }
  const [jobRef, marker, generation, rolePart] = localParts;
  if (
    !jobRef ||
    !generation ||
    !rolePart ||
    marker !== CLERK_TEST_MARKER ||
    !isClerkTestJobRef(jobRef) ||
    !isClerkTestGeneration(generation)
  ) {
    return null;
  }

  const role = parseRolePart(rolePart);
  return role ? { jobRef, generation, role } : null;
}

export function parseClerkTestOrganizationMetadata(
  privateMetadata: unknown,
): ClerkTestOwner | null {
  if (!isRecord(privateMetadata)) {
    return null;
  }
  const marker = privateMetadata.vm0CiTest;
  if (!isRecord(marker) || Object.keys(marker).length !== 3) {
    return null;
  }
  const { jobRef, generation, role } = marker;
  if (
    typeof jobRef !== "string" ||
    typeof generation !== "string" ||
    typeof role !== "string" ||
    !isClerkTestJobRef(jobRef) ||
    !isClerkTestGeneration(generation)
  ) {
    return null;
  }
  const parsedRole = parseClerkTestRole(role);
  return parsedRole ? { jobRef, generation, role: parsedRole } : null;
}

export async function createUser(
  email: string,
  password?: string,
): Promise<string> {
  const response = await requestClerkCreate("create Clerk user", "/users", {
    method: "POST",
    headers: getClerkHeaders(),
    body: JSON.stringify({
      email_address: [email],
      ...(password ? { password } : { skip_password_requirement: true }),
      legal_accepted_at: new Date().toISOString(),
    }),
  });
  const data = await readClerkJson(response, "create Clerk user");
  if (!hasStringProperty(data, "id")) {
    throw new Error(
      `create Clerk user returned an unexpected response: ${formatClerkResponseSummary(response)}`,
    );
  }
  const owner = parseClerkTestEmail(email);
  if (owner) {
    await recordClerkResource({ kind: "user", id: data.id, owner });
  }
  return data.id;
}

export async function createOrganization(
  name: string,
  createdByUserId: string,
  role: ClerkTestRole,
): Promise<string> {
  const owner = currentClerkTestOwner(role);
  // Keep the user if cancellation loses an organization's creation response.
  // The existing strict-marker sweep can reconcile that ambiguous outcome.
  await recordClerkResource({
    kind: "pending-organization",
    id: createdByUserId,
    owner,
  });
  const response = await requestClerkCreate(
    "create Clerk organization",
    "/organizations",
    {
      method: "POST",
      headers: getClerkHeaders(),
      body: JSON.stringify({
        name,
        created_by: createdByUserId,
        private_metadata: { vm0CiTest: owner },
      }),
    },
  );
  const data = await readClerkJson(response, "create Clerk organization");
  if (!hasStringProperty(data, "id")) {
    throw new Error(
      `create Clerk organization returned an unexpected response: ${formatClerkResponseSummary(response)}`,
    );
  }

  await recordClerkResource({ kind: "organization", id: data.id, owner });
  await forgetClerkResource("pending-organization", createdByUserId);

  try {
    await updateOrganizationMembershipRole(
      data.id,
      createdByUserId,
      "org:admin",
    );
  } catch (cause) {
    await deleteOrganizationById(data.id);
    throw cause;
  }
  return data.id;
}

async function updateOrganizationMembershipRole(
  organizationId: string,
  userId: string,
  role: "org:admin" | "org:member",
): Promise<void> {
  const response = await requestClerkWithRetry(
    "update Clerk organization membership",
    `/organizations/${organizationId}/memberships/${userId}`,
    {
      method: "PATCH",
      headers: getClerkHeaders(),
      body: JSON.stringify({ role }),
    },
  );
  const data = await readClerkJson(
    response,
    "update Clerk organization membership",
  );
  if (!hasStringProperty(data, "role") || data.role !== role) {
    throw new Error(
      `update Clerk organization membership returned an unexpected role: ${formatClerkResponseSummary(response)}`,
    );
  }
}

export async function cleanupCurrentClerkTestGeneration(
  roles: readonly ClerkTestRole[],
  options: ClerkCleanupOptions = {},
): Promise<ClerkCleanupResult> {
  assertCleanupRoles(roles);
  return await cleanupClerkTestResources(
    {
      kind: "generation",
      jobRef: currentClerkTestJobRef(),
      generation: currentClerkTestGeneration(),
      roles,
    },
    options,
  );
}

export async function cleanupCurrentClerkTestRun(
  roles: readonly ClerkTestRole[],
  options: ClerkCleanupOptions = {},
): Promise<ClerkCleanupResult> {
  assertCleanupRoles(roles);
  return await cleanupClerkTestResources(
    {
      kind: "run",
      jobRef: currentClerkTestJobRef(),
      runId: clerkTestRunId(currentClerkTestGeneration()),
      roles,
    },
    options,
  );
}

export async function cleanupClerkTestJobRef(
  jobRef: string,
  options: ClerkCleanupOptions = {},
): Promise<ClerkCleanupResult> {
  if (!isClerkTestJobRef(jobRef)) {
    throw new Error(`Invalid Clerk test JOB_REF: ${jobRef}`);
  }
  return await cleanupClerkTestResources({ kind: "job-ref", jobRef }, options);
}

export async function cleanupRecordedClerkTestResources(
  roles: readonly ClerkTestRole[],
  scope: "generation" | "run" = "generation",
): Promise<void> {
  assertCleanupRoles(roles);
  const records = (await readClerkResourceRecords()).map(parseResourceRecord);
  const jobRef = currentClerkTestJobRef();
  const generation = currentClerkTestGeneration();
  const selected = records.filter((record) => {
    const matchesGeneration =
      scope === "generation"
        ? record.owner.generation === generation
        : clerkTestRunId(record.owner.generation) ===
          clerkTestRunId(generation);
    if (
      record.owner.jobRef !== jobRef ||
      clerkTestRunId(record.owner.generation) !== clerkTestRunId(generation)
    ) {
      throw new Error("Recorded Clerk resource belongs to another CI scope");
    }
    return matchesGeneration && roles.includes(record.owner.role);
  });
  const pendingUsers = new Set(
    selected
      .filter((record) => record.kind === "pending-organization")
      .map((record) => record.id),
  );
  const organizations: string[] = [];
  const users: string[] = [];
  // Resolve ownership against Clerk before deleting anything from the record.
  for (const record of selected) {
    if (record.kind === "pending-organization") {
      continue;
    }
    const collection = record.kind === "user" ? "users" : "organizations";
    const response = await requestClerkWithRetry(
      "verify recorded Clerk resource",
      "/" + collection + "/" + record.id,
      { method: "GET", headers: getClerkHeaders() },
    );
    if (response.status === 404) {
      await response.body?.cancel();
      await forgetClerkResource(record.kind, record.id);
      continue;
    }
    const resource = await readClerkJson(
      response,
      "verify recorded Clerk resource",
    );
    const email =
      isClerkUserSummary(resource) && resource.email_addresses.length === 1
        ? resource.email_addresses[0]?.email_address
        : undefined;
    const owner =
      record.kind === "user" &&
      isClerkUserSummary(resource) &&
      resource.id === record.id &&
      email
        ? parseClerkTestEmail(email)
        : record.kind === "organization" &&
            isClerkOrganizationSummary(resource) &&
            resource.id === record.id
          ? parseClerkTestOrganizationMetadata(resource.private_metadata)
          : null;
    if (
      !owner ||
      clerkTestOwnerKey(owner) !== clerkTestOwnerKey(record.owner)
    ) {
      throw new Error("Recorded Clerk resource ownership does not match Clerk");
    }
    if (record.kind === "organization") {
      organizations.push(record.id);
    } else if (!pendingUsers.has(record.id)) {
      users.push(record.id);
    }
  }
  const totalDeletes = organizations.length + users.length;
  for (const [index, id] of organizations.entries()) {
    await deleteOrganizationById(id);
    await paceClerkBulkRequest(index + 1, totalDeletes);
  }
  for (const [index, id] of users.entries()) {
    await deleteUserById(id);
    await paceClerkBulkRequest(organizations.length + index + 1, totalDeletes);
  }
  console.log("Cleaned recorded Clerk test resources", {
    organizations: organizations.length,
    users: users.length,
    deferredUsers: pendingUsers.size,
  });
}

function parseResourceRecord(value: unknown): ClerkResourceRecord {
  if (!isRecord(value)) {
    throw new Error("Invalid Clerk resource record");
  }
  const owner = parseClerkTestOrganizationMetadata({ vm0CiTest: value.owner });
  const { kind, id } = value;
  if (
    !owner ||
    typeof id !== "string" ||
    !/^(?:user|org)_[a-zA-Z0-9_]+$/.test(id) ||
    (kind !== "user" &&
      kind !== "organization" &&
      kind !== "pending-organization") ||
    (kind === "organization" ? !id.startsWith("org_") : !id.startsWith("user_"))
  ) {
    throw new Error("Invalid Clerk resource record");
  }
  return { kind, id, owner };
}

export async function cleanupStaleClerkTestResources(
  roles: readonly ClerkTestRole[],
  ciCreatedBefore: Date,
  options: ClerkStaleCleanupOptions = {},
): Promise<ClerkCleanupResult> {
  assertCleanupRoles(roles);
  const ciCreatedBeforeMs = ciCreatedBefore.getTime();
  if (!Number.isFinite(ciCreatedBeforeMs)) {
    throw new Error("Stale CI cleanup cutoff must be a valid date");
  }
  const stagingBrowserCreatedBeforeMs =
    options.stagingBrowserCreatedBefore?.getTime();
  if (
    stagingBrowserCreatedBeforeMs !== undefined &&
    !Number.isFinite(stagingBrowserCreatedBeforeMs)
  ) {
    throw new Error(
      "Stale staging browser cleanup cutoff must be a valid date",
    );
  }
  return await cleanupClerkTestResources(
    {
      kind: "stale",
      ciCreatedBeforeMs,
      ...(stagingBrowserCreatedBeforeMs === undefined
        ? {}
        : { stagingBrowserCreatedBeforeMs }),
      roles,
    },
    options,
  );
}

async function cleanupClerkTestResources(
  selection: ClerkCleanupSelection,
  options: ClerkCleanupOptions,
): Promise<ClerkCleanupResult> {
  const users = await listClerkUsers();
  const organizations = await listClerkOrganizations();
  const stagingBrowserResources = await selectStaleStagingBrowserResources(
    selection,
    users,
    organizations,
  );

  const organizationsWithOwners = organizations.map((organization) => ({
    organization,
    owner: parseClerkTestOrganizationMetadata(organization.private_metadata),
  }));
  const selectedMarkedOrganizations = organizationsWithOwners
    .filter(({ organization, owner }) => {
      return (
        owner !== null &&
        cleanupSelectionMatches(selection, owner, organization.created_at)
      );
    })
    .map(({ organization }) => organization);
  const selectedOrganizations = [
    ...selectedMarkedOrganizations,
    ...stagingBrowserResources.organizations,
  ];
  const retainedOrganizationOwners = new Set<string>();
  if (selection.kind === "stale") {
    // Keep an owner user until every marked organization in its scope is old
    // enough to delete, including resources that straddle the age cutoff.
    for (const { organization, owner } of organizationsWithOwners) {
      if (
        owner !== null &&
        !cleanupSelectionMatches(selection, owner, organization.created_at)
      ) {
        retainedOrganizationOwners.add(clerkTestOwnerKey(owner));
      }
    }
  }
  const selectedMarkedUsers = users.filter((user) => {
    const emailAddress = user.email_addresses[0];
    if (user.email_addresses.length !== 1 || !emailAddress) {
      return false;
    }
    const owner = parseClerkTestEmail(emailAddress.email_address);
    return (
      owner !== null &&
      cleanupSelectionMatches(selection, owner, user.created_at) &&
      !retainedOrganizationOwners.has(clerkTestOwnerKey(owner))
    );
  });
  const selectedUsers = [
    ...selectedMarkedUsers,
    ...stagingBrowserResources.users,
  ];

  let deletedOrganizations = 0;
  let alreadyAbsentOrganizations = 0;
  let deletedUsers = 0;
  let alreadyAbsentUsers = 0;
  if (!options.dryRun) {
    const deletionCount = selectedOrganizations.length + selectedUsers.length;
    let deletionIndex = 0;
    for (const organization of selectedOrganizations) {
      if (await deleteOrganizationById(organization.id)) {
        deletedOrganizations += 1;
      } else {
        alreadyAbsentOrganizations += 1;
      }
      deletionIndex += 1;
      await paceClerkBulkRequest(deletionIndex, deletionCount);
    }
    for (const user of selectedUsers) {
      if (await deleteUserById(user.id)) {
        deletedUsers += 1;
      } else {
        alreadyAbsentUsers += 1;
      }
      deletionIndex += 1;
      await paceClerkBulkRequest(deletionIndex, deletionCount);
    }
  }

  return {
    scannedOrganizations: organizations.length,
    selectedOrganizations: selectedOrganizations.length,
    deletedOrganizations,
    alreadyAbsentOrganizations,
    skippedOrganizations: organizations.length - selectedOrganizations.length,
    scannedUsers: users.length,
    selectedUsers: selectedUsers.length,
    deletedUsers,
    alreadyAbsentUsers,
    skippedUsers: users.length - selectedUsers.length,
  };
}

async function selectStaleStagingBrowserResources(
  selection: ClerkCleanupSelection,
  users: readonly ClerkUserSummary[],
  organizations: readonly ClerkOrganizationSummary[],
): Promise<ClerkCleanupResources> {
  if (
    selection.kind !== "stale" ||
    selection.stagingBrowserCreatedBeforeMs === undefined
  ) {
    return { organizations: [], users: [] };
  }
  const stagingBrowserCreatedBeforeMs = selection.stagingBrowserCreatedBeforeMs;

  const staleUsers = users.filter((user) => {
    const emailAddress = user.email_addresses[0];
    return (
      user.email_addresses.length === 1 &&
      emailAddress !== undefined &&
      isStagingBrowserTestEmail(emailAddress.email_address) &&
      user.created_at !== undefined &&
      user.created_at < stagingBrowserCreatedBeforeMs
    );
  });
  const staleUserIds = new Set(staleUsers.map((user) => user.id));
  const retainedUserIds = new Set<string>();
  const selectedOrganizations: ClerkOrganizationSummary[] = [];
  const ownedOrganizations = organizations.flatMap((organization) => {
    const createdBy = organization.created_by;
    return typeof createdBy === "string" && staleUserIds.has(createdBy)
      ? [{ organization, createdBy }]
      : [];
  });

  for (const [index, ownedOrganization] of ownedOrganizations.entries()) {
    const { organization, createdBy } = ownedOrganization;
    if (
      organization.created_at === undefined ||
      organization.created_at >= stagingBrowserCreatedBeforeMs
    ) {
      retainedUserIds.add(createdBy);
      continue;
    }

    const memberUserIds = await listClerkOrganizationMemberUserIds(
      organization.id,
    );
    if (memberUserIds.every((userId) => staleUserIds.has(userId))) {
      selectedOrganizations.push(organization);
    } else {
      retainedUserIds.add(createdBy);
    }
    await paceClerkBulkRequest(index + 1, ownedOrganizations.length);
  }

  return {
    organizations: selectedOrganizations,
    users: staleUsers.filter((user) => !retainedUserIds.has(user.id)),
  };
}

function cleanupSelectionMatches(
  selection: ClerkCleanupSelection,
  owner: ClerkTestOwner,
  createdAt: number | undefined,
): boolean {
  switch (selection.kind) {
    case "generation":
      return (
        owner.jobRef === selection.jobRef &&
        owner.generation === selection.generation &&
        selection.roles.includes(owner.role)
      );
    case "run":
      return (
        owner.jobRef === selection.jobRef &&
        clerkTestRunId(owner.generation) === selection.runId &&
        selection.roles.includes(owner.role)
      );
    case "job-ref":
      return owner.jobRef === selection.jobRef;
    case "stale":
      return (
        selection.roles.includes(owner.role) &&
        createdAt !== undefined &&
        createdAt < selection.ciCreatedBeforeMs
      );
  }
}

function assertCleanupRoles(roles: readonly ClerkTestRole[]): void {
  if (roles.length === 0) {
    throw new Error("At least one Clerk test role is required for cleanup");
  }
}

function clerkTestRunId(generation: string): string {
  return generation.slice(0, generation.lastIndexOf("-"));
}

function clerkTestOwnerKey(owner: ClerkTestOwner): string {
  return `${owner.jobRef}\0${owner.generation}\0${owner.role}`;
}

async function listClerkUsers(
  emailAddress?: string,
): Promise<readonly ClerkUserSummary[]> {
  const users: ClerkUserSummary[] = [];
  let offset = 0;
  while (true) {
    const parameters = new URLSearchParams({
      limit: String(CLERK_PAGE_LIMIT),
      offset: String(offset),
      order_by: "+created_at",
    });
    if (emailAddress) {
      parameters.append("email_address[]", emailAddress);
    }
    const response = await requestClerkWithRetry(
      "list Clerk test users",
      `/users?${parameters.toString()}`,
      { method: "GET", headers: getClerkHeaders() },
    );
    const page = await readClerkUsers(response, "list Clerk test users");
    users.push(...page);
    if (page.length < CLERK_PAGE_LIMIT) {
      return users;
    }
    offset += page.length;
  }
}

async function listClerkOrganizations(): Promise<
  readonly ClerkOrganizationSummary[]
> {
  const organizations: ClerkOrganizationSummary[] = [];
  let offset = 0;
  while (true) {
    const parameters = new URLSearchParams({
      limit: String(CLERK_PAGE_LIMIT),
      offset: String(offset),
      order_by: "+created_at",
    });
    const response = await requestClerkWithRetry(
      "list Clerk test organizations",
      `/organizations?${parameters.toString()}`,
      { method: "GET", headers: getClerkHeaders() },
    );
    const page = await readClerkOrganizations(
      response,
      "list Clerk test organizations",
    );
    organizations.push(...page.data);
    if (page.data.length === 0 || organizations.length >= page.total_count) {
      return organizations;
    }
    offset += page.data.length;
  }
}

async function listClerkOrganizationMemberUserIds(
  organizationId: string,
): Promise<readonly string[]> {
  const userIds: string[] = [];
  let offset = 0;
  while (true) {
    const parameters = new URLSearchParams({
      limit: String(CLERK_PAGE_LIMIT),
      offset: String(offset),
    });
    const response = await requestClerkWithRetry(
      "list Clerk test organization memberships",
      `/organizations/${organizationId}/memberships?${parameters.toString()}`,
      { method: "GET", headers: getClerkHeaders() },
    );
    const page = await readClerkOrganizationMemberships(
      response,
      "list Clerk test organization memberships",
    );
    userIds.push(
      ...page.data.map((membership) => membership.public_user_data.user_id),
    );
    if (page.data.length === 0 || userIds.length >= page.total_count) {
      return userIds;
    }
    offset += page.data.length;
  }
}

export async function deleteOrganizationById(
  organizationId: string,
): Promise<boolean> {
  const response = await requestClerkWithRetry(
    "delete Clerk test organization",
    `/organizations/${organizationId}`,
    { method: "DELETE", headers: getClerkHeaders() },
  );
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `delete Clerk test organization failed with ${formatClerkResponseSummary(response)}`,
    );
  }
  await forgetClerkResource("organization", organizationId);
  return response.status !== 404;
}

export async function deleteClerkTestOwnerResources(
  email: string,
  organizationId: string | undefined,
  role: ClerkTestRole,
): Promise<void> {
  if (!organizationId) {
    // Organization creation may have committed even when its response was lost.
    // Reconcile the owner scope so the user is never deleted ahead of that org.
    await cleanupCurrentClerkTestGeneration([role]);
    return;
  }
  await deleteOrganizationById(organizationId);
  await deleteUserByEmail(email);
}

export async function deleteUserByEmail(email: string): Promise<void> {
  const users = await listClerkUsers(email);
  const user = users.find((candidate) =>
    candidate.email_addresses.some(
      (emailAddress) => emailAddress.email_address === email,
    ),
  );
  if (user) {
    await deleteUserById(user.id);
  }
}

async function deleteUserById(userId: string): Promise<boolean> {
  const response = await requestClerkWithRetry(
    "delete Clerk test user",
    `/users/${userId}`,
    { method: "DELETE", headers: getClerkHeaders() },
  );
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `delete Clerk test user failed with ${formatClerkResponseSummary(response)}`,
    );
  }
  await forgetClerkResource("user", userId);
  return response.status !== 404;
}

async function paceClerkBulkRequest(
  requestIndex: number,
  requestCount: number,
): Promise<void> {
  if (requestIndex >= requestCount || process.env.CLERK_API_TEST_BASE_URL) {
    return;
  }
  await wait(CLERK_BULK_REQUEST_PACE_MS);
}

/**
 * Creates are not idempotent, so a lost response must never be replayed. A
 * failure raised while the connection was still being established is the one
 * exception: Clerk never saw the request, so the create can be reissued. Every
 * other transport failure, and every HTTP error response, is surfaced as-is.
 */
async function requestClerkCreate(
  operation: string,
  path: string,
  init: CreateClerkRequestInit,
): Promise<Response> {
  const url = `${getClerkApiBase()}${path}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (cause) {
      const delayMs = CLERK_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isClerkConnectFailure(cause)) {
        throw new Error(
          `${operation} request failed after ${formatAttemptCount(attempt + 1)}: ${describeClerkTransportCause(cause)}`,
          { cause },
        );
      }
      await waitBeforeClerkRetry(delayMs);
    }
  }
}

async function requestClerkWithRetry(
  operation: string,
  path: string,
  init: RetryableClerkRequestInit,
): Promise<Response> {
  const url = `${getClerkApiBase()}${path}`;
  for (let attempt = 0; attempt <= CLERK_RETRY_DELAYS_MS.length; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (cause) {
      const fallbackDelayMs = CLERK_RETRY_DELAYS_MS[attempt];
      if (fallbackDelayMs === undefined) {
        throw new Error(
          `${operation} request failed after ${formatAttemptCount(attempt + 1)}: ${describeClerkTransportCause(cause)}`,
          { cause },
        );
      }
      await waitBeforeClerkRetry(fallbackDelayMs);
      continue;
    }

    const fallbackDelayMs = CLERK_RETRY_DELAYS_MS[attempt];
    if (
      !isTransientClerkStatus(response.status) ||
      fallbackDelayMs === undefined
    ) {
      return response;
    }

    const delayMs = clerkRetryDelayMs(response, fallbackDelayMs);
    if (delayMs === null) {
      return response;
    }
    await response.body?.cancel();
    await waitBeforeClerkRetry(delayMs);
  }
  throw new Error(`${operation} exhausted its retry budget`);
}

/**
 * `TypeError: fetch failed` never names the syscall that failed, and the
 * per-address `AggregateError` undici nests underneath it prints as an empty
 * line in CI, so a DNS failure, a refused connection and a TLS failure are
 * indistinguishable in the log. Flatten the chain into the thrown message for
 * the same reason `formatErrorReport` rescues a nested runner credential cause.
 */
function describeClerkTransportCause(cause: unknown): string {
  if (!(cause instanceof Error)) {
    return String(cause);
  }

  const head = `${clerkTransportCode(cause) ?? cause.name}${cause.message ? `: ${cause.message}` : ""}`;
  const nested = clerkTransportCauses(cause).map(describeClerkTransportCause);
  return nested.length === 0 ? head : `${head} [${nested.join("; ")}]`;
}

/**
 * `fetch` reports every transport failure as an uncoded `TypeError`, so the
 * decision has to walk the whole chain. Every leaf must be a
 * connection-establishment failure before a create may be reissued.
 */
function isClerkConnectFailure(cause: unknown): boolean {
  if (!(cause instanceof Error)) {
    return false;
  }

  // undici aggregates errors only while racing the addresses of one host, so
  // the aggregation itself proves the failure happened before a request byte
  // was written. Node stamps the shared per-address code onto the aggregate,
  // and an all-addresses `ETIMEDOUT` race carries a code this set withholds
  // from single errors because it can also fire on an established socket.
  if (cause instanceof AggregateError) {
    return true;
  }

  const code = clerkTransportCode(cause);
  if (code !== undefined) {
    return CLERK_CONNECT_FAILURE_CODES.has(code);
  }

  const nested = clerkTransportCauses(cause);
  return (
    nested.length > 0 &&
    nested.every((nestedCause) => isClerkConnectFailure(nestedCause))
  );
}

function clerkTransportCauses(error: Error): readonly unknown[] {
  const nested: unknown[] = [];
  const aggregated: unknown = isRecord(error) ? error.errors : undefined;
  if (Array.isArray(aggregated)) {
    for (const aggregatedError of aggregated) {
      nested.push(aggregatedError);
    }
  }
  if (error.cause !== undefined) {
    nested.push(error.cause);
  }
  return nested;
}

function clerkTransportCode(error: Error): string | undefined {
  const code: unknown = isRecord(error) ? error.code : undefined;
  return typeof code === "string" ? code : undefined;
}

function formatAttemptCount(attempts: number): string {
  return `${attempts} attempt${attempts === 1 ? "" : "s"}`;
}

/**
 * The local Clerk fixture server refuses or answers a connection immediately,
 * so tests assert the attempt sequence without paying the production backoff.
 * `paceClerkBulkRequest` skips its pacing under the same fixture switch.
 */
async function waitBeforeClerkRetry(delayMs: number): Promise<void> {
  if (process.env.CLERK_API_TEST_BASE_URL) {
    return;
  }
  await wait(delayMs);
}

function isTransientClerkStatus(status: number): boolean {
  return status >= 500;
}

function clerkRetryDelayMs(
  response: Response,
  fallbackDelayMs: number,
): number | null {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) {
    return fallbackDelayMs;
  }

  const retryAfterSeconds = Number(retryAfter);
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) {
    return fallbackDelayMs;
  }

  const retryAfterMs = Math.ceil(retryAfterSeconds * 1_000);
  return retryAfterMs <= CLERK_MAX_RETRY_AFTER_MS ? retryAfterMs : null;
}

async function wait(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function readClerkJson(
  response: Response,
  operation: string,
): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `${operation} failed with ${formatClerkResponseSummary(response)}`,
    );
  }

  let responseBody: string;
  try {
    responseBody = await response.text();
  } catch (cause) {
    throw new Error(`${operation} response read failed`, { cause });
  }

  try {
    const data: unknown = JSON.parse(responseBody);
    return data;
  } catch {
    throw new Error(
      `${operation} returned invalid JSON: ${formatClerkResponseSummary(response)}`,
    );
  }
}

async function readClerkUsers(
  response: Response,
  operation: string,
): Promise<readonly ClerkUserSummary[]> {
  const data = await readClerkJson(response, operation);
  if (!isClerkUserList(data)) {
    throw new Error(
      `${operation} returned an unexpected response: ${formatClerkResponseSummary(response)}`,
    );
  }
  return data;
}

async function readClerkOrganizations(
  response: Response,
  operation: string,
): Promise<ClerkOrganizationList> {
  const data = await readClerkJson(response, operation);
  if (!isClerkOrganizationList(data)) {
    throw new Error(
      `${operation} returned an unexpected response: ${formatClerkResponseSummary(response)}`,
    );
  }
  return data;
}

async function readClerkOrganizationMemberships(
  response: Response,
  operation: string,
): Promise<ClerkOrganizationMembershipList> {
  const data = await readClerkJson(response, operation);
  if (!isClerkOrganizationMembershipList(data)) {
    throw new Error(
      `${operation} returned an unexpected response: ${formatClerkResponseSummary(response)}`,
    );
  }
  return data;
}

function isClerkUserList(value: unknown): value is readonly ClerkUserSummary[] {
  return Array.isArray(value) && value.every(isClerkUserSummary);
}

function isClerkUserSummary(value: unknown): value is ClerkUserSummary {
  if (!isRecord(value) || typeof value.id !== "string") {
    return false;
  }
  if ("created_at" in value && typeof value.created_at !== "number") {
    return false;
  }
  const emailAddresses = value.email_addresses;
  return (
    Array.isArray(emailAddresses) &&
    emailAddresses.every((emailAddress: unknown) =>
      hasStringProperty(emailAddress, "email_address"),
    )
  );
}

function isClerkOrganizationList(
  value: unknown,
): value is ClerkOrganizationList {
  return (
    isRecord(value) &&
    Array.isArray(value.data) &&
    value.data.every(isClerkOrganizationSummary) &&
    typeof value.total_count === "number" &&
    Number.isInteger(value.total_count) &&
    value.total_count >= 0
  );
}

function isClerkOrganizationSummary(
  value: unknown,
): value is ClerkOrganizationSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (!("created_at" in value) || typeof value.created_at === "number") &&
    (!("created_by" in value) ||
      value.created_by === null ||
      typeof value.created_by === "string")
  );
}

function isClerkOrganizationMembershipList(
  value: unknown,
): value is ClerkOrganizationMembershipList {
  return (
    isRecord(value) &&
    Array.isArray(value.data) &&
    value.data.every(isClerkOrganizationMembershipSummary) &&
    typeof value.total_count === "number" &&
    Number.isInteger(value.total_count) &&
    value.total_count >= 0
  );
}

function isClerkOrganizationMembershipSummary(
  value: unknown,
): value is ClerkOrganizationMembershipSummary {
  return (
    isRecord(value) &&
    isRecord(value.public_user_data) &&
    typeof value.public_user_data.user_id === "string"
  );
}

function formatClerkTestEmail(owner: ClerkTestOwner, nonce?: string): string {
  const role = nonce ? `${owner.role}-${nonce}` : owner.role;
  return `${owner.jobRef}+${CLERK_TEST_MARKER}+${owner.generation}+${role}@${CLERK_TEST_DOMAIN}`;
}

function isStagingBrowserTestEmail(email: string): boolean {
  const addressParts = email.split("@");
  return (
    addressParts.length === 2 &&
    addressParts[0] !== "" &&
    addressParts[1] === CLERK_STAGING_BROWSER_TEST_DOMAIN
  );
}

function parseRolePart(rolePart: string): ClerkTestRole | null {
  const exactRole = parseClerkTestRole(rolePart);
  if (exactRole) {
    return exactRole;
  }
  for (const role of CLERK_TEST_ROLES) {
    if (!roleSupportsNonce(role)) {
      continue;
    }
    const prefix = `${role}-`;
    if (rolePart.startsWith(prefix) && isNonce(rolePart.slice(prefix.length))) {
      return role;
    }
  }
  return null;
}

function roleSupportsNonce(role: ClerkTestRole): boolean {
  return role === "playwright" || role === "paid-onboarding";
}

function isNonce(value: string): boolean {
  return /^[0-9a-f]{8}$/.test(value);
}

function isClerkTestJobRef(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}

function isClerkTestGeneration(value: string): boolean {
  return value === LOCAL_GENERATION || /^[1-9][0-9]*-[1-9][0-9]*$/.test(value);
}

function isPositiveIntegerString(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value);
}

function hasStringProperty<K extends string>(
  value: unknown,
  property: K,
): value is Record<K, string> {
  return isRecord(value) && typeof value[property] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatClerkResponseSummary(response: Response): string {
  return `HTTP ${response.status} (${classifyClerkResponse(response)})`;
}

function classifyClerkResponse(
  response: Response,
): "json" | "html" | "other" | "unknown" {
  const contentType = response.headers.get("content-type");
  if (!contentType) {
    return "unknown";
  }

  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "application/json" || mediaType?.endsWith("+json")) {
    return "json";
  }
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
    return "html";
  }
  return "other";
}
