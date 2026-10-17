import type { ESTree } from "@oxlint/plugins";

import { defineRule } from "@oxlint/plugins";
import { existsSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const jsonSchema = z.json();
const rootManifestSchema = z.object({ workspaces: z.array(z.string()).optional() });
const packageManifestSchema = z.object({
  name: z.string(),
  exports: jsonSchema.optional(),
});
type JsonValue = z.infer<typeof jsonSchema>;
type WorkspacePackage = { name: string; root: string; exports: JsonValue | undefined };
type Workspace = { root: string; packages: WorkspacePackage[] };

function parseManifest<T extends z.ZodType>(filePath: string, schema: T): z.infer<T> {
  return schema.parse(JSON.parse(readFileSync(filePath, "utf8")));
}

function canonicalPath(filePath: string): string {
  const absolute = path.resolve(filePath);
  let ancestor = absolute;
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return absolute;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(realpathSync(ancestor), ...suffix);
}

function workspaceAt(current: string): Workspace | null {
  const manifestPath = path.join(current, "package.json");
  if (!existsSync(manifestPath)) return null;
  const rootManifest = parseManifest(manifestPath, rootManifestSchema);
  if (rootManifest.workspaces?.includes("packages/*") !== true) return null;
  const packages: WorkspacePackage[] = [];
  for (const entry of readdirSync(path.join(current, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = path.join(current, "packages", entry.name);
    const packageManifestPath = path.join(packageRoot, "package.json");
    if (!existsSync(packageManifestPath)) continue;
    const parsed = parseManifest(packageManifestPath, packageManifestSchema);
    packages.push({ name: parsed.name, root: canonicalPath(packageRoot), exports: parsed.exports });
  }
  return { root: canonicalPath(current), packages };
}

function findWorkspace(start: string): Workspace | null {
  let current = path.dirname(start);
  while (true) {
    const workspace = workspaceAt(current);
    if (workspace !== null) return workspace;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isExportTarget(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  const stringValue = z.string().safeParse(value);
  if (stringValue.success) return stringValue.data.startsWith("./");
  const arrayValue = z.array(jsonSchema).safeParse(value);
  if (arrayValue.success) return arrayValue.data.some((entry) => isExportTarget(entry));
  const objectValue = z.record(z.string(), jsonSchema).safeParse(value);
  if (objectValue.success)
    return Object.values(objectValue.data).some((entry) => isExportTarget(entry));
  return false;
}

function exportMap(exports: JsonValue | undefined): Map<string, JsonValue> | null {
  if (exports === undefined || exports === null) return null;
  const stringValue = z.string().safeParse(exports);
  if (stringValue.success) return new Map([[".", stringValue.data]]);
  const arrayValue = z.array(jsonSchema).safeParse(exports);
  if (arrayValue.success) return new Map([[".", arrayValue.data]]);
  const objectValue = z.record(z.string(), jsonSchema).safeParse(exports);
  if (!objectValue.success) return null;
  const entries = Object.entries(objectValue.data);
  if (entries.some(([key]) => key.startsWith("."))) return new Map(entries);
  return new Map([[".", exports]]);
}

function bestExportKey(exports: Map<string, JsonValue>, subpath: string): string | null {
  let best: string | null = null;
  for (const key of exports.keys()) {
    if (!key.includes("*")) {
      if (key === subpath) return key;
      continue;
    }
    const [prefix = "", suffix = ""] = key.split("*");
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (subpath.length < prefix.length + suffix.length) continue;
    const previousPrefix = best?.split("*")[0] ?? "";
    if (
      best === null ||
      prefix.length > previousPrefix.length ||
      (prefix.length === previousPrefix.length && key.length > best.length)
    )
      best = key;
  }
  return best;
}

function sourceString(node: ESTree.Node | undefined): string | null {
  if (node?.type === "Literal") {
    const parsed = z.string().safeParse(node.value);
    if (parsed.success) return parsed.data;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? null;
  return null;
}

function cleanSource(source: string): string {
  const withoutQuery = source.split(/[?#]/u, 1)[0] ?? source;
  return withoutQuery.startsWith("file:") ? fileURLToPath(withoutQuery) : withoutQuery;
}

function targetPackage(
  source: string,
  importer: string,
  packages: WorkspacePackage[],
): WorkspacePackage | null {
  const normalized = cleanSource(source);
  if (normalized.startsWith(".") || path.isAbsolute(normalized)) {
    const resolved = canonicalPath(path.resolve(path.dirname(importer), normalized));
    return (
      packages.find(
        (item) => resolved === item.root || resolved.startsWith(`${item.root}${path.sep}`),
      ) ?? null
    );
  }
  return (
    packages.find((item) => normalized === item.name || normalized.startsWith(`${item.name}/`)) ??
    null
  );
}

function isPublicImport(source: string, target: WorkspacePackage): boolean {
  const normalized = cleanSource(source);
  const map = exportMap(target.exports);
  if (map === null) return false;
  if (normalized === target.name) {
    const root = map.get(".");
    return root !== undefined && isExportTarget(root);
  }
  if (!normalized.startsWith(`${target.name}/`)) return false;
  const subpath = `./${normalized.slice(target.name.length + 1)}`;
  const key = bestExportKey(map, subpath);
  const value = key === null ? undefined : map.get(key);
  return isExportTarget(value);
}

/** Require imports between workspace packages to use the target package's declared public exports. */
export const noCrossPackageInternalsRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow imports that cross package boundaries through internal paths." },
    messages: { crossPackage: "Import from {{packageName}} through a declared package export." },
  },
  create(context) {
    const importer = canonicalPath(context.filename);
    const workspace = findWorkspace(importer);
    if (workspace === null) return {};
    const owner = workspace.packages.find(
      (item) => importer === item.root || importer.startsWith(`${item.root}${path.sep}`),
    );
    if (owner === undefined) return {};

    const check = (node: ESTree.Node, source: string | null) => {
      if (source === null) return;
      const target = targetPackage(source, importer, workspace.packages);
      if (target === null || target.root === owner.root) return;
      const normalized = cleanSource(source);
      if (
        normalized.startsWith(".") ||
        path.isAbsolute(normalized) ||
        normalized.startsWith("file:") ||
        !isPublicImport(source, target)
      ) {
        context.report({ node, messageId: "crossPackage", data: { packageName: target.name } });
      }
    };
    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null) check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        check(node, node.source.value);
      },
      ImportExpression(node) {
        check(node, sourceString(node.source));
      },
      TSImportType(node) {
        check(node, node.source.value);
      },
    };
  },
});
