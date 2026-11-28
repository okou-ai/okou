import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { array, object, string } from "zod";
import { applyPendingMigrations } from "./migration-runner";
import { createPgRepository as createR2BackfillPgRepository } from "./migrations/001-r2-artifact-visibility-backfill/backfill";

function highUuid(n: number): string {
  return `eeeeeeee-eeee-4eee-8eee-${n.toString(16).padStart(12, "0")}`;
}

function createR2Ids() {
  const tag = randomUUID().slice(0, 8);
  return {
    tag,
    orgId: `org-r2-1656-${tag}`,
    ownerUserId: `user-owner-1656-${tag}`,
    viewerUserId: `user-viewer-1656-${tag}`,
    viewerEmail: `viewer-${tag}@example.com`,
    normalImageFileId: highUuid(1),
    normalImageEntityId: highUuid(2),
    normalImageArtifactId: highUuid(3),
    realPrivateImageFileId: highUuid(4),
    shadowPrivateImageRufId: highUuid(5),
    shadowImageEntityId: highUuid(6),
    shadowImageArtifactId: highUuid(7),
    dupRealImageFileId: highUuid(8),
    dupRealImageEntityId: highUuid(9),
    dupRealImageArtifactId: highUuid(10),
    dupShadowRufId: highUuid(11),
    dupShadowImageEntityId: highUuid(12),
    dupShadowImageArtifactId: highUuid(13),
    missedRealImageFileId: highUuid(14),
    missedRealImageEntityId: highUuid(15),
    missedRealImageArtifactId: highUuid(16),
    realFileId: highUuid(17),
    shadowFileRufId: highUuid(18),
    shadowFileArtifactId: highUuid(19),
    videoFileId: highUuid(20),
    videoEntityId: highUuid(21),
    videoArtifactId: highUuid(22),
    avatarFileId: highUuid(23),
    avatarEntityId: highUuid(24),
    avatarArtifactId: highUuid(25),
    collidingVideoFileId: highUuid(26),
    collidingExistingFileArtifactId: highUuid(27),
    collidingVideoEntityId: highUuid(28),
    collidingVideoArtifactId: highUuid(29),
    displayVideoFileId: highUuid(30),
    displayVideoArtifactId: highUuid(31),
    // Same-batch colliding shadow image_artifacts (no existing canonical image_artifacts)
    batchDupImgRealFileId: highUuid(32),
    batchDupImgShadowRufAId: highUuid(33),
    batchDupImgShadowRufBId: highUuid(34),
    batchDupImgEntityWinnerId: highUuid(35),
    batchDupImgEntityLoserId: highUuid(36),
    batchDupImgArtWinnerId: highUuid(37),
    batchDupImgArtLoserId: highUuid(38),
    // Same-batch colliding kind='video' (no existing kind='file' artifact)
    batchDupVideoFileId: highUuid(39),
    batchDupVideoShadowRufId: highUuid(56),
    batchDupVideoEntityAId: highUuid(40),
    batchDupVideoEntityBId: highUuid(41),
    batchDupVideoArtWinnerId: highUuid(42),
    batchDupVideoArtLoserId: highUuid(43),
    // kind='video' (public) colliding with existing kind='file' + display_kind='video' (private)
    collideDisplayVideoFileId: highUuid(44),
    collideDisplayVideoExistingArtId: highUuid(45),
    collideDisplayVideoEntityId: highUuid(46),
    collideDisplayVideoArtId: highUuid(47),
    // existing_ia without artifact + 2 shadow dup_arts (art_rn=1 private, art_rn=2 public)
    orphanSurvImgFileId: highUuid(48),
    orphanSurvImgEntityId: highUuid(49),
    orphanSurvShadowRufAId: highUuid(50),
    orphanSurvShadowRufBId: highUuid(51),
    orphanSurvShadowEntityAId: highUuid(52),
    orphanSurvShadowEntityBId: highUuid(53),
    orphanSurvShadowArtAId: highUuid(54),
    orphanSurvShadowArtBId: highUuid(55),
  };
}

type R2Ids = ReturnType<typeof createR2Ids>;

