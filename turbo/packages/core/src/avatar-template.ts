const AVATAR_TEMPLATE_STYLE_PRESET_PREFIX = "avatar-template:";

export function parseAvatarTemplateStylePresetId(
  stylePresetId: string,
): number | undefined {
  if (!stylePresetId.startsWith(AVATAR_TEMPLATE_STYLE_PRESET_PREFIX)) {
    return undefined;
  }

  const serializedAvatarId = stylePresetId.slice(
    AVATAR_TEMPLATE_STYLE_PRESET_PREFIX.length,
  );
  if (!/^[1-9]\d*$/.test(serializedAvatarId)) {
    return undefined;
  }

  const avatarId = Number(serializedAvatarId);
  return Number.isSafeInteger(avatarId) ? avatarId : undefined;
}
