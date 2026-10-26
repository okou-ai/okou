import { unknown as zUnknown } from "zod";

/** Runner owns the explanation; consumers validate only size and terminal safety. */
export const diagnosticTextSchema = zUnknown()
  .transform((value) => {
    if (
      typeof value === "string" &&
      Buffer.byteLength(value) <= 8192 &&
      ![...value].some((char) => {
        const code = char.codePointAt(0);
        return (
          code !== undefined &&
          ((code < 32 && code !== 9 && code !== 10) ||
            (code >= 127 && code <= 159))
        );
      })
    )
      return value;
    return undefined;
  })
  .optional();
