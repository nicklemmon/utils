import { appendFile } from "node:fs/promises";
import { z } from "zod";

import { githubServices } from "./github.ts";
import { runChangesets } from "./machine.ts";

// oxlint-disable-next-line node/no-process-env -- Parse workflow environment variables at the CLI boundary.
const rawEnvironment = process.env;
const environment = z
  .object({
    GITHUB_REPOSITORY: z.string().min(1),
    PR_NUMBER: z.coerce.number().int().positive(),
    GH_TOKEN: z.string().min(1),
    CHANGESET_MODE: z.enum(["preview", "check", "publish"]).default("preview"),
    CHANGESET_EXPECTED_HEAD: z
      .union([z.literal(""), z.string().regex(/^[a-f\d]{40}$/u)])
      .default(""),
    GITHUB_OUTPUT: z.string().optional(),
  })
  .parse(rawEnvironment);

const result = await runChangesets(
  githubServices({
    repository: environment.GITHUB_REPOSITORY,
    number: environment.PR_NUMBER,
    token: environment.GH_TOKEN,
    expectedHead:
      environment.CHANGESET_EXPECTED_HEAD === "" ? undefined : environment.CHANGESET_EXPECTED_HEAD,
  }),
  environment.CHANGESET_MODE,
);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (environment.GITHUB_OUTPUT !== undefined) {
  await appendFile(
    environment.GITHUB_OUTPUT,
    `changed=${result.plan !== undefined && result.plan.changed}\n`,
  );
}
if (result.status === "failed" || result.status === "outdated") {
  process.exitCode = 1;
}
