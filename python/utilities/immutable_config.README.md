# Immutable Python configuration

`ImmutableConfig` is a frozen dataclass base that can populate subclass fields from environment variables and caller-supplied defaults. It coerces common string, integer, float, boolean, and list values and exposes dictionary, key lookup, and validation helpers.

Applications are expected to define their own dataclass subclass or adapt the included `AppConfig` example. Environment names are uppercased and can use a prefix.

Invalid numeric values raise `ValueError`. Boolean coercion treats only `true`, `1`, and `yes` as true. The implementation's missing/default detection is basic and has no dedicated tests here; review it against the exact dataclass field shapes used by the consuming application before relying on required-field enforcement.

It uses the Python standard library only.
