import { accessSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const TSDOWN_CONFIG_FILE = "tsdown.config.ts";

const manifestSchema = z.object({
  name: z.string().min(1),
  private: z.boolean().optional(),
});

const configObjectSchema = z.object({
  attw: z.unknown().optional(),
  publint: z.unknown().optional(),
});

const attwFieldsSchema = z.object({
  profile: z.unknown().optional(),
  level: z.unknown().optional(),
  enabled: z.unknown().optional(),
});

const publintFieldsSchema = z.object({
  enabled: z.unknown().optional(),
});

const configModuleSchema = z.object({
  default: z.unknown(),
});

const errorMessageSchema = z.object({
  message: z.string(),
});

const enoentSchema = z.object({
  code: z.literal("ENOENT"),
});

/** One workspace package to check for attw and publint config. */
export type PackageConfigCheck = {
  readonly directoryName: string;
  readonly packageName: string;
  readonly isPrivate: boolean;
  readonly config: PackageConfigStatus;
};

/** How the package's tsdown config was found. */
export type PackageConfigStatus =
  | { readonly kind: "missing" }
  | { readonly kind: "load-error"; readonly detail: string }
  | { readonly kind: "exported"; readonly defaultExport: unknown };

/** Package names that were read, and the problems found. */
export type PackagingCheckReport = {
  readonly packageNames: readonly string[];
  readonly problems: readonly string[];
};

type ManifestRead =
  | { readonly ok: true; readonly name: string; readonly isPrivate: boolean }
  | { readonly ok: false; readonly detail: string };

type LoadedConfig = Exclude<PackageConfigStatus, { readonly kind: "missing" }>;

type PackageRead = {
  readonly packageName: string | undefined;
  readonly problems: readonly string[];
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Reads the message from a caught exception of unknown shape.
function errorMessage(error: unknown): string {
  const parsed = errorMessageSchema.safeParse(error);
  if (!parsed.success) return "Unknown error";
  const line = parsed.data.message.split("\n")[0];
  if (line === undefined || line.length === 0) return "Unknown error";
  return line;
}

function fileExists(filePath: string): boolean {
  try {
    accessSync(filePath);
    return true;
  } catch (error: unknown) {
    if (enoentSchema.safeParse(error).success) return false;
    throw error;
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Decodes the attw field at the I/O boundary.
function attwProblems(value: unknown, prefix: string): readonly string[] {
  if (value === undefined) {
    return [`${prefix}attw is missing. Set profile to "esm-only" and level to "error".`];
  }

  const parsed = attwFieldsSchema.safeParse(value);
  if (!parsed.success) {
    return [`${prefix}attw must be an object with profile "esm-only" and level "error".`];
  }

  const problems: string[] = [];
  if (parsed.data.profile !== "esm-only") {
    problems.push(`${prefix}attw.profile must be "esm-only".`);
  }
  if (parsed.data.level !== "error") {
    problems.push(`${prefix}attw.level must be "error".`);
  }
  if (parsed.data.enabled !== undefined && parsed.data.enabled !== true) {
    problems.push(`${prefix}attw.enabled must be true.`);
  }
  return problems;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Decodes the publint field at the I/O boundary.
function publintProblems(value: unknown, prefix: string): readonly string[] {
  if (value === undefined) {
    return [`${prefix}publint is missing. Set it to true.`];
  }
  if (value === true) return [];

  const parsed = publintFieldsSchema.safeParse(value);
  if (!parsed.success) {
    return [`${prefix}publint must be true, or an options object that stays enabled.`];
  }
  if (parsed.data.enabled !== undefined && parsed.data.enabled !== true) {
    return [`${prefix}publint.enabled must be true.`];
  }
  return [];
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Decodes one tsdown config object at the I/O boundary.
function problemsForOneConfig(value: unknown, prefix: string): readonly string[] {
  const parsed = configObjectSchema.safeParse(value);
  if (!parsed.success) {
    return [`${prefix}tsdown config must be an object with attw and publint.`];
  }
  return [
    ...attwProblems(parsed.data.attw, prefix),
    ...publintProblems(parsed.data.publint, prefix),
  ];
}

/**
 * Report attw and publint gaps in one tsdown config export.
 *
 * Accepts one config object or an array of config objects. Each object must set `attw.profile` to
 * `"esm-only"`, `attw.level` to `"error"`, and `publint` to an always-on value.
 *
 * @param defaultExport - Default export of `tsdown.config.ts`.
 * @returns Problems in the export. Empty when every config object meets the rule.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Parses a tsdown config default export at the I/O boundary.
export function problemsForConfigExport(defaultExport: unknown): readonly string[] {
  const listed = z.array(z.unknown()).safeParse(defaultExport);
  if (!listed.success) return problemsForOneConfig(defaultExport, "");
  if (listed.data.length === 0) {
    return ["tsdown config is an empty array. Each entry needs attw and publint."];
  }

  const problems: string[] = [];
  for (const [index, entry] of listed.data.entries()) {
    problems.push(...problemsForOneConfig(entry, `config[${String(index)}].`));
  }
  return problems;
}

function messagesForStatus(input: PackageConfigCheck): readonly string[] {
  if (input.config.kind === "missing") {
    if (input.isPrivate) return [];
    return [
      'publishable package is missing tsdown.config.ts. Set attw.profile to "esm-only", attw.level to "error", and publint to true.',
    ];
  }
  if (input.config.kind === "load-error") {
    return [`cannot load tsdown.config.ts. ${input.config.detail}`];
  }
  return problemsForConfigExport(input.config.defaultExport);
}

/**
 * Report attw and publint gaps for one workspace package.
 *
 * A private package may omit `tsdown.config.ts`. A publishable package may not. A package that has
 * the file must enable both checks.
 *
 * @param input - Package name, privacy, and tsdown config status.
 * @returns Problems for this package. Empty when the package meets the rule.
 */
export function problemsForPackage(input: PackageConfigCheck): readonly string[] {
  return messagesForStatus(input).map((message) => {
    return `${input.packageName} (packages/${input.directoryName}): ${message}`;
  });
}

function parseManifest(text: string): ManifestRead {
  try {
    const parsed: unknown = JSON.parse(text);
    const result = manifestSchema.safeParse(parsed);
    if (!result.success) {
      return {
        ok: false,
        detail:
          "package.json must include a non-empty name. private must be a boolean when it is present.",
      };
    }
    return {
      ok: true,
      name: result.data.name,
      isPrivate: result.data.private === true,
    };
  } catch (error: unknown) {
    return { ok: false, detail: `package.json is not valid JSON. ${errorMessage(error)}` };
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Dynamic import of tsdown.config.ts has no static type.
function readConfigModule(namespace: unknown): LoadedConfig {
  const parsed = configModuleSchema.safeParse(namespace);
  if (!parsed.success) {
    return { kind: "load-error", detail: "tsdown.config.ts has no default export." };
  }
  return { kind: "exported", defaultExport: parsed.data.default };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Reads the message from a failed config import.
function importFailure(error: unknown): LoadedConfig {
  return { kind: "load-error", detail: errorMessage(error) };
}

async function loadConfigExport(configPath: string): Promise<LoadedConfig> {
  try {
    const imported: unknown = await import(pathToFileURL(configPath).href);
    return readConfigModule(imported);
  } catch (error: unknown) {
    return importFailure(error);
  }
}

async function readPackage(
  packagesDirectory: string,
  directoryName: string,
): Promise<PackageRead | undefined> {
  const packageDirectory = path.join(packagesDirectory, directoryName);
  const manifestPath = path.join(packageDirectory, "package.json");
  if (!fileExists(manifestPath)) return undefined;

  const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
  if (!manifest.ok) {
    return {
      packageName: undefined,
      problems: [`packages/${directoryName}: ${manifest.detail}`],
    };
  }

  const configPath = path.join(packageDirectory, TSDOWN_CONFIG_FILE);
  const missingConfig: PackageConfigStatus = { kind: "missing" };
  const config = fileExists(configPath) ? await loadConfigExport(configPath) : missingConfig;

  return {
    packageName: manifest.name,
    problems: problemsForPackage({
      directoryName,
      packageName: manifest.name,
      isPrivate: manifest.isPrivate,
      config,
    }),
  };
}

/**
 * Read each direct child of a workspace `packages` directory and report attw and publint gaps.
 *
 * @param packagesDirectory - Absolute path of the directory that contains workspace packages.
 * @returns Names of packages with a readable manifest, plus every problem found.
 */
export async function checkPackagesDirectory(
  packagesDirectory: string,
): Promise<PackagingCheckReport> {
  const directoryNames: string[] = [];
  for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    directoryNames.push(entry.name);
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- The TypeScript lib is ES2022, which has no Array#toSorted.
  directoryNames.sort((left, right) => left.localeCompare(right));

  const pendingReads: Array<Promise<PackageRead | undefined>> = [];
  for (const directoryName of directoryNames) {
    pendingReads.push(readPackage(packagesDirectory, directoryName));
  }
  const reads = await Promise.all(pendingReads);
  const packageNames: string[] = [];
  const problems: string[] = [];
  for (const read of reads) {
    if (read === undefined) continue;
    if (read.packageName !== undefined) packageNames.push(read.packageName);
    problems.push(...read.problems);
  }
  return { packageNames, problems };
}
