/**
 * Opaque payload of a retained JSONB column that no current reader decodes.
 * Use only for tables kept until their drop migration.
 */
export type RetiredJsonbPayload = Readonly<Record<string, unknown>>;
