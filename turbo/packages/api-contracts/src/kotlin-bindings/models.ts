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
  return guarded(
    properties.map((fields, index) => {
      const key = Object.keys(fields).find((field) => {
        return (
          required[index]!.has(field) &&
          properties.every((other, otherIndex) => {
            return otherIndex === index || !(field in other);
          })
        );
      });
      if (key === undefined)
        throw new Error(`${name}: unsupported ambiguous object union`);
      return `value.containsKey(${kotlinQuote(key)})`;
    }),
  );
}

/** Emits supported selected shapes; opaque JSON is limited to canonical unknown leaves. */
export function renderKotlinModels(
  bindings: readonly KotlinTypeBinding[],
  packageName = defaultKotlinPackage,
): string {
  const declarations: string[] = [];
  const names = new Set<string>();
  let hasEmptyArray = false;
  let hasZero = false;
  let hasOptionalJson = false;
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
    const fields = Object.entries(value.properties).flatMap(
      ([field, schema]) => {
        if (isNever(schema)) {
          if (!parent || required.has(field))
            throw new Error(`${name}: unguarded never field`);
          return [];
        }
        const wireType = render(schema, `${name}${suffix(field)}`);
        const optional = !required.has(field);
        const opaque = optional && schemaObject(schema) && isJsonValue(schema);
        if (opaque) optionalJson();
        const propertyType = opaque
          ? "CanonicalOptionalJson"
          : optional && !wireType.endsWith("?")
            ? `${wireType}?`
            : wireType;
        const defaultValue = opaque
          ? " = CanonicalOptionalJson.Absent"
          : optional
            ? " = null"
            : "";
        return [
          `    val ${kotlinIdentifier(field)}: ${propertyType}${defaultValue},`,
        ];
      },
    );
    if (fields.length === 0)
      throw new Error(
        `${name}: empty objects need an explicit wire representation`,
      );
    declarations.push(
      `@Serializable\ndata class ${name}(\n${fields.join("\n")}\n)${parent ? ` : ${parent}` : ""}`,
    );
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
        if (value.prefixItems) throw new Error(`${name}: unsupported tuple`);
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

  const render = (value: unknown, name: string, parent?: string): string => {
    if (!schemaObject(value))
      throw new Error(`${name}: expected a JSON schema`);
    if (value.$ref || value.allOf || (value.anyOf && value.oneOf))
      throw new Error(`${name}: unsupported schema composition`);
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
      if (
        ["number", "integer"].includes(String(value.type)) &&
        value.const === 0
      )
        return literalZero();
      throw new Error(`${name}: unsupported literal`);
    }
    const union = value.anyOf ?? value.oneOf;
    if (Array.isArray(union)) {
      const variants = union;
      if (variants.length < 2 || !variants.every(schemaObject))
        throw new Error(`${name}: unsupported union`);
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
      declarations.push(
        `@Serializable(with = ${name}Serializer::class)\nsealed interface ${name}`,
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
    return renderValue(value, name, parent);
  };
  for (const binding of bindings) {
    const name = kotlinTypeName(binding.name);
    const result = render(
      toJSONSchema(binding.schema, { io: binding.direction }),
      name,
    );
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
