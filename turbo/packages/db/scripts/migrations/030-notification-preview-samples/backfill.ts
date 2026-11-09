import { isDeepStrictEqual, parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  array,
  boolean,
  date,
  email as emailSchema,
  number,
  object,
  string,
  unknown,
} from "zod";
import { samples } from "./samples";

class MigrationError extends Error {}

const userSchema = object({
  id: string().min(1),
  banned: boolean(),
  locked: boolean(),
  email_addresses: array(
    object({
      email_address: string(),
      verification: object({ status: string() }).nullable(),
    }),
  ),
});
const membershipsSchema = object({
  data: array(object({ organization: object({ id: string().min(1) }) })),
  total_count: number().int().nonnegative(),
});
const notificationSchema = object({
  user_id: string(),
  title: string(),
  summary: string(),
  payload: unknown(),
  delivery_key: string(),
  read_at: date().nullable(),
});

type PreviewOptions = {
  databaseUrl: string;
  clerkKey: string;
  environment: string;
  emails: string[];
  migrate: boolean;
  fetchClerk?: typeof fetch;
};

function recipientEmails(options: PreviewOptions) {
  if (
    options.environment !== "preview" ||
    !options.clerkKey.startsWith("sk_test_")
  )
    throw new MigrationError("PreviewAndTestClerkRequired");
  if (!options.databaseUrl)
    throw new MigrationError("PreviewDatabaseUrlRequired");
  const emails = [
    ...new Set(
      options.emails.map((email) => {
        return email.toLowerCase();
      }),
    ),
  ];
  if (
    !emails.length ||
    emails.some((email) => {
      return !emailSchema().safeParse(email).success;
    })
  )
    throw new MigrationError("ExplicitRecipientEmailsRequired");
  return emails;
}

