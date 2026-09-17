const TOKEN_CATEGORY_INPUT = "tokens.input";
const TOKEN_CATEGORY_OUTPUT = "tokens.output";
const TOKEN_CATEGORY_CACHE_READ = "tokens.cache_read";
const TOKEN_CATEGORY_CACHE_CREATION = "tokens.cache_creation";
const TOKEN_CATEGORY_INPUT_LONG_CONTEXT = "tokens.input.long_context";
const TOKEN_CATEGORY_OUTPUT_LONG_CONTEXT = "tokens.output.long_context";
const TOKEN_CATEGORY_CACHE_READ_LONG_CONTEXT = "tokens.cache_read.long_context";
const TOKEN_CATEGORY_CACHE_CREATION_LONG_CONTEXT =
  "tokens.cache_creation.long_context";
const TOKEN_CATEGORY_INPUT_FAST = "tokens.input.fast";
const TOKEN_CATEGORY_OUTPUT_FAST = "tokens.output.fast";
const TOKEN_CATEGORY_CACHE_READ_FAST = "tokens.cache_read.fast";
const TOKEN_CATEGORY_CACHE_CREATION_FAST = "tokens.cache_creation.fast";
const TOKEN_CATEGORY_INPUT_LONG_CONTEXT_FAST = "tokens.input.long_context.fast";
const TOKEN_CATEGORY_OUTPUT_LONG_CONTEXT_FAST =
  "tokens.output.long_context.fast";
const TOKEN_CATEGORY_CACHE_READ_LONG_CONTEXT_FAST =
  "tokens.cache_read.long_context.fast";
const TOKEN_CATEGORY_CACHE_CREATION_LONG_CONTEXT_FAST =
  "tokens.cache_creation.long_context.fast";

export const MODEL_TOKEN_CATEGORIES = [
  TOKEN_CATEGORY_INPUT,
  TOKEN_CATEGORY_OUTPUT,
  TOKEN_CATEGORY_CACHE_READ,
  TOKEN_CATEGORY_CACHE_CREATION,
  TOKEN_CATEGORY_INPUT_LONG_CONTEXT,
  TOKEN_CATEGORY_OUTPUT_LONG_CONTEXT,
  TOKEN_CATEGORY_CACHE_READ_LONG_CONTEXT,
  TOKEN_CATEGORY_CACHE_CREATION_LONG_CONTEXT,
  TOKEN_CATEGORY_INPUT_FAST,
  TOKEN_CATEGORY_OUTPUT_FAST,
  TOKEN_CATEGORY_CACHE_READ_FAST,
  TOKEN_CATEGORY_CACHE_CREATION_FAST,
  TOKEN_CATEGORY_INPUT_LONG_CONTEXT_FAST,
  TOKEN_CATEGORY_OUTPUT_LONG_CONTEXT_FAST,
  TOKEN_CATEGORY_CACHE_READ_LONG_CONTEXT_FAST,
  TOKEN_CATEGORY_CACHE_CREATION_LONG_CONTEXT_FAST,
] as const;

export const MODEL_INPUT_TOKEN_CATEGORIES = [
  TOKEN_CATEGORY_INPUT,
  TOKEN_CATEGORY_INPUT_LONG_CONTEXT,
  TOKEN_CATEGORY_INPUT_FAST,
  TOKEN_CATEGORY_INPUT_LONG_CONTEXT_FAST,
  "tokens.input.text",
  "tokens.input.audio",
] as const;

export const MODEL_OUTPUT_TOKEN_CATEGORIES = [
  TOKEN_CATEGORY_OUTPUT,
  TOKEN_CATEGORY_OUTPUT_LONG_CONTEXT,
  TOKEN_CATEGORY_OUTPUT_FAST,
  TOKEN_CATEGORY_OUTPUT_LONG_CONTEXT_FAST,
  "tokens.output.text",
  "tokens.output.audio",
] as const;

export const MODEL_CACHE_READ_TOKEN_CATEGORIES = [
  TOKEN_CATEGORY_CACHE_READ,
  TOKEN_CATEGORY_CACHE_READ_LONG_CONTEXT,
  TOKEN_CATEGORY_CACHE_READ_FAST,
  TOKEN_CATEGORY_CACHE_READ_LONG_CONTEXT_FAST,
  "tokens.input.cached_text",
  "tokens.input.cached_audio",
] as const;

export const MODEL_CACHE_CREATION_TOKEN_CATEGORIES = [
  TOKEN_CATEGORY_CACHE_CREATION,
  TOKEN_CATEGORY_CACHE_CREATION_LONG_CONTEXT,
  TOKEN_CATEGORY_CACHE_CREATION_FAST,
  TOKEN_CATEGORY_CACHE_CREATION_LONG_CONTEXT_FAST,
] as const;

// Usage kinds whose quantities are model tokens: the base "model" kind plus
// managed tasks that bill a backing model's tokens under a task-scoped kind.
// Translation has no live producer, but historical usage must remain readable
// and priceable.
export const MODEL_TOKEN_USAGE_KINDS = [
  "model",
  "image-recognition",
  "translation",
] as const;