async function seedR2Fixtures(sql: postgres.Sql, ids: R2Ids) {
  // Seed >1,000 low-UUID rows in files + image_artifacts + artifacts to cross batch boundaries.
  await sql`
    INSERT INTO run_uploaded_files
      (id, source, external_id, user_id, org_id, filename, content_type,
       size_bytes, storage_key, classification, metadata)
    SELECT
      ('00000000-0000-4000-8001-' || lpad(to_hex(i), 12, '0'))::uuid,
      'agent',
      'pad-' || i::text,
      ${ids.ownerUserId},
      ${ids.orgId},
      'pad-' || i::text || '.png',
      'image/png',
      10,
      'private-artifacts/pad-' || i::text,
      'published-output',
      '{}'::jsonb
    FROM generate_series(1, 1005) AS i
  `;
  await sql`
    INSERT INTO files
      (id, org_id, owner_user_id, storage_key, filename, content_type, size_bytes, origin)
    SELECT
      ('00000000-0000-4000-8001-' || lpad(to_hex(i), 12, '0'))::uuid,
      ${ids.orgId},
      ${ids.ownerUserId},
      'private-artifacts/pad-' || i::text,
      'pad-' || i::text || '.png',
      'image/png',
      10,
      'agent'
    FROM generate_series(1, 1005) AS i
  `;
  await sql`
    INSERT INTO image_artifacts (id, file_id)
    SELECT
      ('00000000-0000-4000-8001-' || lpad(to_hex(i), 12, '0'))::uuid,
      ('00000000-0000-4000-8001-' || lpad(to_hex(i), 12, '0'))::uuid
    FROM generate_series(1, 1005) AS i
  `;

  // Seed real & shadow run_uploaded_files
  await sql`
    INSERT INTO run_uploaded_files
      (id, source, external_id, user_id, org_id, filename, content_type,
       size_bytes, storage_key, classification, metadata)
    VALUES
      (${ids.normalImageFileId}::uuid, 'agent', ${ids.normalImageFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'normal.png', 'image/png', 100, 'private-artifacts/' || ${ids.normalImageFileId} || '/normal.png', 'published-output', '{}'::jsonb),
      (${ids.realPrivateImageFileId}::uuid, 'web', ${ids.realPrivateImageFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'gen.png', 'image/png', 200, 'private-artifacts/' || ${ids.realPrivateImageFileId} || '/gen.png', 'published-output', '{}'::jsonb),
      (${ids.shadowPrivateImageRufId}::uuid, 'web', ${ids.realPrivateImageFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'gen.png', 'image/png', 200, NULL, 'published-output', jsonb_build_object('generatedBy', 'zero-official-image', 's3Key', 'private-artifacts/' || ${ids.realPrivateImageFileId} || '/gen.png')),
      (${ids.dupRealImageFileId}::uuid, 'web', ${ids.dupRealImageFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'dup.png', 'image/png', 250, 'private-artifacts/' || ${ids.dupRealImageFileId} || '/dup.png', 'published-output', '{}'::jsonb),
      (${ids.dupShadowRufId}::uuid, 'web', ${ids.dupRealImageFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'dup.png', 'image/png', 250, NULL, 'published-output', jsonb_build_object('generatedBy', 'zero-official-image', 's3Key', 'private-artifacts/' || ${ids.dupRealImageFileId} || '/dup.png')),
      (${ids.missedRealImageFileId}::uuid, 'agent', ${ids.missedRealImageFileId}, ${ids.ownerUserId}, '', 'missed.png', 'image/png', 300, 'private-artifacts/' || ${ids.missedRealImageFileId} || '/missed.png', 'published-output', '{}'::jsonb),
      (${ids.realFileId}::uuid, 'web', ${ids.realFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'doc.pdf', 'application/pdf', 400, 'private-artifacts/' || ${ids.realFileId} || '/doc.pdf', 'published-output', '{}'::jsonb),
      (${ids.shadowFileRufId}::uuid, 'web', ${ids.realFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'doc.pdf', 'application/pdf', 400, NULL, 'published-output', jsonb_build_object('s3Key', 'private-artifacts/' || ${ids.realFileId} || '/doc.pdf')),
      (${ids.videoFileId}::uuid, 'agent', ${ids.videoFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'clip.mp4', 'video/mp4', 500, 'private-artifacts/' || ${ids.videoFileId} || '/clip.mp4', 'published-output', '{}'::jsonb),
      (${ids.avatarFileId}::uuid, 'agent', ${ids.avatarFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'avatar.mp4', 'video/mp4', 600, 'private-artifacts/' || ${ids.avatarFileId} || '/avatar.mp4', 'published-output', '{}'::jsonb),
      (${ids.collidingVideoFileId}::uuid, 'agent', ${ids.collidingVideoFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'collide.mp4', 'video/mp4', 700, 'private-artifacts/' || ${ids.collidingVideoFileId} || '/collide.mp4', 'published-output', '{}'::jsonb),
      (${ids.displayVideoFileId}::uuid, 'agent', ${ids.displayVideoFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'display.mp4', 'video/mp4', 800, 'private-artifacts/' || ${ids.displayVideoFileId} || '/display.mp4', 'published-output', '{}'::jsonb),
      (${ids.batchDupImgRealFileId}::uuid, 'web', ${ids.batchDupImgRealFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'batch-dup.png', 'image/png', 210, 'private-artifacts/' || ${ids.batchDupImgRealFileId} || '/batch-dup.png', 'published-output', '{}'::jsonb),
      (${ids.batchDupImgShadowRufAId}::uuid, 'web', ${ids.batchDupImgRealFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'batch-dup.png', 'image/png', 210, NULL, 'published-output', jsonb_build_object('generatedBy', 'zero-official-image', 's3Key', 'private-artifacts/' || ${ids.batchDupImgRealFileId} || '/batch-dup.png')),
      (${ids.batchDupImgShadowRufBId}::uuid, 'web', ${ids.batchDupImgRealFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'batch-dup.png', 'image/png', 210, NULL, 'published-output', jsonb_build_object('generatedBy', 'zero-official-image', 's3Key', 'private-artifacts/' || ${ids.batchDupImgRealFileId} || '/batch-dup.png')),
      (${ids.batchDupVideoFileId}::uuid, 'agent', ${ids.batchDupVideoFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'batch-video.mp4', 'video/mp4', 710, 'private-artifacts/' || ${ids.batchDupVideoFileId} || '/batch-video.mp4', 'published-output', '{}'::jsonb),
      (${ids.batchDupVideoShadowRufId}::uuid, 'web', ${ids.batchDupVideoFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'batch-video.mp4', 'video/mp4', 710, NULL, 'published-output', jsonb_build_object('s3Key', 'private-artifacts/' || ${ids.batchDupVideoFileId} || '/batch-video.mp4')),
      (${ids.collideDisplayVideoFileId}::uuid, 'agent', ${ids.collideDisplayVideoFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'collide-display.mp4', 'video/mp4', 720, 'private-artifacts/' || ${ids.collideDisplayVideoFileId} || '/collide-display.mp4', 'published-output', '{}'::jsonb),
      (${ids.orphanSurvImgFileId}::uuid, 'web', ${ids.orphanSurvImgFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'orphan-surv.png', 'image/png', 220, 'private-artifacts/' || ${ids.orphanSurvImgFileId} || '/orphan-surv.png', 'published-output', '{}'::jsonb),
      (${ids.orphanSurvShadowRufAId}::uuid, 'web', ${ids.orphanSurvImgFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'orphan-surv.png', 'image/png', 220, NULL, 'published-output', jsonb_build_object('generatedBy', 'zero-official-image')),
      (${ids.orphanSurvShadowRufBId}::uuid, 'web', ${ids.orphanSurvImgFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'orphan-surv.png', 'image/png', 220, NULL, 'published-output', jsonb_build_object('generatedBy', 'zero-official-image'))
  `;

  // Seed files that R1 already dual-wrote (deliberately omitting missedRealImageFileId and videoFileId)
  await sql`
    INSERT INTO files
      (id, org_id, owner_user_id, storage_key, filename, content_type, size_bytes, origin)
    VALUES
      (${ids.normalImageFileId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'private-artifacts/' || ${ids.normalImageFileId} || '/normal.png', 'normal.png', 'image/png', 100, 'agent'),
      (${ids.realPrivateImageFileId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'private-artifacts/' || ${ids.realPrivateImageFileId} || '/gen.png', 'gen.png', 'image/png', 200, 'agent'),
      (${ids.dupRealImageFileId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'private-artifacts/' || ${ids.dupRealImageFileId} || '/dup.png', 'dup.png', 'image/png', 250, 'agent'),
      (${ids.realFileId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'private-artifacts/' || ${ids.realFileId} || '/doc.pdf', 'doc.pdf', 'application/pdf', 400, 'agent'),
      (${ids.avatarFileId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'private-artifacts/' || ${ids.avatarFileId} || '/avatar.mp4', 'avatar.mp4', 'video/mp4', 600, 'agent'),
      (${ids.collidingVideoFileId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'private-artifacts/' || ${ids.collidingVideoFileId} || '/collide.mp4', 'collide.mp4', 'video/mp4', 700, 'agent'),
      (${ids.displayVideoFileId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'private-artifacts/' || ${ids.displayVideoFileId} || '/display.mp4', 'display.mp4', 'video/mp4', 800, 'agent'),
      (${ids.batchDupImgRealFileId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'private-artifacts/' || ${ids.batchDupImgRealFileId} || '/batch-dup.png', 'batch-dup.png', 'image/png', 210, 'agent'),
      (${ids.batchDupVideoFileId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'private-artifacts/' || ${ids.batchDupVideoFileId} || '/batch-video.mp4', 'batch-video.mp4', 'video/mp4', 710, 'agent'),
      (${ids.collideDisplayVideoFileId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'private-artifacts/' || ${ids.collideDisplayVideoFileId} || '/collide-display.mp4', 'collide-display.mp4', 'video/mp4', 720, 'agent'),
      (${ids.orphanSurvImgFileId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'private-artifacts/' || ${ids.orphanSurvImgFileId} || '/orphan-surv.png', 'orphan-surv.png', 'image/png', 220, 'agent')
  `;

  // Seed image_artifacts (including R1 shadow-row pointers + duplicate shadow + missed real file + same-batch colliding shadows + orphan canonical image_artifact)
  await sql`
    INSERT INTO image_artifacts (id, file_id)
    VALUES
      (${ids.normalImageEntityId}::uuid, ${ids.normalImageFileId}::uuid),
      (${ids.shadowImageEntityId}::uuid, ${ids.shadowPrivateImageRufId}::uuid),
      (${ids.dupRealImageEntityId}::uuid, ${ids.dupRealImageFileId}::uuid),
      (${ids.dupShadowImageEntityId}::uuid, ${ids.dupShadowRufId}::uuid),
      (${ids.missedRealImageEntityId}::uuid, ${ids.missedRealImageFileId}::uuid),
      (${ids.batchDupImgEntityWinnerId}::uuid, ${ids.batchDupImgShadowRufAId}::uuid),
      (${ids.batchDupImgEntityLoserId}::uuid, ${ids.batchDupImgShadowRufBId}::uuid),
      (${ids.orphanSurvImgEntityId}::uuid, ${ids.orphanSurvImgFileId}::uuid),
      (${ids.orphanSurvShadowEntityAId}::uuid, ${ids.orphanSurvShadowRufAId}::uuid),
      (${ids.orphanSurvShadowEntityBId}::uuid, ${ids.orphanSurvShadowRufBId}::uuid)
  `;

  // Seed video_artifacts
  await sql`
    INSERT INTO video_artifacts (id, file_id)
    VALUES
      (${ids.videoEntityId}::uuid, ${ids.videoFileId}::uuid),
      (${ids.avatarEntityId}::uuid, ${ids.avatarFileId}::uuid),
      (${ids.collidingVideoEntityId}::uuid, ${ids.collidingVideoFileId}::uuid),
      (${ids.batchDupVideoEntityAId}::uuid, ${ids.batchDupVideoFileId}::uuid),
      (${ids.batchDupVideoEntityBId}::uuid, ${ids.batchDupVideoShadowRufId}::uuid),
      (${ids.collideDisplayVideoEntityId}::uuid, ${ids.collideDisplayVideoFileId}::uuid)
  `;

  // Seed artifacts across all normalization cases
  await sql`
    INSERT INTO artifacts
      (id, org_id, author_user_id, kind, entity_id, logical_key,
       display_kind, projection_file_id, projection_created_at, title, visibility, category)
    VALUES
      (${ids.normalImageArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'image', ${ids.normalImageEntityId}::uuid, 'image:normal-' || ${ids.tag}, NULL, ${ids.normalImageFileId}::uuid, now(), 'normal.png', 'private', 'image'),
      (${ids.shadowImageArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'image', ${ids.shadowImageEntityId}::uuid, 'image:shadow-' || ${ids.tag}, NULL, ${ids.shadowPrivateImageRufId}::uuid, now(), 'gen.png', 'private', 'image'),
      (${ids.dupRealImageArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'image', ${ids.dupRealImageEntityId}::uuid, 'image:dup-real-' || ${ids.tag}, NULL, ${ids.dupRealImageFileId}::uuid, now(), 'dup.png', 'private', 'image'),
      (${ids.dupShadowImageArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'image', ${ids.dupShadowImageEntityId}::uuid, 'image:dup-shadow-' || ${ids.tag}, NULL, ${ids.dupShadowRufId}::uuid, now(), 'dup.png', 'public', 'image'),
      (${ids.missedRealImageArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'image', ${ids.missedRealImageEntityId}::uuid, 'image:missed-' || ${ids.tag}, NULL, ${ids.missedRealImageFileId}::uuid, now(), 'missed.png', 'private', 'image'),
      (${ids.shadowFileArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'file', ${ids.shadowFileRufId}::uuid, 'file:shadow-' || ${ids.tag}, NULL, ${ids.shadowFileRufId}::uuid, now(), 'doc.pdf', 'private', 'document'),
      (${ids.videoArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'video', ${ids.videoEntityId}::uuid, 'file:video-' || ${ids.tag}, NULL, ${ids.videoFileId}::uuid, now(), 'clip.mp4', 'organization', NULL),
      (${ids.avatarArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'video', ${ids.avatarEntityId}::uuid, 'file:avatar-' || ${ids.tag}, 'avatar', ${ids.avatarFileId}::uuid, now(), 'avatar.mp4', 'private', NULL),
      (${ids.collidingExistingFileArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'file', ${ids.collidingVideoFileId}::uuid, 'file:collide-existing-' || ${ids.tag}, NULL, ${ids.collidingVideoFileId}::uuid, now(), 'collide.mp4', 'private', NULL),
      (${ids.collidingVideoArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'video', ${ids.collidingVideoEntityId}::uuid, 'file:collide-video-' || ${ids.tag}, 'video', ${ids.collidingVideoFileId}::uuid, now(), 'collide.mp4', 'public', 'video'),
      (${ids.displayVideoArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'file', ${ids.displayVideoFileId}::uuid, 'file:display-video-' || ${ids.tag}, 'video', ${ids.displayVideoFileId}::uuid, now(), 'display.mp4', 'private', NULL),
      (${ids.batchDupImgArtWinnerId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'image', ${ids.batchDupImgEntityWinnerId}::uuid, 'image:batch-dup-winner-' || ${ids.tag}, NULL, ${ids.batchDupImgShadowRufAId}::uuid, now(), 'batch-dup.png', 'private', 'image'),
      (${ids.batchDupImgArtLoserId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'image', ${ids.batchDupImgEntityLoserId}::uuid, 'image:batch-dup-loser-' || ${ids.tag}, NULL, ${ids.batchDupImgShadowRufBId}::uuid, now(), 'batch-dup.png', 'public', 'image'),
      (${ids.batchDupVideoArtWinnerId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'video', ${ids.batchDupVideoEntityAId}::uuid, 'file:batch-video-winner-' || ${ids.tag}, 'video', ${ids.batchDupVideoFileId}::uuid, now(), 'batch-video.mp4', 'private', NULL),
      (${ids.batchDupVideoArtLoserId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'video', ${ids.batchDupVideoEntityBId}::uuid, 'file:batch-video-loser-' || ${ids.tag}, 'video', ${ids.batchDupVideoFileId}::uuid, now(), 'batch-video.mp4', 'public', 'video'),
      (${ids.collideDisplayVideoExistingArtId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'file', ${ids.collideDisplayVideoFileId}::uuid, 'file:collide-display-existing-' || ${ids.tag}, 'video', ${ids.collideDisplayVideoFileId}::uuid, now(), 'collide-display.mp4', 'private', NULL),
      (${ids.collideDisplayVideoArtId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'video', ${ids.collideDisplayVideoEntityId}::uuid, 'file:collide-display-video-' || ${ids.tag}, NULL, ${ids.collideDisplayVideoFileId}::uuid, now(), 'collide-display.mp4', 'public', 'video'),
      (${ids.orphanSurvShadowArtAId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'image', ${ids.orphanSurvShadowEntityAId}::uuid, 'image:orphan-surv-a-' || ${ids.tag}, NULL, ${ids.orphanSurvShadowRufAId}::uuid, now(), 'orphan-surv.png', 'private', 'image'),
      (${ids.orphanSurvShadowArtBId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'image', ${ids.orphanSurvShadowEntityBId}::uuid, 'image:orphan-surv-b-' || ${ids.tag}, NULL, ${ids.orphanSurvShadowRufBId}::uuid, now(), 'orphan-surv.png', 'public', 'image')
  `;

  // Attach user shares & favorites to duplicate artifacts to confirm merge preservation
  await sql`
    INSERT INTO artifact_user_shares (user_id, org_id, artifact_id, email)
    VALUES
      (${ids.viewerUserId}, ${ids.orgId}, ${ids.dupShadowImageArtifactId}::uuid, ${ids.viewerEmail}),
      (${ids.viewerUserId}, ${ids.orgId}, ${ids.collidingVideoArtifactId}::uuid, ${ids.viewerEmail}),
      (${ids.viewerUserId}, ${ids.orgId}, ${ids.batchDupImgArtLoserId}::uuid, ${ids.viewerEmail}),
      (${ids.viewerUserId}, ${ids.orgId}, ${ids.batchDupVideoArtLoserId}::uuid, ${ids.viewerEmail}),
      (${ids.viewerUserId}, ${ids.orgId}, ${ids.collideDisplayVideoArtId}::uuid, ${ids.viewerEmail}),
      (${ids.viewerUserId}, ${ids.orgId}, ${ids.orphanSurvShadowArtBId}::uuid, ${ids.viewerEmail})
  `;
  await sql`
    INSERT INTO artifact_favorites (org_id, user_id, artifact_id)
    VALUES
      (${ids.orgId}, ${ids.ownerUserId}, ${ids.dupShadowImageArtifactId}::uuid),
      (${ids.orgId}, ${ids.ownerUserId}, ${ids.collidingVideoArtifactId}::uuid),
      (${ids.orgId}, ${ids.ownerUserId}, ${ids.batchDupImgArtLoserId}::uuid),
      (${ids.orgId}, ${ids.ownerUserId}, ${ids.batchDupVideoArtLoserId}::uuid),
      (${ids.orgId}, ${ids.ownerUserId}, ${ids.collideDisplayVideoArtId}::uuid),
      (${ids.orgId}, ${ids.ownerUserId}, ${ids.orphanSurvShadowArtBId}::uuid)
  `;
}

