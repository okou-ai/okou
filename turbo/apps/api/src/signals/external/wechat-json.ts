// Adapted from @tencent-weixin/openclaw-weixin 2.4.10.
// Copyright (c) 2026 Tencent. MIT; see ./wechat-MIT.txt.
const LOSSLESS_ID_FIELDS = Object.freeze(["message_id", "msg_id", "svr_id"]);

/**
 * Quote uint64 message identifiers before JSON.parse sees them. This scanner
 * only rewrites actual object properties, never matching text inside JSON strings.
 */
export function parseWechatJson(rawText: string): unknown {
  let output = "";
  let index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index++];
      continue;
    }

    const stringStart = index;
    index++;
    let escaped = false;
    while (index < rawText.length) {
      const char = rawText[index++];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        break;
      }
    }
    const stringToken = rawText.slice(stringStart, index);
    output += stringToken;

    let cursor = index;
    while (/\s/.test(rawText[cursor] ?? "")) {
      cursor++;
    }
    if (rawText[cursor] !== ":") {
      continue;
    }

    const key: unknown = JSON.parse(stringToken);
    if (typeof key !== "string" || !LOSSLESS_ID_FIELDS.includes(key)) {
      continue;
    }

    output += rawText.slice(index, cursor + 1);
    cursor++;
    while (/\s/.test(rawText[cursor] ?? "")) {
      output += rawText[cursor++];
    }
    const numberStart = cursor;
    if (rawText[cursor] === "-") {
      cursor++;
    }
    while (/\d/.test(rawText[cursor] ?? "")) {
      cursor++;
    }
    if (
      cursor > numberStart &&
      !(cursor === numberStart + 1 && rawText[numberStart] === "-")
    ) {
      output += `"${rawText.slice(numberStart, cursor)}"`;
      index = cursor;
    } else {
      index = numberStart;
    }
  }
  return JSON.parse(output) as unknown;
}
