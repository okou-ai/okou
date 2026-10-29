import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/** Fractional ranks use byte ordering, with UUIDs breaking concurrent ties. */
export function compareChatFolders(
  left: { readonly id: string; readonly sortKey: string },
  right: { readonly id: string; readonly sortKey: string },
): number {
  if (left.sortKey !== right.sortKey)
    return left.sortKey < right.sortKey ? -1 : 1;
  return left.id < right.id ? -1 : left.id === right.id ? 0 : 1;
}

export function chatFolderKeyBetween(
  left: string | null,
  right: string | null,
): string {
  return generateKeyBetween(left, right);
}

export function moveChatFolderRanks(
  folders: readonly { readonly id: string; readonly sortKey: string }[],
  id: string,
  beforeId: string | null,
  afterId: string | null,
): { id: string; sortKey: string }[] {
  const remaining = folders
    .filter((folder) => {
      return folder.id !== id;
    })
    .sort(compareChatFolders);
  const before = remaining.find((folder) => {
    return folder.id === beforeId;
  });
  const afterIndex = remaining.findIndex((folder) => {
    return folder.id === afterId;
  });
  const after = remaining[afterIndex];
  if (!before || !after || before.sortKey !== after.sortKey) {
    return [
      {
        id,
        sortKey: generateKeyBetween(
          before?.sortKey ?? null,
          after?.sortKey ?? null,
        ),
      },
    ];
  }
  // Concurrent drops may have equal ranks. Re-rank only the tied suffix in
  // the same statement so a later drop can still occupy its requested gap.
  let end = afterIndex;
  while (end < remaining.length && remaining[end]!.sortKey === before.sortKey)
    end++;
  const suffix = remaining.slice(afterIndex, end);
  const ids = [
    id,
    ...suffix.map((folder) => {
      return folder.id;
    }),
  ];
  const keys = generateNKeysBetween(
    before.sortKey,
    remaining[end]?.sortKey ?? null,
    ids.length,
  );
  return ids.map((folderId, index) => {
    return {
      id: folderId,
      sortKey: keys[index]!,
    };
  });
}
