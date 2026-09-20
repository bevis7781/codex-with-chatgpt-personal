import type { Stats } from "node:fs";
import { TaskbookError, errnoCodeOf } from "./errors.js";
import type { TaskbookIo } from "./io.js";

/**
 * Fail-closed filesystem helpers for the Taskbook layer.
 *
 * Every helper converts an unexpected OS failure into a sanitized
 * {@link TaskbookError} with code STORAGE_ERROR. Raw OS messages and paths are
 * never propagated (only a bare errno discriminator is retained internally).
 */

export function lstatStrict(io: TaskbookIo, target: string): Stats {
  try {
    return io.lstat(target);
  } catch (error) {
    throw new TaskbookError("STORAGE_ERROR", undefined, errnoCodeOf(error) ?? "LSTAT_FAILED");
  }
}

/** Treats only ENOENT as "absent"; every other error fails closed. */
export function lstatOrNull(io: TaskbookIo, target: string): Stats | null {
  try {
    return io.lstat(target);
  } catch (error) {
    if (errnoCodeOf(error) === "ENOENT") return null;
    throw new TaskbookError("STORAGE_ERROR", undefined, errnoCodeOf(error) ?? "LSTAT_FAILED");
  }
}

export function realpathStrict(io: TaskbookIo, target: string): string {
  try {
    return io.realpath(target);
  } catch (error) {
    throw new TaskbookError("STORAGE_ERROR", undefined, errnoCodeOf(error) ?? "REALPATH_FAILED");
  }
}

export function readTextStrict(io: TaskbookIo, target: string): string {
  try {
    return io.readTextFile(target);
  } catch (error) {
    throw new TaskbookError("STORAGE_ERROR", undefined, errnoCodeOf(error) ?? "READ_FAILED");
  }
}

export function mkdirStrict(io: TaskbookIo, target: string): void {
  try {
    io.mkdir(target);
  } catch (error) {
    throw new TaskbookError("STORAGE_ERROR", undefined, errnoCodeOf(error) ?? "MKDIR_FAILED");
  }
}

export function rmdirStrict(io: TaskbookIo, target: string): void {
  try {
    io.rmdir(target);
  } catch (error) {
    throw new TaskbookError("STORAGE_ERROR", undefined, errnoCodeOf(error) ?? "RMDIR_FAILED");
  }
}
