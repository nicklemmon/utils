import { z } from "zod";

export const NonEmptyStringSchema: z.ZodType<string> = z.string().min(1);

export function parseNonEmptyString(value: unknown): string {
  return NonEmptyStringSchema.parse(value);
}
