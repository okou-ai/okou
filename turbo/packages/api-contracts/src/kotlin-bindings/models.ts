import { toJSONSchema } from "zod";
import type { KotlinTypeBinding } from "./bindings";
import { isJsonValue, isNever, scalarPredicate } from "./schema-shapes";
import {
  defaultKotlinPackage,
  kotlinHeader,
  kotlinIdentifier,
  kotlinQuote,
  kotlinTypeName,
  schemaObject,
} from "./syntax";

type JsonObject = Readonly<Record<string, unknown>>;
function suffix(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1);
}

function nullableSchema(
  value: JsonObject,
  name: string,
): JsonObject | undefined {
  if (Array.isArray(value.type)) {
    const nonNull = value.type.filter((item) => {
      return item !== "null";
    });
    if (value.type.length === 2 && nonNull.length === 1)
      return { ...value, type: nonNull[0] };
    throw new Error(`${name}: unsupported type union`);
  }
  if (Array.isArray(value.anyOf)) {
    const nonNull = value.anyOf.filter((item) => {
      return !schemaObject(item) || item.type !== "null";
    });
    if (nonNull.length !== value.anyOf.length && nonNull.length > 0) {
      if (nonNull.length === 1 && schemaObject(nonNull[0])) return nonNull[0];
      return { anyOf: nonNull };
    }
  }
  return undefined;
}

function isUnrestrictedStringUnion(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  // A URI or a hostless reference still has one wire representation.
  return (
    value.every((branch) => {
      return schemaObject(branch) && branch.type === "string";
    }) &&
    value.some((branch) => {
      return schemaObject(branch) && Object.keys(branch).length === 1;
    })
  );
}

function stringValues(value: unknown): string[] | undefined {
  if (!schemaObject(value)) return undefined;
  if (Array.isArray(value.anyOf)) {
    const variants = value.anyOf.map(stringValues);
    if (
      variants.length > 0 &&
      variants.every((item) => {
        return item !== undefined;
      })
    )
      return [
        ...new Set(
          variants.flatMap((item) => {
            return item;
          }),
        ),
      ];
    return undefined;
  }
  if (value.type !== "string") return undefined;
  const values: unknown =
    value.enum ?? (typeof value.const === "string" ? [value.const] : undefined);
  if (values === undefined) return undefined;
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    !values.every((item): item is string => {
      return typeof item === "string";
    })
  )
    throw new Error("Unsupported string enum");
  return values;
}

function renderStringEnum(values: readonly string[], name: string): string {
  const symbols = values.map((value) => {
    const entry = value.replaceAll(/[^A-Za-z0-9]+/gu, "_").toUpperCase();
    const symbol = /^[0-9]/u.test(entry) ? `VALUE_${entry}` : entry;
    if (!symbol || !/^[A-Z_][A-Z0-9_]*$/u.test(symbol))
      throw new Error(`${name}: invalid enum name`);
    return symbol;
  });
  if (new Set(symbols).size !== symbols.length)
    throw new Error(`${name}: enum name collision`);
  return `@Serializable\nenum class ${name} {\n${values
    .map((value, index) => {
      return `    @SerialName(${kotlinQuote(value)})\n    ${symbols[index]},`;
    })
    .join("\n")}\n}`;
}