async function verifyPre1656BackfillPgLookup(sql: postgres.Sql, ids: R2Ids) {
  const repo = createR2BackfillPgRepository(sql);
  const matches = await repo.findActiveFileArtifactsBatch([
    ids.realPrivateImageFileId,
    ids.shadowPrivateImageRufId,
    ids.orphanSurvImgFileId,
    ids.videoFileId,
    ids.batchDupVideoShadowRufId,
  ]);

  const artifactIdsFor = (fileId: string): string[] => {
    return (matches.get(fileId) ?? [])
      .map((m) => {
        return m.artifactId;
      })
      .sort();
  };

  // Canonical fileId discovers shadow image artifact via storage_key / s3Key / external_id
  assert.deepEqual(artifactIdsFor(ids.realPrivateImageFileId), [
    ids.shadowImageArtifactId,
  ]);
  assert.deepEqual(artifactIdsFor(ids.shadowPrivateImageRufId), [
    ids.shadowImageArtifactId,
  ]);
  // Reverse external_id shadow link (shadows without storage_key/s3Key) discovers both shadow image artifacts
  assert.deepEqual(
    artifactIdsFor(ids.orphanSurvImgFileId),
    [ids.orphanSurvShadowArtAId, ids.orphanSurvShadowArtBId].sort(),
  );
  // Pre-1656 kind='video' artifact matched through video_artifacts
  assert.deepEqual(artifactIdsFor(ids.videoFileId), [ids.videoArtifactId]);
  // Shadow video fileId discovers both canonical and shadow kind='video' artifacts
  assert.deepEqual(
    artifactIdsFor(ids.batchDupVideoShadowRufId),
    [ids.batchDupVideoArtWinnerId, ids.batchDupVideoArtLoserId].sort(),
  );
}

