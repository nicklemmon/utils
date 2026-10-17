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
      // oxlint-disable-next-line eslint/no-bitwise -- Git executable mode uses the Unix execute bits.
      mode = (sourceStat.mode & 0o111) === 0 ? "100644" : "100755";
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

    for (const entry of entries) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Update-index writes must be serial.
      await execa(
        "git",
        [
          "-C",
          scratchDir,
          "update-index",
          "--add",
          "--cacheinfo",
          entry.mode,
          entry.objectId,
          entry.path,
        ],
        {
          env: { GIT_INDEX_FILE: indexPath },
        },
      );
    }

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

/**
 * Replace upstream index entries with the exact blob IDs and modes from the captured overlay.
 *
 * @param scratchDir - Scratch repository with an index based on the upstream commit.
 * @param snapshot - Captured overlay tree to add to the index.
 */
async function stageOverlayTree(scratchDir: string, snapshot: OverlaySnapshot): Promise<void> {
  const entries = await readTreeEntries(scratchDir, snapshot.tree);

  for (const entry of entries) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Update-index writes must be serial.
    await execa("git", [
      "-C",
      scratchDir,
      "update-index",
      "--add",
      "--replace",
      "--cacheinfo",
      entry.mode,
      entry.objectId,
      entry.path,
    ]);
  }
}

/**
 * Apply a captured overlay to the scratch repo and replace its upstream index entries.
 *
 * @param scratchDir - Scratch repository with the upstream worktree.
 * @param snapshot - Captured overlay tree and fingerprint.
 * @param upstreamCommit - Commit whose tree forms the base index.
 */
export async function applyCapturedOverlay(
  scratchDir: string,
  snapshot: OverlaySnapshot,
  upstreamCommit: string,
): Promise<void> {
  await execa("git", ["-C", scratchDir, "read-tree", upstreamCommit]);
  await applyOverlay(scratchDir, snapshot, scratchDir);
  await stageOverlayTree(scratchDir, snapshot);
}
