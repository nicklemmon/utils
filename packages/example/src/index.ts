import { z } from "zod";

/** Zod schema for a non-empty string. */
export const NonEmptyStringSchema: z.ZodType<string> = z.string().min(1);

/**
 * Parse `value` as a non-empty string.
 *
 * @param value - Unknown input to validate with {@link NonEmptyStringSchema}.
 * @returns The parsed non-empty string.
 * @throws If `value` is not a non-empty string.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This function is the I/O boundary parser.
export function parseNonEmptyString(value: unknown): string {
  return NonEmptyStringSchema.parse(value);
}
