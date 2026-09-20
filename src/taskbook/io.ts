import fs from "node:fs";

/**
 * Minimal IO seam for the Taskbook layer.
 *
 * Production code uses {@link nodeTaskbookIo}. Tests may substitute a narrowly
 * scoped implementation to inject low-level failures (open/write/close/stat/
 * enumeration) that cannot be produced with real filesystem topology.
 */
export interface TaskbookIo {
  lstat(pathname: string): fs.Stats;
  realpath(pathname: string): string;
  /** Non-recursive directory create (exclusive semantics owned by the OS). */
  mkdir(pathname: string): void;
  /** Remove an empty directory (used only to release the R1 lock). */
  rmdir(pathname: string): void;
  /**
   * Bounded, iterative direct-child enumeration.
   * `exceeded` is true when more than `maxEntries` entries exist; the caller
   * must then fail closed. Throws on enumeration failure instead of returning a
   * silently partial result.
   */
  readDirBounded(pathname: string, maxEntries: number): { names: string[]; exceeded: boolean };
  readTextFile(pathname: string): string;
  /** Exclusive create-new open (`wx`). Throws EEXIST when the leaf already exists. */
  openExclusive(pathname: string): number;
  writeAll(fd: number, data: string): void;
  close(fd: number): void;
  closeQuietly(fd: number): void;
}

export const nodeTaskbookIo: TaskbookIo = {
  lstat: (pathname) => fs.lstatSync(pathname),
  realpath: (pathname) => fs.realpathSync.native(pathname),
  mkdir: (pathname) => {
    fs.mkdirSync(pathname);
  },
  rmdir: (pathname) => {
    fs.rmdirSync(pathname);
  },
  readDirBounded: (pathname, maxEntries) => {
    const names: string[] = [];
    let exceeded = false;
    const handle = fs.opendirSync(pathname);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (entry === null) break;
        names.push(entry.name);
        if (names.length > maxEntries) {
          exceeded = true;
          break;
        }
      }
    } finally {
      try {
        handle.closeSync();
      } catch {
        // best effort; enumeration errors surface from readSync above
      }
    }
    return { names, exceeded };
  },
  readTextFile: (pathname) => fs.readFileSync(pathname, "utf8"),
  openExclusive: (pathname) => fs.openSync(pathname, "wx", 0o600),
  writeAll: (fd, data) => {
    fs.writeFileSync(fd, data, { encoding: "utf8" });
  },
  close: (fd) => {
    fs.closeSync(fd);
  },
  closeQuietly: (fd) => {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore: used only on an error path
    }
  },
};
