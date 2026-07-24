# Immutable TypeScript configuration

`ImmutableConfig` builds a frozen configuration object from defaults and environment variables described by a schema. It supports strings, numbers, booleans, comma-separated string or number arrays, and nested schema values in its type definition.

Environment names are uppercased and may be prefixed. Callers can retrieve dotted paths with `get`, require them with `getOrThrow`, inspect presence with `has`, run the schema-key check with `validate`, or obtain a copied plain object with `toJSON`.

Invalid numeric environment values throw during creation. `throwOnMissing` checks top-level schema keys. Despite the nested schema type, environment loading and validation only iterate the top level; the module does not recursively coerce nested objects. Its public types also use `any`, so consumers do not get compile-time path validation.

There is no dedicated test file in this repository.
