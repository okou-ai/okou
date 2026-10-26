# Worker schema import audit

This audit accompanies the [Worker composition experiment](worker-domains.md).
The reference is commit `c738373f36748fddff7c028e8e360b77868f511d`, which already
includes the Zod startup optimization. Measurements below are minified JavaScript
bytes, not Cloudflare CPU time.

## Aggregation that retains runtime code

Each probe preserves one live export with the Worker builder's esbuild target,
conditions, minification and name preservation. The probe omits the compatibility
banner. The sizes include transitive dependencies and overlap; they cannot be
added to estimate full-API savings.

| Export                    | Aggregated import | Defining module |
| ------------------------- | ----------------: | --------------: |
| `healthContract`          |         736,818 B |        74,735 B |
| `initContract`            |          99,922 B |           335 B |
| `requestValidationError`  |         157,064 B |           271 B |
| `parseSkillFrontmatter`   |       1,056,514 B |       120,298 B |
| `isPiAgentModelSupported` |       1,118,962 B |       443,810 B |

The first four cases have consumers changed to direct imports. The validation
formatter is extracted unchanged to its own module while preserving its public
export. Health and build-info still validate the same responses. Pi catalog
lookup is separated from streaming and provider construction; catalog data
remains because the lookup uses it. Its provider models and resolution results
were compared against the original implementation.

The workflow import-source enum and Drive-sync/recovery schemas also have
defining modules: `workflow-import-source.ts` and
`artifact-google-drive-sync.ts`. Authentication imports the enum directly, and
the artifact catalog imports the Drive schemas directly. The token lifetime
constant lives in `skill-import-session.ts`; importing it through the full skill
import contract would otherwise restore the authentication-to-workflows edge.
Existing public exports remain available and share the same schema instances.

The extraction was measured separately against
`05ac1b2748f50eee13cfa683a5110f86ef1f7d90`:

| Live export / consumer                    |    Before |     After |
| ----------------------------------------- | --------: | --------: |
| `workflowImportSourceSchema`              | 184,064 B |  64,463 B |
| `chatThreadArtifactGoogleDriveSyncSchema` | 205,951 B |  95,462 B |
| `SKILL_IMPORT_SESSION_TTL_SECONDS`        | 185,794 B |      59 B |
| `verifySkillImportToken`                  | 242,598 B | 162,401 B |
| `artifactCatalogContract`                 | 207,736 B | 164,288 B |

The schema probes still include Zod itself. The complete API is effectively
unchanged (+1 byte); Core, Integrations and Data each shrink by about 1.7 KB.
Other retained business paths still require the broad contracts. This confirms
the smaller import boundary, not a corresponding full-Worker startup gain.
All five moved initializers and both exported validation JSON Schemas are
unchanged.

The distinction is executable initialization: `z.object`, `.extend`, enum
construction, registry construction and provider factories run as JavaScript.
Even when an unwanted export is eliminated, its module-level initialization may
remain if the bundler cannot prove that discarding it preserves behavior.

The original audit also found the following coupling. The shared API-error and
Desktop transform edges have since been extracted; the figures describe the
frozen audit reference, not the refreshed candidate:

- `errors.ts` links the common HTTP error schema to run-balance errors, model
  providers and model metadata. Importing `apiErrorSchema` retains 156,899 B.
- Importing only `MODEL_FIRST_SELECTION_PROVIDER_ID` from the chat contract
  retains 205,983 B; `WEATHER_ATTRIBUTION` retains 164,107 B. Constants share
  modules with runtime schema construction.
- Every route adapter imports Desktop response transforms, whose compatibility
  entry imports the computer-use contract; that isolated probe retains 176,987 B.
  Any narrower composition must preserve the existing compatibility behavior.
- Connector authentication dispatch genuinely indexes its registry at runtime.
  Direct-import syntax alone cannot eliminate its selected handlers.

## DB schema graph

The DB root aggregates 164 table namespaces. A live `schema` import retains
301,924 B across 236 modules, including 179 DB source modules. However, the root
DB module is absent from the actual reference and all four business Worker
bundles. Removing that unused barrel would not improve these builds.

Individual tables still have transitive runtime edges. An `agentRuns` probe
retains 68,925 B and 12 DB source modules through foreign-key references:

```text
runtime/agent-run -> columns/agent-run -> schema/workflow
  -> schema/connector -> schema/org-custom-connector -> schema/storage
```

It also retains chat/computer-use table dependencies. Separating query columns
from migration-only references is a possible follow-up, requiring equivalent
SQL and migration DDL. This experiment changes neither table definitions nor
migrations.

## Types and route rules

All tested `export type` probes emit zero JavaScript. TypeScript still follows
their source dependencies while checking types:

| Type                                             | Workspace source files | Source bytes |
| ------------------------------------------------ | ---------------------: | -----------: |
| `DatabaseSchema` from the DB root                |                    304 |    1,276,665 |
| `AppRoute` from its defining module              |                      2 |       15,903 |
| `ChatRecommendedFollowup` from the chat contract |                     30 |      374,908 |
| `AgentRunLaunchSnapshot` from its JSONB contract |                      4 |        2,571 |

These counts include the probe and exclude dependencies and standard libraries.
They measure compiler graph size, not type-check CPU or memory. The current API
already uses `NodePgDatabase<Record<string, never>>`, avoiding the broad
`DatabaseSchema` type. Type-only fanout cannot explain Worker startup time.

The original full API intentionally imports all handlers through its route
table. The refreshed build statically assigns 671 registrations to four business
Workers (205 / 250 / 212 / 4 at main `327e72f4`). The build-time manifest is
only metadata; requests enter the domain Workers directly. Core, Execution and
Integrations still share substantial execution dependencies, so splitting route
lists is only a first dependency boundary.

Cloudflare startup improvement must be measured separately against frozen
artifacts. Small import probes establish dependency retention, not a startup
speedup or permission to remove runtime validation.