/** Explicit recipients in a test Clerk instance; never a staff-wide delivery. */
export async function deliverPreviewSamples(options: PreviewOptions) {
  const emails = recipientEmails(options);

  async function clerk(path: string) {
    const response = await (options.fetchClerk ?? fetch)(
      `https://api.clerk.com/v1${path}`,
      {
        headers: { Authorization: `Bearer ${options.clerkKey}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok)
      throw new MigrationError(`ClerkRequestFailed:${response.status}`);
    const body: unknown = await response.json();
    return body;
  }

  // Resolve every recipient before opening the database or changing any rows.
  const recipients: { email: string; userId: string; orgIds: string[] }[] = [];
  for (const email of emails) {
    const users = array(userSchema).parse(
      await clerk(`/users?${new URLSearchParams({ email_address: email })}`),
    );
    const matching = users.filter((user) => {
      return (
        !user.banned &&
        !user.locked &&
        user.email_addresses.some((address) => {
          return (
            address.email_address.toLowerCase() === email &&
            address.verification?.status === "verified"
          );
        })
      );
    });
    if (matching.length !== 1)
      throw new MigrationError(`RecipientNotUniqueOrVerified:${email}`);
    const userId = matching[0]!.id;
    if (
      recipients.some((recipient) => {
        return recipient.userId === userId;
      })
    )
      throw new MigrationError("DuplicateRecipientIdentity");
    const orgIds = new Set<string>();
    let offset = 0;
    let total = 0;
    do {
      const memberships = membershipsSchema.parse(
        await clerk(
          `/users/${encodeURIComponent(userId)}/organization_memberships?limit=100&offset=${offset}`,
        ),
      );
      total = memberships.total_count;
      for (const membership of memberships.data)
        orgIds.add(membership.organization.id);
      offset += memberships.data.length;
      if (!memberships.data.length && offset < total)
        throw new MigrationError("IncompleteMembershipResponse");
    } while (offset < total);
    if (!orgIds.size)
      throw new MigrationError(`RecipientHasNoOrganization:${email}`);
    recipients.push({ email, userId, orgIds: [...orgIds] });
  }

  const sql = postgres(options.databaseUrl, { max: 1, connect_timeout: 15 });
  const userIds = recipients.map((recipient) => {
    return recipient.userId;
  });
  const keys = samples.map((sample) => {
    return sample.delivery_key;
  });
  async function existing() {
    const rows = array(notificationSchema).parse(
      await sql`
      SELECT user_id, title, summary, payload, delivery_key, read_at
      FROM user_notifications
      WHERE user_id IN ${sql(userIds)} AND delivery_key IN ${sql(keys)}
    `,
    );
    for (const row of rows) {
      const sample = samples.find((value) => {
        return value.delivery_key === row.delivery_key;
      });
      if (
        !sample ||
        row.title !== sample.title ||
        row.summary !== sample.summary ||
        !isDeepStrictEqual(row.payload, sample.payload)
      )
        throw new MigrationError("ExistingDeliveryContentMismatch");
    }
    return rows;
  }
  try {
    const before = await existing();
    let inserted = 0;
    if (options.migrate) {
      const deliveries = recipients.flatMap((recipient) => {
        return samples.map((sample) => {
          return {
            user_id: recipient.userId,
            ...sample,
          };
        });
      });
      const overrides = recipients.flatMap((recipient) => {
        return recipient.orgIds.map((orgId) => {
          return {
            org_id: orgId,
            user_id: recipient.userId,
          };
        });
      });
      // One atomic statement: notifications and personal visibility land together.
      // Existing deliveries retain their read_at, and unrelated switches survive.
      const result = array(object({ inserted: number() })).parse(
        await sql`
        WITH delivered AS (
          INSERT INTO user_notifications (user_id, title, summary, payload, delivery_key)
          SELECT user_id, title, summary, payload, delivery_key
          FROM jsonb_to_recordset(${sql.json(deliveries)})
            AS sample(user_id text, title text, summary text, payload jsonb, delivery_key text)
          ON CONFLICT (user_id, delivery_key) DO NOTHING
          RETURNING id
        ), enabled AS (
          INSERT INTO user_feature_switches (org_id, user_id, switches)
          SELECT org_id, user_id, '{"userNotifications":true}'::jsonb
          FROM jsonb_to_recordset(${sql.json(overrides)}) AS recipient(org_id text, user_id text)
          ON CONFLICT (org_id, user_id) DO UPDATE
          SET switches = user_feature_switches.switches || EXCLUDED.switches, updated_at = now()
          WHERE user_feature_switches.switches->'userNotifications' IS DISTINCT FROM 'true'::jsonb
          RETURNING user_id
        )
        SELECT count(*)::int AS inserted FROM delivered
      `,
      );
      inserted = result[0]!.inserted;
    }
    const after = options.migrate ? await existing() : before;
    if (options.migrate && after.length !== recipients.length * samples.length)
      throw new MigrationError("DeliveryReadbackIncomplete");
    if (options.migrate) {
      const flags = array(
        object({ org_id: string(), user_id: string() }),
      ).parse(
        await sql`
          SELECT org_id, user_id FROM user_feature_switches
          WHERE user_id IN ${sql(userIds)} AND switches->'userNotifications' = 'true'::jsonb
        `,
      );
      if (
        recipients.some((recipient) => {
          return recipient.orgIds.some((orgId) => {
            return !flags.some((flag) => {
              return flag.user_id === recipient.userId && flag.org_id === orgId;
            });
          });
        })
      )
        throw new MigrationError("PersonalVisibilityReadbackIncomplete");
    }
    return {
      mode: options.migrate ? "migrate" : "dry-run",
      inserted,
      planned: recipients.length * samples.length - before.length,
      recipients: recipients.map((recipient) => {
        return {
          email: recipient.email,
          organizations: recipient.orgIds.length,
          stored: after.filter((row) => {
            return row.user_id === recipient.userId;
          }).length,
          unread: after.filter((row) => {
            return row.user_id === recipient.userId && !row.read_at;
          }).length,
        };
      }),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      "recipient-email": { type: "string", multiple: true },
      migrate: { type: "boolean", default: false },
    },
  });
  const result = await deliverPreviewSamples({
    databaseUrl: process.env.DATABASE_URL ?? "",
    clerkKey: process.env.CLERK_SECRET_KEY ?? "",
    // This operator runs directly through tsx, outside Turbo's cached tasks.
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    environment: process.env.ENV ?? "",
    emails: values["recipient-email"] ?? [],
    migrate: values.migrate,
  });
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error: unknown) => {
    // SQL/client errors can contain connection details; print only safe categories.
    console.error(
      error instanceof MigrationError
        ? error.message
        : "NotificationPreviewMigrationFailed",
    );
    process.exitCode = 1;
  });
}
