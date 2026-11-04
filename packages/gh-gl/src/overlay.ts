import { execa } from "execa";
import { chmod, lstat, mkdir, readdir, readFile, readlink, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** A captured overlay tree stored in the scratch repository's object database. */
export type OverlaySnapshot = Readonly<{ tree: string; fingerprint: string }>;

type TreeEntry = Readonly<{ mode: string; objectId: string; path: string; type: string }>;
const FsErrorSchema = z.object({ code: z.string() });
const MAX_SYMLINK_TARGET_BYTES = 4096;
const TreeEntrySchema = z.object({
  mode: z.string(),
  type: z.string(),
  objectId: z.string(),
  path: z.string(),
});

/** An index update. Mode "0" removes the path from the index. */
type IndexEntry = Readonly<{ mode: string; objectId: string; path: string }>;
const ZERO_OBJECT_ID = "0".repeat(40);

/**
 * Write index entries with one `update-index --index-info` call.
 *
 * @param indexPath - Index file to write. The default is the scratch repository's index.
 */
async function writeIndexEntries(
  scratchDir: string,
  entries: ReadonlyArray<IndexEntry>,
  indexPath?: string,
): Promise<void> {
  if (entries.length === 0) return;

  const input = entries.map((entry) => `${entry.mode} ${entry.objectId}\t${entry.path}\0`).join("");
  await execa(
    "git",
    ["-C", scratchDir, "update-index", "--add", "--replace", "-z", "--index-info"],
    indexPath === undefined ? { input } : { input, env: { GIT_INDEX_FILE: indexPath } },
  );
}

/** Store overlay files as Git blobs and return their tree entry metadata. */
async function collectOverlayEntries(
  scratchDir: string,
  sourceRoot: string,
  sourceDir: string,
): Promise<Array<TreeEntry>> {
  const entries: Array<TreeEntry> = [];
  const names = await readdir(sourceDir);

  for (const name of names) {
    if (name === ".git") continue;

    const sourcePath = path.join(sourceDir, name);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Read each path before descending into it.
    const sourceStat = await lstat(sourcePath);

    if (sourceStat.isDirectory()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve one-pass traversal of the source.
      entries.push(...(await collectOverlayEntries(scratchDir, sourceRoot, sourcePath)));
      continue;
    }

    let mode: string;
    let contents: Buffer;
    if (sourceStat.isSymbolicLink()) {
      mode = "120000";
      // oxlint-disable-next-line eslint/no-await-in-loop -- Read each source entry once.
      contents = await readlink(sourcePath, { encoding: "buffer" });
    } else if (sourceStat.isFile()) {
      // oxlint-disable-next-line eslint/no-bitwise -- Git reads only the owner execute bit.
      mode = (sourceStat.mode & 0o100) === 0 ? "100644" : "100755";
      // oxlint-disable-next-line eslint/no-await-in-loop -- Read each source entry once.
      contents = await readFile(sourcePath);
    } else {
      continue;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- Store each read blob before continuing capture.
    const { stdout } = await execa(
      "git",
      ["-C", scratchDir, "hash-object", "-w", "--no-filters", "--stdin"],
      { input: contents },
    );
    entries.push({
      mode,
      type: "blob",
      objectId: stdout,
      path: path.relative(sourceRoot, sourcePath),
    });
  }

  return entries;
}

/**
 * Capture the current overlay content as a Git tree in the scratch repository.
 *
 * Capture reads each source entry into Git without applying filters. The source can change during
 * capture. Callers must use the returned tree for both comparison and application.
 *
 * @param scratchDir - Scratch repository that stores the captured tree and blobs.
 * @param sourceDir - Local overlay directory to capture.
 * @returns The tree hash used as both the fingerprint and application source.
 */
export async function captureOverlay(
  scratchDir: string,
  sourceDir: string,
): Promise<OverlaySnapshot> {
  const indexPath = path.join(scratchDir, ".git", "gh-gl-overlay-index");

  try {
    const sourceRoot = path.resolve(sourceDir);
    const entries = await collectOverlayEntries(path.resolve(scratchDir), sourceRoot, sourceRoot);

    await writeIndexEntries(scratchDir, entries, indexPath);
    const { stdout } = await execa("git", ["-C", scratchDir, "write-tree"], {
      env: { GIT_INDEX_FILE: indexPath },
    });

    return { tree: stdout, fingerprint: stdout };
  } finally {
    await rm(indexPath, { force: true });
  }
}

/** Read and validate the entries stored in a Git tree. */
async function readTreeEntries(scratchDir: string, tree: string): Promise<Array<TreeEntry>> {
  const { stdout } = await execa("git", ["-C", scratchDir, "ls-tree", "-rz", "--full-tree", tree]);

  const entries = stdout
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, type, objectId] = entry.slice(0, tab).split(" ");

      return { mode, type, objectId, path: entry.slice(tab + 1) };
    });

  return z.array(TreeEntrySchema).parse(entries);
}

