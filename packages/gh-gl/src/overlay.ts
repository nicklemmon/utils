import { cp } from "node:fs/promises";

/**
 * Copy `overlayDir` onto `destDir`. Overlay files always win on path
 * collision: this is a plain overwrite copy, with no merge logic.
 *
 * @param overlayDir - The GitLab-specific overlay directory.
 * @param destDir - The extracted GitHub tree to layer the overlay onto.
 */
export async function copyOverlayOnto(
  overlayDir: string,
  destDir: string,
): Promise<void> {
  await cp(overlayDir, destDir, { recursive: true });
}
