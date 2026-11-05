import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { orgCustomConnectorSkillBundles } from "@okouai/db/runtime/org-custom-connector-skill-bundle";
import {
  getCustomConnectorSkillName,
  getCustomConnectorSkillStorageName,
} from "@okouai/core/storage-names";
import { synthesizeSkillMd } from "@okouai/core/skill-document";
import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import { publishContentBundle$ } from "./content-bundle.service";
import { db$ } from "../external/db";

import {
  prepareVolumeServerSide$,
  type PreparedServerSideVolume,
} from "./storage-volume-publication.service";
const SKILL_FILENAME = "SKILL.md";

export interface PreparedCustomConnectorSkill extends PreparedServerSideVolume {
  readonly contentBundle: ContentBundle;
}

interface CustomConnectorSkillContentInput {
  readonly connectorId: string;
  readonly connectorSlug: string;
  readonly displayName: string;
  readonly skillMarkdown: string;
  readonly skillName?: string;
  readonly skillDescription?: string;
}

interface PrepareCustomConnectorSkillVolumeInput extends CustomConnectorSkillContentInput {
  readonly orgId: string;
}

function buildCustomConnectorSkillFiles(
  args: CustomConnectorSkillContentInput,
): readonly { readonly path: string; readonly content: string }[] {
  return [
    {
      path: SKILL_FILENAME,
      content: synthesizeSkillMd({
        name:
          args.skillName ??
          getCustomConnectorSkillName(args.connectorSlug, args.connectorId),
        description: args.skillDescription ?? args.displayName,
        instruction: args.skillMarkdown,
      }),
    },
  ];
}

export const prepareCustomConnectorSkillVolume$ = command(
  async (
    { get, set },
    args: PrepareCustomConnectorSkillVolumeInput,
    signal: AbortSignal,
  ): Promise<PreparedCustomConnectorSkill> => {
    const files = buildCustomConnectorSkillFiles(args);
    const volume = await set(
      prepareVolumeServerSide$,
      {
        orgId: args.orgId,
        storageName: getCustomConnectorSkillStorageName(args.connectorId),
        files,
        piResourceIndex: true,
      },
      signal,
    );
    signal.throwIfAborted();
    const [registered] = await get(db$)
      .select({
        contentBundle: orgCustomConnectorSkillBundles.skillContentBundle,
        sourceVersionId:
          orgCustomConnectorSkillBundles.skillContentBundleSourceVersionId,
      })
      .from(orgCustomConnectorSkillBundles)
      .where(
        and(
          eq(orgCustomConnectorSkillBundles.id, args.connectorId),
          eq(orgCustomConnectorSkillBundles.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    // A successful owner publication already attested to these shared bytes.
    // Reuse only its exact source; older writers can leave a stale reference.
    if (
      registered?.contentBundle &&
      registered.sourceVersionId === volume.version.versionId
    ) {
      return { ...volume, contentBundle: registered.contentBundle };
    }
    const contentBundle = await set(
      publishContentBundle$,
      files.map((file) => {
        return {
          path: file.path,
          content: Buffer.from(file.content, "utf8"),
          mode: 0o644 as const,
        };
      }),
      signal,
    );
    return { ...volume, contentBundle };
  },
);
