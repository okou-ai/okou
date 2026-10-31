import { string } from "zod";

/** Discord snowflakes must never pass through a JavaScript number. */
export const discordSnowflakeSchema = string()
  .regex(/^[1-9]\d{0,19}$/, "Expected a Discord snowflake ID")
  .refine(
    (value) => {
      return value.length < 20 || value <= "18446744073709551615";
    },
    { message: "Discord snowflake ID exceeds the unsigned 64-bit range" },
  );
