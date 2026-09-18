// Small filesystem helpers shared by the control plane and the board readers.
// Both answer "nothing there" instead of throwing.

import { promises as fs } from "node:fs";

/** fs.stat, or null when the path is absent or unreadable. */
export async function statOrNull(path) {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

/** Directory entries (with types), or [] when the directory is absent. */
export async function listDir(path) {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}
