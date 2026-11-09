# Notification preview samples

Temporary, opt-in data migration for the notification UI preview. Delivers 45
messages covering text, illustrations, three/five-page carousels and long content to explicitly
named, verified users in the **test Clerk instance**. Requires `ENV=preview` and
a test Clerk secret. It does not enable the global or staff feature switch.

The operator resolves recipients and their organizations in Clerk before any
write. It enables `userNotifications` only in those users' personal overrides,
preserving other switches. Fixed delivery keys make reruns idempotent and retain
existing read receipts. A conflicting existing payload fails validation.

From `turbo/packages/db`, with the preview's `DATABASE_URL` and
`CLERK_SECRET_KEY` already supplied in the environment:

```bash
ENV=preview pnpm exec tsx scripts/migrations/030-notification-preview-samples/backfill.ts \
  --recipient-email your-verified-test-email@example.com
```

This defaults to a read-only dry run. Repeat with `--migrate` to deliver. Multiple
explicit `--recipient-email` options are supported. Missing, ambiguous, unverified
or organization-less recipients fail before writing any messages.

The existing PR deployment job runs dry-run then migrate only for pull requests
with the `preview-notification-samples` label. The configured recipients are the
requesting owner and a separate notification QA account. Main, merge-group and
production runs never execute this operator. Preview DB resets can rerun it;
delivery is once per recipient and delivery key in the current database.

Remove the label when this preview is accepted, then retire this temporary
operator and its workflow invocation. No database schema or migration journal
changes are needed for these sample rows.

Samples have distinct creation times one minute apart, newest first. Their count
exercises three API pages (20 + 20 + 5) and repeated infinite scroll loads. Existing
deliveries retain their timestamps and read receipts on rerun.
