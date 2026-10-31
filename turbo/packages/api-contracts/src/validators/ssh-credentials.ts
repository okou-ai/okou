import {
  discriminatedUnion,
  int,
  literal,
  object,
  string,
  union,
  uuid,
} from "zod";

export const SSH_DISPLAY_NAME_MAX_LENGTH = 128;
export const SSH_USERNAME_MAX_LENGTH = 255;
export const SSH_PRIVATE_KEY_MAX_LENGTH = 65_536;
export const SSH_PASSPHRASE_MAX_LENGTH = 4_096;
export const SSH_PASSWORD_MAX_LENGTH = 4_096;

export const sshAuthenticationSchema = discriminatedUnion("method", [
  object({
    method: literal("private_key"),
    privateKey: string().min(1).max(SSH_PRIVATE_KEY_MAX_LENGTH),
    passphrase: string()
      .min(1)
      .max(SSH_PASSPHRASE_MAX_LENGTH)
      .nullable()
      .default(null),
  }).strict(),
  object({
    method: literal("password"),
    password: string().min(1).max(SSH_PASSWORD_MAX_LENGTH),
  }).strict(),
]);
const nameSchema = string().trim().min(1).max(SSH_DISPLAY_NAME_MAX_LENGTH);
const usernameSchema = string().trim().min(1).max(SSH_USERNAME_MAX_LENGTH);
export const revisionSchema = int().positive().max(2_147_483_647);

export const createSshCredentialRequestSchema = object({
  name: nameSchema,
  username: usernameSchema,
  authentication: sshAuthenticationSchema,
}).strict();
export const updateSshCredentialRequestSchema = object({
  expectedRevision: revisionSchema,
  name: nameSchema.optional(),
  username: usernameSchema.optional(),
  authentication: sshAuthenticationSchema.optional(),
})
  .strict()
  .refine(
    (value) => {
      return (
        value.name !== undefined ||
        value.username !== undefined ||
        value.authentication !== undefined
      );
    },
    { message: "At least one SSH credential field must be updated" },
  );

export const sshCredentialSelectionSchema = union([
  object({ id: uuid() }).strict(),
  object({ create: createSshCredentialRequestSchema }).strict(),
]);
