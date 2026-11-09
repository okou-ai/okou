#!/usr/bin/env tsx

/**
 * Publish the default personal Instructions bundle before an API deployment
 * serves requests that reference it.
 *
 * Usage: pnpm --dir turbo/apps/api instructions:publish-default
 *
 * Requires the deployment's API environment, normally the API_VALIDATED_ENV
 * record appended by env:validate. Publication is idempotent. The script exits
 * non-zero when SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE does not describe the
 * default text.
 */

import { createStore } from "ccstate";

import { publishDefaultPersonalInstructions$ } from "../signals/services/personal-instructions.service";

const bundle = await createStore().set(
  publishDefaultPersonalInstructions$,
  AbortSignal.timeout(60_000),
);
process.stdout.write(
  `Published default personal Instructions ${bundle.sha256}\n`,
);