/** A union must have one provable wire selector per object; no try-each decoding. */
function unionSelectors(
  variants: readonly JsonObject[],
  name: string,
): string[] {
  const properties = variants.map((variant) => {
    if (variant.type !== "object" || !schemaObject(variant.properties))
      throw new Error(`${name}: unsupported object union`);
    return variant.properties;
  });
  const required = variants.map((variant) => {
    return new Set(Array.isArray(variant.required) ? variant.required : []);
  });
  function requiredTags(
    fields: JsonObject,
    requiredFields: ReadonlySet<unknown>,
    path: readonly string[] = [],
  ): { path: readonly string[]; values: readonly string[] }[] {
    return Object.entries(fields).flatMap(([field, schema]) => {
      if (!requiredFields.has(field)) return [];
      const next = [...path, field];
      const tags = stringValues(schema);
      if (tags) return [{ path: next, values: tags }];
      if (!schemaObject(schema)) return [];
      const alternatives = schema.anyOf ?? schema.oneOf ?? [schema];
      if (!Array.isArray(alternatives)) return [];
      const byVariant = alternatives.map((variant) => {
        if (
          !schemaObject(variant) ||
          variant.type !== "object" ||
          !schemaObject(variant.properties) ||
          !Array.isArray(variant.required)
        )
          return [];
        return requiredTags(
          variant.properties,
          new Set(variant.required),
          next,
        );
      });
      return (byVariant[0] ?? []).flatMap((tag) => {
        const matches = byVariant.map((candidates) => {
          return candidates.find((candidate) => {
            return (
              candidate.path.length === tag.path.length &&
              candidate.path.every((key, part) => {
                return key === tag.path[part];
              })
            );
          });
        });
        if (
          !matches.every((match) => {
            return match !== undefined;
          })
        )
          return [];
        return [
          {
            path: tag.path,
            values: [
              ...new Set(
                matches.flatMap((match) => {
                  return match.values;
                }),
              ),
            ],
          },
        ];
      });
    });
  }
  const guarded = (selectors: string[], constrainScalars = false) => {
    return selectors.map((selector, index) => {
      const guards = Object.entries(properties[index]!).flatMap(
        ([field, schema]) => {
          const access = `value[${kotlinQuote(field)}]`;
          if (isNever(schema)) {
            if (required[index]!.has(field))
              throw new Error(`${name}: required never field`);
            return [`!value.containsKey(${kotlinQuote(field)})`];
          }
          if (
            constrainScalars &&
            schemaObject(schema) &&
            (schema.const !== undefined ||
              schema.minimum !== undefined ||
              schema.exclusiveMinimum !== undefined ||
              schema.maximum !== undefined ||
              schema.exclusiveMaximum !== undefined)
          ) {
            const check = `${access}.let { field -> ${scalarPredicate(schema, "field")} }`;
            return [
              required[index]!.has(field)
                ? check
                : `(!value.containsKey(${kotlinQuote(field)}) || ${check})`,
            ];
          }
          return [];
        },
      );
      return guards.length === 0
        ? selector
        : [selector, ...guards]
            .map((part) => {
              return `(${part})`;
            })
            .join(" && ");
    });
  };
  for (const field of Object.keys(properties[0]!)) {
    const tags = properties.map((fields, index) => {
      return required[index]!.has(field)
        ? stringValues(fields[field])
        : undefined;
    });
    if (
      tags.every((values) => {
        return values !== undefined;
      })
    ) {
      const all = tags.flatMap((values) => {
        return values;
      });
      if (new Set(all).size === all.length) {
        return guarded(
          tags.map((values) => {
            return `(value[${kotlinQuote(field)}] as? JsonPrimitive)?.let { it.isString && it.content in setOf(${values.map(kotlinQuote).join(", ")}) } == true`;
          }),
        );
      }
    }
  }
  for (const field of Object.keys(properties[0]!)) {
    const schemas = properties.map((fields, index) => {
      return required[index]!.has(field) ? fields[field] : undefined;
    });
    if (
      schemas.length === 2 &&
      schemas.every(schemaObject) &&
      schemas.some((schema) => {
        return schema.type === "null";
      }) &&
      schemas.some((schema) => {
        return ["string", "number", "integer", "boolean"].includes(
          String(schema.type),
        );
      })
    ) {
      return guarded(
        schemas.map((schema) => {
          return `value[${kotlinQuote(field)}].let { field -> ${scalarPredicate(schema, "field")} }`;
        }),
        true,
      );
    }
    const forbidden = properties.map((fields) => {
      return isNever(fields[field]);
    });
    if (
      forbidden.filter(Boolean).length === 1 &&
      schemas.length === 2 &&
      schemas.some((schema, index) => {
        return !forbidden[index] && schemaObject(schema);
      })
    ) {
      return guarded(
        forbidden.map((absent) => {
          return absent
            ? `!value.containsKey(${kotlinQuote(field)})`
            : `value.containsKey(${kotlinQuote(field)})`;
        }),
        true,
      );
    }
  }
  // Some contracts need multiple tags or required/forbidden fields jointly.
  // Prove every pair disjoint before relying on these selectors.
  if (
    properties.every((fields, index) => {
      return properties.every((other, otherIndex) => {
        return (
          index === otherIndex ||
          Object.keys(fields).some((field) => {
            if (!required[index]!.has(field)) return false;
            if (isNever(other[field])) return true;
            const values = stringValues(fields[field]);
            const otherValues = required[otherIndex]!.has(field)
              ? stringValues(other[field])
              : undefined;
            return (
              values !== undefined &&
              otherValues !== undefined &&
              values.every((value) => {
                return !otherValues.includes(value);
              })
            );
          }) ||
          Object.keys(other).some((field) => {
            return required[otherIndex]!.has(field) && isNever(fields[field]);
          })
        );
      });
    })
  )
    return guarded(
      properties.map((fields, index) => {
        return (
          Object.keys(fields)
            .filter((field) => {
              return required[index]!.has(field);
            })
            .map((field) => {
              const values = stringValues(fields[field]);
              if (values !== undefined)
                return `(value[${kotlinQuote(field)}] as? JsonPrimitive)?.let { it.isString && it.content in setOf(${values.map(kotlinQuote).join(", ")}) } == true`;
              return `value.containsKey(${kotlinQuote(field)})`;
            })
            .join(" && ") || "true"
        );
      }),
      true,
    );
  const uniqueKeys = properties.map((fields, index) => {
    return Object.keys(fields).find((field) => {
      return (
        required[index]!.has(field) &&
        properties.every((other, otherIndex) => {
          return otherIndex === index || !(field in other);
        })
      );
    });
  });
  if (
    uniqueKeys.every((key) => {
      return key !== undefined;
    })
  ) {
    return guarded(
      uniqueKeys.map((key) => {
        return `value.containsKey(${kotlinQuote(key)})`;
      }),
    );
  }
  // Some request branches carry the tag inside a required event configuration.
  const nestedTags = properties.map((fields, index) => {
    return requiredTags(fields, required[index]!);
  });
  const complementary = properties.map((fields, index) => {
    const tags = nestedTags[index]!;
    if (
      !properties.every((other, otherIndex) => {
        return (
          index === otherIndex ||
          Object.keys(fields).some((field) => {
            return required[index]!.has(field) && !(field in other);
          }) ||
          Object.keys(other).some((field) => {
            return required[otherIndex]!.has(field) && !(field in fields);
          }) ||
          tags.some((tag) => {
            return nestedTags[otherIndex]!.some((otherTag) => {
              return (
                tag.path.length === otherTag.path.length &&
                tag.path.every((field, part) => {
                  return field === otherTag.path[part];
                }) &&
                tag.values.every((value) => {
                  return !otherTag.values.includes(value);
                })
              );
            });
          })
        );
      })
    )
      return undefined;
    const keys = Object.keys(fields).filter((field) => {
      return required[index]!.has(field);
    });
    return [
      ...keys.map((field) => {
        return `value.containsKey(${kotlinQuote(field)})`;
      }),
      ...tags.map((tag) => {
        const [first, ...rest] = tag.path;
        const access = rest.reduce(
          (current, field) => {
            return `(${current} as? JsonObject)?.get(${kotlinQuote(field)})`;
          },
          `value[${kotlinQuote(first!)}]`,
        );
        return `(${access} as? JsonPrimitive)?.let { it.isString && it.content in setOf(${tag.values.map(kotlinQuote).join(", ")}) } == true`;
      }),
    ].join(" && ");
  });
  if (
    complementary.every((selector): selector is string => {
      return !!selector;
    })
  )
    return guarded(complementary);
  throw new Error(`${name}: unsupported ambiguous object union`);
}

