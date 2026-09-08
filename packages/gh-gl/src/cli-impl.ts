#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { z } from "zod";

import { readSyncTokens, validateTokens } from "./env.js";
import { exitCodeForOutcome, formatOutcome } from "./output.js";
import { isFullGitRemoteUrl } from "./remote-url.js";
import { sync } from "./sync.js";

const SyncFlagsSchema = z.object({
  githubUrl: z
    .string()
    .min(1, "--github-url must be a git remote URL")
    .refine(
      isFullGitRemoteUrl,
      "--github-url must be a full git remote URL, not owner/repo shorthand",
    ),
  gitlabUrl: z
    .string()
    .min(1, "--gitlab-url must be a git remote URL")
    .refine(
      isFullGitRemoteUrl,
      "--gitlab-url must be a full git remote URL, not owner/repo shorthand",
    ),
  overlay: z.string().min(1, "--overlay must be a directory path"),
  branch: z.string().min(1).optional(),
  dryRun: z.boolean(),
  json: z.boolean(),
});

const ErrorWithMessageSchema = z.object({ message: z.string() });

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- I/O boundary parser for a caught exception of unknown shape.
function errorMessage(error: unknown): string {
  const parsed = ErrorWithMessageSchema.safeParse(error);

  return parsed.success ? parsed.data.message : "Unknown error";
}

/**
 * Print `message` and set exit code `2` (real error).
 *
 * JSON errors go to stdout so JSON mode always uses one stream. Text errors go to stderr. Sets
 * `process.exitCode` instead of calling `process.exit()` so a piped `console` write can finish
 * before the process exits.
 *
 * @param message - Error text to report to the user.
 * @param json - When true, emit one JSON object on stdout instead of plain text on stderr.
 */
function fail(message: string, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ kind: "error", message }));
  } else {
    console.error(message);
  }

  process.exitCode = 2;
}

function formatZodIssues(issues: ReadonlyArray<Readonly<{ message: string }>>): string {
  const messages: Array<string> = [];

  for (const issue of issues) {
    messages.push(issue.message);
  }

  return messages.join("\n");
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- commander's action handler hands back its options object untyped; parsed via SyncFlagsSchema immediately below.
async function runSyncCommand(rawFlags: unknown): Promise<void> {
  const parsed = SyncFlagsSchema.safeParse(rawFlags);

  if (!parsed.success) {
    fail(formatZodIssues(parsed.error.issues), false);

    return;
  }

  const flags = parsed.data;
  const { githubToken, gitlabToken } = readSyncTokens();
  const tokenErrors = validateTokens({
    githubUrl: flags.githubUrl,
    gitlabUrl: flags.gitlabUrl,
    githubToken,
    gitlabToken,
  });

  if (tokenErrors.length > 0) {
    fail(tokenErrors.join("\n"), flags.json);

    return;
  }

  try {
    const outcome = await sync({
      githubUrl: flags.githubUrl,
      gitlabUrl: flags.gitlabUrl,
      overlayDir: flags.overlay,
      branch: flags.branch,
      dryRun: flags.dryRun,
      githubToken,
      gitlabToken,
    });

    console.log(formatOutcome(outcome, { json: flags.json }));
    process.exitCode = exitCodeForOutcome(outcome);
  } catch (error) {
    fail(errorMessage(error), flags.json);
  }
}

const program = new Command();
const jsonRequested = process.argv.slice(2).includes("--json");

program
  .name("gh-gl")
  .description("Sync a GitHub repo's default branch into a downstream GitLab repo")
  .configureOutput({
    writeErr: jsonRequested
      ? (): void => {
          // The catch block emits Commander's error as the single JSON result.
        }
      : (text): void => {
          process.stderr.write(text);
        },
  })
  .exitOverride();

program
  .command("sync")
  .requiredOption("--github-url <url>", "Full git remote URL for the source repo")
  .requiredOption("--gitlab-url <url>", "Full git remote URL for the target repo")
  .requiredOption("--overlay <path>", "Local directory to layer on top of GitHub's tree")
  .option("--branch <name>", "Target branch (defaults to GitLab's default branch)")
  .option("--dry-run", "Run the full logic, skip the final commit/push", false)
  .option("--json", "Emit one JSON object to stdout instead of human-readable text", false)
  .action(runSyncCommand);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  // `process.exitCode` (not `process.exit()`) in every branch here — see `fail`'s doc
  // comment on why.
  if (
    error instanceof CommanderError &&
    (error.code === "commander.helpDisplayed" || error.code === "commander.version")
  ) {
    process.exitCode = error.exitCode;
  } else if (error instanceof CommanderError && error.code === "commander.help") {
    // `commander.help`: no subcommand was given, so commander printed usage
    // itself. That's a real usage error per gh-gl's own exit-code contract
    // (tier 2), not commander's own default of 1 (reserved here for merge
    // conflicts specifically) — the help text is already on stdout/stderr, so
    // there's nothing more to print.
    process.exitCode = 2;
  } else {
    fail(errorMessage(error), jsonRequested);
  }
}