async function verifyR2MigrationResults(sql: postgres.Sql, ids: R2Ids) {
  // 1. Missing real files were backfilled into files
  const backfilledFiles = await sql<{ id: string; org_id: string }[]>`
    SELECT id, org_id FROM files
    WHERE id = ANY(${[ids.missedRealImageFileId, ids.videoFileId]}::uuid[])
    ORDER BY id
  `;
  assert.deepEqual(
    [...backfilledFiles],
    [ids.missedRealImageFileId, ids.videoFileId].sort().map((id) => {
      return { id, org_id: ids.orgId };
    }),
  );

  // 2. Shadow image_artifacts repointed to canonical files.id; duplicates merged cleanly
  const imageEntities = await sql<{ id: string; file_id: string }[]>`
    SELECT id, file_id FROM image_artifacts
    WHERE id = ANY(${[
      ids.normalImageEntityId,
      ids.shadowImageEntityId,
      ids.dupRealImageEntityId,
      ids.dupShadowImageEntityId,
      ids.missedRealImageEntityId,
      ids.batchDupImgEntityWinnerId,
      ids.batchDupImgEntityLoserId,
      ids.orphanSurvImgEntityId,
      ids.orphanSurvShadowEntityAId,
      ids.orphanSurvShadowEntityBId,
    ]}::uuid[])
    ORDER BY id
  `;
  assert.deepEqual(
    [...imageEntities],
    [
      { id: ids.normalImageEntityId, file_id: ids.normalImageFileId },
      { id: ids.shadowImageEntityId, file_id: ids.realPrivateImageFileId },
      { id: ids.dupRealImageEntityId, file_id: ids.dupRealImageFileId },
      { id: ids.missedRealImageEntityId, file_id: ids.missedRealImageFileId },
      { id: ids.batchDupImgEntityWinnerId, file_id: ids.batchDupImgRealFileId },
      { id: ids.orphanSurvImgEntityId, file_id: ids.orphanSurvImgFileId },
    ].sort((a, b) => {
      return a.id.localeCompare(b.id);
    }),
  );

  // 3. Artifacts repointed, merged, and normalized (0 kind='video' / display_kind='video')
  const remainingVideos = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM artifacts
    WHERE org_id = ${ids.orgId}
      AND (kind = 'video' OR display_kind = 'video')
  `;
  assert.equal(remainingVideos[0]?.count, "0");

  const artifactsById = new Map(
    (
      await sql<
        {
          id: string;
          kind: string;
          entity_id: string;
          projection_file_id: string | null;
          display_kind: string | null;
          visibility: string;
          category: string | null;
        }[]
      >`
        SELECT id, kind, entity_id, projection_file_id, display_kind, visibility, category
        FROM artifacts
        WHERE org_id = ${ids.orgId}
      `
    ).map((row) => {
      return [row.id, row];
    }),
  );

  assert.equal(
    artifactsById.get(ids.shadowImageArtifactId)?.projection_file_id,
    ids.realPrivateImageFileId,
  );
  assert.equal(artifactsById.has(ids.dupShadowImageArtifactId), false);
  assert.equal(
    artifactsById.get(ids.dupRealImageArtifactId)?.visibility,
    "public",
  );

  // Same-batch colliding shadow image_artifacts (no existing canonical image_artifact)
  assert.equal(artifactsById.has(ids.batchDupImgArtLoserId), false);
  assert.deepEqual(artifactsById.get(ids.batchDupImgArtWinnerId), {
    id: ids.batchDupImgArtWinnerId,
    kind: "image",
    entity_id: ids.batchDupImgEntityWinnerId,
    projection_file_id: ids.batchDupImgRealFileId,
    display_kind: null,
    visibility: "public",
    category: "image",
  });

  // Existing canonical image_artifact without artifact + 2 colliding shadow dup_arts
  assert.equal(artifactsById.has(ids.orphanSurvShadowArtBId), false);
  assert.deepEqual(artifactsById.get(ids.orphanSurvShadowArtAId), {
    id: ids.orphanSurvShadowArtAId,
    kind: "image",
    entity_id: ids.orphanSurvImgEntityId,
    projection_file_id: ids.orphanSurvImgFileId,
    display_kind: null,
    visibility: "public",
    category: "image",
  });

  assert.equal(
    artifactsById.get(ids.shadowFileArtifactId)?.entity_id,
    ids.realFileId,
  );
  assert.equal(
    artifactsById.get(ids.shadowFileArtifactId)?.projection_file_id,
    ids.realFileId,
  );

  assert.deepEqual(artifactsById.get(ids.videoArtifactId), {
    id: ids.videoArtifactId,
    kind: "file",
    entity_id: ids.videoFileId,
    projection_file_id: ids.videoFileId,
    display_kind: null,
    visibility: "organization",
    category: "video",
  });
  assert.deepEqual(artifactsById.get(ids.avatarArtifactId), {
    id: ids.avatarArtifactId,
    kind: "file",
    entity_id: ids.avatarFileId,
    projection_file_id: ids.avatarFileId,
    display_kind: "avatar",
    visibility: "private",
    category: "other",
  });
  assert.equal(artifactsById.has(ids.collidingVideoArtifactId), false);
  assert.deepEqual(artifactsById.get(ids.collidingExistingFileArtifactId), {
    id: ids.collidingExistingFileArtifactId,
    kind: "file",
    entity_id: ids.collidingVideoFileId,
    projection_file_id: ids.collidingVideoFileId,
    display_kind: null,
    visibility: "public",
    category: "video",
  });
  assert.deepEqual(artifactsById.get(ids.displayVideoArtifactId), {
    id: ids.displayVideoArtifactId,
    kind: "file",
    entity_id: ids.displayVideoFileId,
    projection_file_id: ids.displayVideoFileId,
    display_kind: null,
    visibility: "private",
    category: "video",
  });

  // Same-batch colliding kind='video' (no existing kind='file' row)
  assert.equal(artifactsById.has(ids.batchDupVideoArtLoserId), false);
  assert.deepEqual(artifactsById.get(ids.batchDupVideoArtWinnerId), {
    id: ids.batchDupVideoArtWinnerId,
    kind: "file",
    entity_id: ids.batchDupVideoFileId,
    projection_file_id: ids.batchDupVideoFileId,
    display_kind: null,
    visibility: "public",
    category: "video",
  });

  // kind='video' (public) colliding with existing kind='file' + display_kind='video' (private)
  assert.equal(artifactsById.has(ids.collideDisplayVideoArtId), false);
  assert.deepEqual(artifactsById.get(ids.collideDisplayVideoExistingArtId), {
    id: ids.collideDisplayVideoExistingArtId,
    kind: "file",
    entity_id: ids.collideDisplayVideoFileId,
    projection_file_id: ids.collideDisplayVideoFileId,
    display_kind: null,
    visibility: "public",
    category: "video",
  });

  // 4. Merged duplicates preserved shares & favorites on surviving artifacts
  const expectedSurvivingSharedIds = [
    ids.dupRealImageArtifactId,
    ids.collidingExistingFileArtifactId,
    ids.batchDupImgArtWinnerId,
    ids.batchDupVideoArtWinnerId,
    ids.collideDisplayVideoExistingArtId,
    ids.orphanSurvShadowArtAId,
  ].sort();

  const shares = await sql<{ artifact_id: string }[]>`
    SELECT artifact_id FROM artifact_user_shares
    WHERE org_id = ${ids.orgId} AND user_id = ${ids.viewerUserId}
    ORDER BY artifact_id
  `;
  assert.deepEqual(
    [...shares],
    expectedSurvivingSharedIds.map((artifactId) => {
      return { artifact_id: artifactId };
    }),
  );
  const favorites = await sql<{ artifact_id: string }[]>`
    SELECT artifact_id FROM artifact_favorites
    WHERE org_id = ${ids.orgId} AND user_id = ${ids.ownerUserId}
    ORDER BY artifact_id
  `;
  assert.deepEqual(
    [...favorites],
    expectedSurvivingSharedIds.map((artifactId) => {
      return { artifact_id: artifactId };
    }),
  );

  // 5. FK on image_artifacts.file_id now targets files(id) and is validated
  const fks = await sql<
    { conname: string; validated: boolean; target_table: string }[]
  >`
    SELECT c.conname, c.convalidated AS validated,
           c.confrelid::regclass::text AS target_table
    FROM pg_constraint c
    WHERE c.conrelid = 'public.image_artifacts'::regclass
      AND c.contype = 'f'
      AND c.conname LIKE 'image_artifacts_file_id_%'
    ORDER BY c.conname
  `;
  assert.deepEqual(
    [...fks],
    [
      {
        conname: "image_artifacts_file_id_files_id_fk",
        validated: true,
        target_table: "files",
      },
    ],
  );
}

async function verify1656ReplayIdempotency(sql: postgres.Sql, orgId: string) {
  const beforeFiles = await sql<{ id: string; xmin: string }[]>`
    SELECT id, xmin::text AS xmin FROM files
    WHERE org_id = ${orgId} ORDER BY id
  `;
  const beforeArtifacts = await sql<{ id: string; xmin: string }[]>`
    SELECT id, xmin::text AS xmin FROM artifacts
    WHERE org_id = ${orgId} ORDER BY id
  `;
  const beforeImages = await sql<{ id: string; xmin: string }[]>`
    SELECT ia.id, ia.xmin::text AS xmin
    FROM image_artifacts ia
    INNER JOIN files f ON f.id = ia.file_id
    WHERE f.org_id = ${orgId}
    ORDER BY ia.id
  `;

  const migrationSql = await readFile(
    new URL(
      "../src/migrations/1656_normalize_video_and_repoint_file_references.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const batchStatements = migrationSql
    .split("--> statement-breakpoint")
    .map((s) => {
      return s.trim();
    })
    .filter((s) => {
      return s.includes("-- okou:batch-by-uuid");
    });
  assert.equal(batchStatements.length, 6);
  for (const stmt of batchStatements) {
    let cursor: string | null = null;
    do {
      const [page] = array(object({ next_cursor: string().nullable() })).parse(
        await sql.unsafe(stmt, [cursor]),
      );
      assert.ok(page);
      cursor = page.next_cursor;
    } while (cursor !== null);
  }

  assert.deepEqual(
    [
      ...(await sql<{ id: string; xmin: string }[]>`
        SELECT id, xmin::text AS xmin FROM files
        WHERE org_id = ${orgId} ORDER BY id
      `),
    ],
    [...beforeFiles],
  );
  assert.deepEqual(
    [
      ...(await sql<{ id: string; xmin: string }[]>`
        SELECT id, xmin::text AS xmin FROM artifacts
        WHERE org_id = ${orgId} ORDER BY id
      `),
    ],
    [...beforeArtifacts],
  );
  assert.deepEqual(
    [
      ...(await sql<{ id: string; xmin: string }[]>`
        SELECT ia.id, ia.xmin::text AS xmin
        FROM image_artifacts ia
        INNER JOIN files f ON f.id = ia.file_id
        WHERE f.org_id = ${orgId}
        ORDER BY ia.id
      `),
    ],
    [...beforeImages],
  );
}

/**
 * Transition validator for migrations 1656 and 1657:
 * seeds R1 shadow image_artifacts rows, duplicate shadow rows, missed real files,
 * and historical kind='video' / display_kind='video' rows across batch boundaries,
 * applies 1656 + 1657 through `applyPendingMigrations`, verifies FK cutover and
 * data normalization, and confirms replay of 1656 is a zero-rewrite no-op.
 */
export async function validateR2FileFkAndVideoNormalization(
  databaseUrl: string,
  normalizeMillis: number,
  fkCutoverMillis: number,
) {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const ids = createR2Ids();

  try {
    await applyPendingMigrations(sql, { beforeMillis: normalizeMillis });
    await seedR2Fixtures(sql, ids);
    await verifyPre1656BackfillPgLookup(sql, ids);
    await applyPendingMigrations(sql, { beforeMillis: fkCutoverMillis + 1 });

    await verifyR2MigrationResults(sql, ids);
    await verify1656ReplayIdempotency(sql, ids.orgId);

    console.log(
      "Migrations 1656 & 1657 shadow-row repoint, video normalization, image_artifacts FK cutover, and replay idempotency verified",
    );
  } finally {
    try {
      await sql`DELETE FROM artifact_favorites WHERE org_id = ${ids.orgId}`;
      await sql`DELETE FROM artifacts WHERE org_id = ${ids.orgId}`;
      await sql`DELETE FROM files WHERE org_id = ${ids.orgId}`;
      await sql`DELETE FROM run_uploaded_files WHERE user_id = ${ids.ownerUserId}`;
    } finally {
      await sql.end();
    }
  }
}
