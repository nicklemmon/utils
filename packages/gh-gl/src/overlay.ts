import { cp } from "node:fs/promises";
import path from "node:path";

/**
 * Copy `overlayDir` onto `destDir`.
 *
 * Overlay files always win on path collision. This is a plain overwrite copy with no merge logic.
 *
 * @param overlayDir - Local GitLab-specific overlay directory to layer on top.
 * @param destDir - Extracted GitHub tree that receives the overlay files.
 */
export async function copyOverlayOnto(overlayDir: string, destDir: string): Promise<void> {
  await cp(overlayDir, destDir, {
    filter: (source) => path.basename(source) !== ".git",
    recursive: true,
    verbatimSymlinks: true,
  });
}
