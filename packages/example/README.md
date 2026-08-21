# @nicklemmon/example

Seed package for the `utils` monorepo. It exists so build, typecheck, test, lint, format, and package validation (`attw` / publint) have a real target.

Replace or rename this package when the first real utility lands.

## API

`parseNonEmptyString(value)` — parse `value` with a Zod schema and return a non-empty string, or throw.
