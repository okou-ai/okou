import { command } from "ccstate";
import {
  getCustomConnectorSkillName,
  getCustomConnectorSkillStorageName,
} from "@okouai/core/storage-names";
import { synthesizeSkillMd } from "@okouai/core/skill-document";

import type { Db } from "../external/db";
import {
  commitPreparedVolumeServerSide,
  prepareVolumeServerSide$,
  type PreparedServerSideVolume,
} from "./storage-volume-publication.service";
import { SKILL_FILENAME } from "./workflow-volume.service";

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
    { set },
    args: PrepareCustomConnectorSkillVolumeInput,
    signal: AbortSignal,
  ): Promise<PreparedServerSideVolume> => {
    const volume = await set(
      prepareVolumeServerSide$,
      {
        orgId: args.orgId,
        storageName: getCustomConnectorSkillStorageName(args.connectorId),
        files: buildCustomConnectorSkillFiles(args),
        piResourceIndex: true,
      },
      signal,
    );
    signal.throwIfAborted();
    return volume;
  },
);

export async function commitPreparedCustomConnectorSkillStorage(
  args: {
    readonly db: Db;
    readonly volume: PreparedServerSideVolume;
  },
  signal: AbortSignal,
): Promise<void> {
  await commitPreparedVolumeServerSide(
    { db: args.db, volume: args.volume },
    signal,
  );
}
