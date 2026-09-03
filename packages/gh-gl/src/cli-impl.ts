#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { z } from "zod";

import { validateTokens } from "./env.js";
import { exitCodeForOutcome, formatOutcome } from "./output.js";
import { sync } from "./sync.js";

const SyncFlagsSchema = z.object({
  githubUrl: z.string().min(1, "--github-url must be a git remote URL"),
  gitlabUrl: z.string().min(1, "--gitlab-url must be a git remote URL"),
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
 * Print `message` and set `gh-gl`'s real-error exit code (`2`).
 *
 * This sets `process.exitCode` instead of calling `process.exit()` directly: `console.error`'s
 * write to a piped stderr is asynchronous on POSIX, so exiting immediately after it can truncate
 * the message before it reaches the pipe. Setting `process.exitCode` lets the process exit
 * naturally once the write (and everything else pending) has flushed.
 *
 * @param message - The error to report.
 * @param json - Emit `message` as a JSON object instead of plain text.
 */
function fail(message: string, json: boolean): void {
  console.error(json ? JSON.stringify({ kind: "error", message }) : message);
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
  const githubToken = process.env["GITHUB_TOKEN"];
  const gitlabToken = process.env["GITLAB_TOKEN"];
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

program
  .name("gh-gl")
  .description("Sync a GitHub repo's default branch into a downstream GitLab repo")
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
    fail(errorMessage(error), false);
  }
}