/** Create safe parent directories for an overlay path. */
async function ensureDirectory(destDir: string, relativePath: string): Promise<string> {
  let current = destDir;

  for (const segment of relativePath.split(path.sep)) {
    current = path.join(current, segment);
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Check each parent before visiting its child.
      const stat = await lstat(current);

      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Remove a conflicting path before creating its directory.
        await rm(current, { recursive: true, force: true });
        // oxlint-disable-next-line eslint/no-await-in-loop -- Create each parent before checking the next one.
        await mkdir(current);
      }
    } catch (error) {
      const parsed = FsErrorSchema.safeParse(error);

      if (!parsed.success || parsed.data.code !== "ENOENT") throw error;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Create each parent before checking the next one.
      await mkdir(current);
    }
  }

  return current;
}

/**
 * Apply a captured overlay tree to a destination directory.
 *
 * Overlay entries replace destination paths. Parent path checks use lstat so destination symlinks
 * are removed instead of followed.
 *
 * @param scratchDir - Scratch repository that stores the captured blobs.
 * @param snapshot - Captured overlay tree to apply.
 * @param destDir - Destination directory for overlay paths.
 */
async function applyOverlay(
  scratchDir: string,
  snapshot: OverlaySnapshot,
  destDir: string,
): Promise<void> {
  const entries = await readTreeEntries(scratchDir, snapshot.tree);

  for (const entry of entries) {
    const parentPath = path.dirname(entry.path);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Create parent directories before applying children.
    const parent = parentPath === "." ? destDir : await ensureDirectory(destDir, parentPath);
    const destination = path.join(parent, path.basename(entry.path));

    // oxlint-disable-next-line eslint/no-await-in-loop -- Apply paths in order to handle directory conflicts.
    await rm(destination, { recursive: true, force: true });
    if (entry.type !== "blob") {
      throw new Error(`Unsupported overlay object type "${entry.type}" at "${entry.path}".`);
    }

    if (entry.mode === "120000") {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Read each symlink target before continuing.
      const { stdout } = await execa(
        "git",
        ["-C", scratchDir, "cat-file", "blob", entry.objectId],
        {
          encoding: "buffer",
          maxBuffer: { stdout: MAX_SYMLINK_TARGET_BYTES },
          stripFinalNewline: false,
        },
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- Create each destination entry before continuing.
      await symlink(Buffer.from(stdout), destination);
    } else {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Stream one captured blob before continuing.
      await execa("git", ["-C", scratchDir, "cat-file", "blob", entry.objectId], {
        buffer: { stdout: false },
        stdout: { file: destination },
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Apply mode after writing this file.
      await chmod(destination, entry.mode === "100755" ? 0o755 : 0o644);
    }
  }
}

/** Report if a path exists without following a final symlink. */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    const parsed = FsErrorSchema.safeParse(error);

    if (parsed.success && (parsed.data.code === "ENOENT" || parsed.data.code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

/** Return the paths that have the `export-subst` attribute set. */
async function listExportSubstPaths(
  scratchDir: string,
  paths: ReadonlyArray<string>,
): Promise<Array<string>> {
  if (paths.length === 0) return [];

  const { stdout } = await execa(
    "git",
    ["-C", scratchDir, "check-attr", "--cached", "-z", "--stdin", "export-subst"],
    { input: paths.map((entryPath) => `${entryPath}\0`).join("") },
  );
  const fields = stdout.split("\0");

  // Output has three fields per input path, in input order: path, attribute, value.
  return paths.filter(
    (entryPath, index) => fields[index * 3] === entryPath && fields[index * 3 + 2] === "set",
  );
}

/**
 * Make the upstream index match the paths and content that `git archive` extracted.
 *
 * The index starts as the raw upstream tree. `git archive` omits `export-ignore` paths and
 * gitlinks, and it expands `export-subst` files. Remove index entries that are absent from the
 * extracted worktree. Remove all gitlinks. Store the extracted content of each `export-subst` file.
 * Keep the upstream blob IDs of all other paths, so that worktree conversion does not change
 * upstream bytes.
 *
 * @param scratchDir - Scratch repository whose index holds the upstream tree and whose worktree
 *   holds the extracted archive.
 */
async function matchArchiveContent(scratchDir: string): Promise<void> {
  const { stdout } = await execa("git", ["-C", scratchDir, "ls-files", "--stage", "-z"]);
  const indexEntries = stdout
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, objectId] = line.slice(0, tab).split(" ");

      return { mode, objectId, path: line.slice(tab + 1) };
    });
  const entries = z.array(TreeEntrySchema.omit({ type: true })).parse(indexEntries);
  const present = await Promise.all(
    entries.map(
      async (entry) =>
        entry.mode !== "160000" && (await pathExists(path.join(scratchDir, entry.path))),
    ),
  );
  const kept: Array<IndexEntry> = [];
  const removed: Array<IndexEntry> = [];
  for (const [index, entry] of entries.entries()) {
    if (present[index] === true) kept.push(entry);
    else removed.push({ mode: "0", objectId: ZERO_OBJECT_ID, path: entry.path });
  }
  const keptFiles = kept.filter((entry) => entry.mode === "100644" || entry.mode === "100755");
  const substPaths = new Set(
    await listExportSubstPaths(
      scratchDir,
      keptFiles.map((entry) => entry.path),
    ),
  );
  const substituted = await Promise.all(
    keptFiles
      .filter((entry) => substPaths.has(entry.path))
      .map(async (entry) => {
        // Hash with filters, like the `git add` of the extracted file that this step replaces.
        const { stdout: objectId } = await execa("git", [
          "-C",
          scratchDir,
          "hash-object",
          "-w",
          "--",
          entry.path,
        ]);
        return { mode: entry.mode, objectId, path: entry.path };
      }),
  );

  await writeIndexEntries(scratchDir, [...removed, ...substituted]);
}

/**
 * Apply a captured overlay to the scratch repo and stage it over the upstream content.
 *
 * The scratch worktree must hold the `git archive` output of `upstreamCommit`. The base index is
 * the upstream tree minus the paths that the archive omits. Overlay entries then replace index
 * entries with their exact captured blob IDs and modes.
 *
 * @param scratchDir - Scratch repository with the extracted upstream worktree.
 * @param snapshot - Captured overlay tree and fingerprint.
 * @param upstreamCommit - Commit whose tree forms the base index.
 */
export async function applyCapturedOverlay(
  scratchDir: string,
  snapshot: OverlaySnapshot,
  upstreamCommit: string,
): Promise<void> {
  await execa("git", ["-C", scratchDir, "read-tree", upstreamCommit]);
  await matchArchiveContent(scratchDir);
  await applyOverlay(scratchDir, snapshot, scratchDir);
  await writeIndexEntries(scratchDir, await readTreeEntries(scratchDir, snapshot.tree));
}