function objectUnionVariants(variants: readonly unknown[]): JsonObject[] {
  return variants.flatMap((variant) => {
    if (!schemaObject(variant)) throw new Error("Unsupported union variant");
    const nested = variant.anyOf ?? variant.oneOf;
    if (nested === undefined) return [variant];
    if (
      !Array.isArray(nested) ||
      nested.length < 2 ||
      Object.keys(variant).some((key) => {
        return !["anyOf", "oneOf", "description", "title"].includes(key);
      }) ||
      (variant.anyOf !== undefined && variant.oneOf !== undefined)
    )
      throw new Error("Unsupported nested union composition");
    return objectUnionVariants(nested);
  });
}

/** Emits selected typed shapes and explicitly raw transport/cache envelopes. */
export function renderKotlinModels(
  bindings: readonly KotlinTypeBinding[],
  packageName = defaultKotlinPackage,
  requestTypes: ReadonlySet<string> = new Set(),
): string {
  const declarations: string[] = [];
  const rawObjects = new Set<object>(
    bindings
      .filter((binding) => {
        return binding.representation === "raw-object";
      })
      .map((binding) => {
        return binding.schema;
      }),
  );
  const names = new Set<string>();
  let hasEmptyArray = false;
  let hasZero = false;
  let hasOptionalJson = false;
  let hasOptionalInput = false;
  let requestBinding = false;
  let currentBinding: KotlinTypeBinding | undefined;
  const reusableOutputs = new Map<object, string>();
  let preserveOptionalNullable: readonly string[] = [];
  const integerLiterals = new Set<number>();
  const booleanLiterals = new Set<boolean>();
  const imports = new Set([
    "kotlinx.serialization.SerialName",
    "kotlinx.serialization.Serializable",
  ]);
  const reserve = (name: string) => {
    kotlinTypeName(name);
    if (names.has(name))
      throw new Error(`Duplicate Kotlin declaration: ${name}`);
    names.add(name);
  };
  const serializerImports = () => {
    for (const item of [
      "KSerializer",
      "SerializationException",
      "descriptors.buildClassSerialDescriptor",
      "encoding.Decoder",
      "encoding.Encoder",
      "json.JsonDecoder",
      "json.JsonEncoder",
      "json.JsonObject",
      "json.JsonPrimitive",
    ])
      imports.add(`kotlinx.serialization.${item}`);
  };
  const literalZero = () => {
    if (hasZero) return "CanonicalZero";
    reserve("CanonicalZero");
    reserve("CanonicalZeroSerializer");
    hasZero = true;
    serializerImports();
    imports.add("kotlinx.serialization.json.doubleOrNull");
    declarations.push(`@Serializable(with = CanonicalZeroSerializer::class)
data object CanonicalZero

object CanonicalZeroSerializer : KSerializer<CanonicalZero> {
    override val descriptor = JsonPrimitive.serializer().descriptor
    override fun deserialize(decoder: Decoder): CanonicalZero {
        val input = decoder as? JsonDecoder ?: throw SerializationException("Expected JSON zero")
        val value = input.decodeJsonElement()
        if (value !is JsonPrimitive || value.isString || value.doubleOrNull != 0.0) throw SerializationException("Expected zero")
        return CanonicalZero
    }
    override fun serialize(encoder: Encoder, value: CanonicalZero) {
        val output = encoder as? JsonEncoder ?: throw SerializationException("Expected JSON zero")
        output.encodeJsonElement(JsonPrimitive(0))
    }
}`);
    return "CanonicalZero";
  };
  const optionalJson = () => {
    if (hasOptionalJson) return;
    reserve("CanonicalOptionalJson");
    reserve("CanonicalOptionalJsonSerializer");
    hasOptionalJson = true;
    serializerImports();
    declarations.push(`@Serializable(with = CanonicalOptionalJsonSerializer::class)
sealed interface CanonicalOptionalJson {
    data object Absent : CanonicalOptionalJson
    data class Present(val value: JsonElement) : CanonicalOptionalJson
}

object CanonicalOptionalJsonSerializer : KSerializer<CanonicalOptionalJson> {
    // A non-nullable property lets explicit JSON null reach this serializer.
    override val descriptor = JsonElement.serializer().descriptor
    override fun deserialize(decoder: Decoder): CanonicalOptionalJson {
        val input = decoder as? JsonDecoder ?: throw SerializationException("Expected JSON value")
        return CanonicalOptionalJson.Present(input.decodeJsonElement())
    }
    override fun serialize(encoder: Encoder, value: CanonicalOptionalJson) {
        val output = encoder as? JsonEncoder ?: throw SerializationException("Expected JSON value")
        if (value !is CanonicalOptionalJson.Present) throw SerializationException("Absent JSON field must be omitted")
        output.encodeJsonElement(value.value)
    }
}`);
  };
  const literalInteger = (value: number) => {
    if (value === 0) return literalZero();
    const name = `CanonicalInteger${value < 0 ? "Minus" : ""}${Math.abs(value)}`;
    if (integerLiterals.has(value)) return name;
    reserve(name);
    reserve(`${name}Serializer`);
    integerLiterals.add(value);
    serializerImports();
    imports.add("kotlinx.serialization.json.doubleOrNull");
    declarations.push(`@Serializable(with = ${name}Serializer::class)
data object ${name}

object ${name}Serializer : KSerializer<${name}> {
    override val descriptor = JsonPrimitive.serializer().descriptor
    override fun deserialize(decoder: Decoder): ${name} {
        val input = decoder as? JsonDecoder ?: throw SerializationException("Expected JSON integer literal")
        val value = input.decodeJsonElement()
        if (value !is JsonPrimitive || value.isString || value.doubleOrNull != ${value}.0) throw SerializationException("Unexpected integer literal")
        return ${name}
    }
    override fun serialize(encoder: Encoder, value: ${name}) {
        val output = encoder as? JsonEncoder ?: throw SerializationException("Expected JSON integer literal")
        output.encodeJsonElement(JsonPrimitive(${value}L))
    }
}`);
    return name;
  };
  const literalBoolean = (value: boolean) => {
    const name = value ? "CanonicalTrue" : "CanonicalFalse";
    if (booleanLiterals.has(value)) return name;
    reserve(name);
    reserve(`${name}Serializer`);
    booleanLiterals.add(value);
    serializerImports();
    declarations.push(`@Serializable(with = ${name}Serializer::class)
data object ${name}

object ${name}Serializer : KSerializer<${name}> {
    override val descriptor = JsonPrimitive.serializer().descriptor
    override fun deserialize(decoder: Decoder): ${name} {
        val input = decoder as? JsonDecoder ?: throw SerializationException("Expected JSON boolean literal")
        if (input.decodeJsonElement() != JsonPrimitive(${value})) throw SerializationException("Unexpected boolean literal")
        return ${name}
    }
    override fun serialize(encoder: Encoder, value: ${name}) {
        val output = encoder as? JsonEncoder ?: throw SerializationException("Expected JSON boolean literal")
        output.encodeJsonElement(JsonPrimitive(${value}))
    }
}`);
    return name;
  };
  const optionalInput = () => {
    if (hasOptionalInput) return;
    reserve("CanonicalOptional");
    reserve("CanonicalOptionalSerializer");
    hasOptionalInput = true;
    serializerImports();
    declarations.push(`@Serializable(with = CanonicalOptionalSerializer::class)
sealed interface CanonicalOptional<out T> {
    data object Absent : CanonicalOptional<Nothing>
    data class Present<T>(val value: T) : CanonicalOptional<T>
}

class CanonicalOptionalSerializer<T>(private val serializer: KSerializer<T>) : KSerializer<CanonicalOptional<T>> {
    override val descriptor = buildClassSerialDescriptor("CanonicalOptional", serializer.descriptor)
    override fun deserialize(decoder: Decoder): CanonicalOptional<T> =
        CanonicalOptional.Present(decoder.decodeSerializableValue(serializer))
    override fun serialize(encoder: Encoder, value: CanonicalOptional<T>) {
        when (value) {
            CanonicalOptional.Absent -> throw SerializationException("Absent field must be omitted")
            is CanonicalOptional.Present -> encoder.encodeSerializableValue(serializer, value.value)
        }
    }
}`);
  };
  const emptyArray = () => {
    if (hasEmptyArray) return "CanonicalEmptyArray";
    reserve("CanonicalEmptyArray");
    reserve("CanonicalEmptyArraySerializer");
    hasEmptyArray = true;
    serializerImports();
    imports.add("kotlinx.serialization.json.JsonArray");
    imports.add("kotlinx.serialization.builtins.ListSerializer");
    imports.add("kotlinx.serialization.builtins.serializer");
    declarations.push(`@Serializable(with = CanonicalEmptyArraySerializer::class)
data object CanonicalEmptyArray

object CanonicalEmptyArraySerializer : KSerializer<CanonicalEmptyArray> {
    override val descriptor = ListSerializer(String.serializer()).descriptor
    override fun deserialize(decoder: Decoder): CanonicalEmptyArray {
        val input = decoder as? JsonDecoder ?: throw SerializationException("Expected JSON empty array")
        val value = input.decodeJsonElement() as? JsonArray
        if (value == null || value.isNotEmpty()) throw SerializationException("Expected empty array")
        return CanonicalEmptyArray
    }
    override fun serialize(encoder: Encoder, value: CanonicalEmptyArray) {
        val output = encoder as? JsonEncoder ?: throw SerializationException("Expected JSON empty array")
        output.encodeJsonElement(JsonArray(emptyList()))
    }
}`);
    return "CanonicalEmptyArray";
  };
  function renderObject(
    value: JsonObject,
    name: string,
    parent?: string,
  ): string {
    if (
      (!value.properties ||
        (schemaObject(value.properties) &&
          Object.keys(value.properties).length === 0)) &&
      schemaObject(value.additionalProperties)
    ) {
      if (
        value.propertyNames !== undefined &&
        (!schemaObject(value.propertyNames) ||
          value.propertyNames.type !== "string")
      )
        throw new Error(`${name}: unsupported dictionary keys`);
      return `Map<String, ${render(value.additionalProperties, `${name}Value`)}>`;
    }
    if (
      !schemaObject(value.properties) ||
      (value.additionalProperties !== undefined &&
        value.additionalProperties !== false)
    )
      throw new Error(`${name}: unsupported object/dictionary`);
    reserve(name);
    const required = new Set(
      Array.isArray(value.required) ? value.required : [],
    );
    const overrides =
      parent === currentBinding?.name ? currentBinding?.unionFields : undefined;
    const fields = Object.entries(value.properties).flatMap(
      ([field, schema]) => {
        if (isNever(schema)) {
          if (!parent || required.has(field))
            throw new Error(`${name}: unguarded never field`);
          return [];
        }
        const wireType = render(schema, `${name}${suffix(field)}`);
        const optional = !required.has(field);
        const declaration = `    ${overrides?.includes(field) ? "override " : ""}val ${kotlinIdentifier(field)}`;
        if (optional && schemaObject(schema) && isJsonValue(schema)) {
          optionalJson();
          return [
            `${declaration}: CanonicalOptionalJson = CanonicalOptionalJson.Absent,`,
          ];
        }
        if (
          optional &&
          (requestBinding || preserveOptionalNullable.includes(field)) &&
          schemaObject(schema) &&
          nullableSchema(schema, `${name}${suffix(field)}`) !== undefined
        ) {
          optionalInput();
          return [
            `${declaration}: CanonicalOptional<${wireType}> = CanonicalOptional.Absent,`,
          ];
        }
        const propertyType =
          optional && !wireType.endsWith("?") ? `${wireType}?` : wireType;
        const defaultValue = optional ? " = null" : "";
        return [`${declaration}: ${propertyType}${defaultValue},`];
      },
    );
    if (fields.length === 0) {
      declarations.push(
        `@Serializable\ndata object ${name}${parent ? ` : ${parent}` : ""}`,
      );
      return name;
    }
    declarations.push(
      `@Serializable\ndata class ${name}(\n${fields.join("\n")}\n)${parent ? ` : ${parent}` : ""}`,
    );
    return name;
  }

  function renderTuple(value: JsonObject, name: string): string {
    const items = value.prefixItems;
    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      value.minItems !== items.length ||
      value.maxItems !== items.length ||
      (value.items !== undefined && value.items !== false)
    )
      throw new Error(`${name}: unsupported tuple`);
    reserve(name);
    reserve(`${name}Serializer`);
    const types = items.map((item, index) => {
      return render(item, `${name}Item${index + 1}`);
    });
    serializerImports();
    imports.add("kotlinx.serialization.json.JsonArray");
    imports.add("kotlinx.serialization.json.JsonElement");
    imports.add("kotlinx.serialization.json.decodeFromJsonElement");
    imports.add("kotlinx.serialization.json.encodeToJsonElement");
    imports.add("kotlinx.serialization.builtins.ListSerializer");
    declarations.push(`@Serializable(with = ${name}Serializer::class)
data class ${name}(\n${types
      .map((type, index) => {
        return `    val item${index + 1}: ${type},`;
      })
      .join("\n")}\n)

object ${name}Serializer : KSerializer<${name}> {
    override val descriptor = ListSerializer(JsonElement.serializer()).descriptor
    override fun deserialize(decoder: Decoder): ${name} {
        val input = decoder as? JsonDecoder ?: throw SerializationException("Expected JSON tuple")
        val values = input.decodeJsonElement() as? JsonArray ?: throw SerializationException("Expected JSON tuple")
        if (values.size != ${items.length}) throw SerializationException("Unexpected tuple length")
        return ${name}(\n${types
          .map((type, index) => {
            return `            input.json.decodeFromJsonElement<${type}>(values[${index}]),`;
          })
          .join("\n")}\n        )
    }
    override fun serialize(encoder: Encoder, value: ${name}) {
        val output = encoder as? JsonEncoder ?: throw SerializationException("Expected JSON tuple")
        output.encodeJsonElement(JsonArray(listOf(\n${types
          .map((_, index) => {
            return `            output.json.encodeToJsonElement(value.item${index + 1}),`;
          })
          .join("\n")}\n        )))
    }
}`);
    return name;
  }

  function renderValue(
    value: JsonObject,
    name: string,
    parent?: string,
  ): string {
    switch (value.type) {
      case "string":
        return "String";
      case "boolean":
        return "Boolean";
      case "integer":
        return "Long";
      case "number":
        return "Double";
      case "null":
        imports.add("kotlinx.serialization.json.JsonNull");
        return "JsonNull";
      case "array": {
        if (
          value.maxItems === 0 &&
          (value.minItems === undefined || value.minItems === 0)
        )
          return emptyArray();
        if (value.prefixItems) return renderTuple(value, name);
        return `List<${render(value.items, `${name}Item`)}>`;
      }
      case "object":
        return renderObject(value, name, parent);
      default:
        throw new Error(
          `${name}: unsupported schema type ${String(value.type)}`,
        );
    }
  }

  function renderScalarUnion(
    union: readonly unknown[],
    name: string,
  ): string | undefined {
    const scalarKinds = new Set(["string", "integer", "boolean"]);
    const schemas = union.filter(schemaObject);
    if (
      schemas.length >= 2 &&
      schemas.length === union.length &&
      schemas.every((variant) => {
        return scalarKinds.has(String(variant.type));
      }) &&
      new Set(
        schemas.map((variant) => {
          return variant.type;
        }),
      ).size === schemas.length
    ) {
      reserve(name);
      reserve(`${name}Serializer`);
      serializerImports();
      imports.add("kotlinx.serialization.json.doubleOrNull");
      imports.add("kotlinx.serialization.json.booleanOrNull");
      imports.add("kotlinx.serialization.json.double");
      imports.add("kotlinx.serialization.json.boolean");
      const variants = schemas.map((variant, index) => {
        const type = render(variant, `${name}Variant${index + 1}`);
        if (!["String", "Long", "Boolean"].includes(type))
          throw new Error(`${name}: unsupported scalar union variant`);
        return {
          name: `Variant${index + 1}`,
          type,
          accessor: {
            String: "content",
            Long: "double.toLong()",
            Boolean: "boolean",
          }[type],
          predicate: scalarPredicate(variant, "value"),
        };
      });
      declarations.push(`@Serializable(with = ${name}Serializer::class)
sealed interface ${name} {
${variants
  .map((variant) => {
    return `    data class ${variant.name}(val value: ${variant.type}) : ${name}`;
  })
  .join("\n")}
}

object ${name}Serializer : KSerializer<${name}> {
override val descriptor = JsonPrimitive.serializer().descriptor
override fun deserialize(decoder: Decoder): ${name} {
    val input = decoder as? JsonDecoder ?: throw SerializationException("Expected JSON scalar for ${name}")
    val value = input.decodeJsonElement()
    return when {
${variants
  .map((variant) => {
    return `            ${variant.predicate} -> ${name}.${variant.name}(value.${variant.accessor})`;
  })
  .join("\n")}
        else -> throw SerializationException("Unknown ${name} variant")
    }
}
override fun serialize(encoder: Encoder, value: ${name}) {
    val output = encoder as? JsonEncoder ?: throw SerializationException("Expected JSON scalar for ${name}")
    output.encodeJsonElement(when (value) {
${variants
  .map((variant) => {
    return `            is ${name}.${variant.name} -> JsonPrimitive(value.value)`;
  })
  .join("\n")}
    })
}
}`);
      return name;
    }
    return undefined;
  }

  function renderUnion(union: readonly unknown[], name: string): string {
    const scalar = renderScalarUnion(union, name);
    if (scalar) return scalar;
    const variants = objectUnionVariants(union);
    if (variants.length < 2) throw new Error(`${name}: unsupported union`);
    const selectors = unionSelectors(variants, name);
    if (
      selectors.some((selector) => {
        return selector.includes("doubleOrNull");
      })
    )
      imports.add("kotlinx.serialization.json.doubleOrNull");
    if (
      selectors.some((selector) => {
        return selector.includes("booleanOrNull");
      })
    )
      imports.add("kotlinx.serialization.json.booleanOrNull");
    if (
      selectors.some((selector) => {
        return selector.includes("JsonNull");
      })
    )
      imports.add("kotlinx.serialization.json.JsonNull");
    reserve(name);
    reserve(`${name}Serializer`);
    serializerImports();
    const fields =
      name === currentBinding?.name ? currentBinding.unionFields : undefined;
    const properties = fields?.map((field) => {
      const schemas = variants.map((variant) => {
        if (
          !Array.isArray(variant.required) ||
          !variant.required.includes(field) ||
          !schemaObject(variant.properties) ||
          !schemaObject(variant.properties[field])
        )
          throw new Error(`${name}: common field ${field} must be required`);
        return variant.properties[field];
      });
      if (
        schemas.some((schema) => {
          return JSON.stringify(schema) !== JSON.stringify(schemas[0]);
        })
      )
        throw new Error(`${name}: common field ${field} must have one shape`);
      const type = render(schemas[0], `${name}${suffix(field)}`);
      return `    val ${kotlinIdentifier(field)}: ${type}`;
    });
    declarations.push(
      `@Serializable(with = ${name}Serializer::class)\nsealed interface ${name}${properties?.length ? ` {\n${properties.join("\n")}\n}` : ""}`,
    );
    const types = variants.map((variant, index) => {
      return render(variant, `${name}Variant${index + 1}`, name);
    });
    declarations.push(`object ${name}Serializer : KSerializer<${name}> {
  override val descriptor = buildClassSerialDescriptor(${kotlinQuote(`${packageName}.${name}`)})
  override fun deserialize(decoder: Decoder): ${name} {
      val input = decoder as? JsonDecoder ?: throw SerializationException("Expected JSON object for ${name}")
      val value = input.decodeJsonElement() as? JsonObject ?: throw SerializationException("Expected object for ${name}")
      val matches = listOf(${selectors.join(", ")})
      if (matches.count { it } != 1) throw SerializationException("Unknown or ambiguous ${name} variant")
      return when (matches.indexOf(true)) {
${types
  .map((type, index) => {
    return `            ${index} -> input.json.decodeFromJsonElement(${type}.serializer(), value)`;
  })
  .join("\n")}
          else -> throw SerializationException("Unknown ${name} variant")
      }
  }
  override fun serialize(encoder: Encoder, value: ${name}) {
      when (value) {
${types
  .map((type) => {
    return `            is ${type} -> encoder.encodeSerializableValue(${type}.serializer(), value)`;
  })
  .join("\n")}
      }
  }
}`);
    return name;
  }

  const render = (value: unknown, name: string, parent?: string): string => {
    if (!schemaObject(value))
      throw new Error(`${name}: expected a JSON schema`);
    if (value.$ref || value.allOf || (value.anyOf && value.oneOf))
      throw new Error(`${name}: unsupported schema composition`);
    if (typeof value.$kotlinReference === "string")
      return value.$kotlinReference;
    if (isJsonValue(value)) {
      imports.add("kotlinx.serialization.json.JsonElement");
      return "JsonElement";
    }
    const nullable = nullableSchema(value, name);
    if (nullable) return `${render(nullable, name)}?`;
    const enumValues = stringValues(value);
    if (enumValues !== undefined) {
      reserve(name);
      declarations.push(renderStringEnum(enumValues, name));
      return name;
    }
    if (value.enum) throw new Error(`${name}: unsupported enum`);
    if (value.const !== undefined) {
      if (value.type === "boolean" && typeof value.const === "boolean")
        return literalBoolean(value.const);
      if (
        ["number", "integer"].includes(String(value.type)) &&
        typeof value.const === "number" &&
        Number.isSafeInteger(value.const)
      )
        return literalInteger(value.const);
      throw new Error(`${name}: unsupported literal`);
    }
    const union = value.anyOf ?? value.oneOf;
    if (isUnrestrictedStringUnion(value.anyOf)) return "String";
    if (Array.isArray(union)) return renderUnion(union, name);
    return renderValue(value, name, parent);
  };
  for (const binding of bindings) {
    currentBinding = binding;
    requestBinding = requestTypes.has(binding.name);
    preserveOptionalNullable = binding.preserveOptionalNullable ?? [];
    const name = kotlinTypeName(binding.name);
    const result = render(
      toJSONSchema(binding.readSchema ?? binding.schema, {
        io: binding.direction,
        override: ({ zodSchema, jsonSchema }) => {
          const shared =
            binding.direction === "output"
              ? reusableOutputs.get(zodSchema)
              : undefined;
          if (shared && !Object.is(zodSchema, binding.schema)) {
            for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
            Object.assign(jsonSchema, { $kotlinReference: shared });
          }
          if (rawObjects.has(zodSchema)) {
            for (const key of Object.keys(jsonSchema)) {
              delete jsonSchema[key];
            }
            Object.assign(jsonSchema, {
              type: "object",
              additionalProperties: {},
            });
          }
        },
      }),
      name,
    );
    if (binding.reusableOutput) {
      if (binding.direction !== "output" || result !== name)
        throw new Error(`${name}: expected a named reusable output`);
      reusableOutputs.set(binding.schema, name);
    }
    if (result !== name) {
      if (!result.startsWith("List<") && !result.startsWith("Map<"))
        throw new Error(
          `${name}: root must be an object, enum, array or dictionary`,
        );
      reserve(name);
      declarations.push(`typealias ${name} = ${result}`);
    }
  }
  return `${kotlinHeader(packageName)}\n${[...imports]
    .sort()
    .map((item) => {
      return `import ${item}`;
    })
    .join("\n")}\n\n${declarations.join("\n\n")}\n`;
}
