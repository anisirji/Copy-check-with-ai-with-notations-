import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/** Identifiers are single path components, never paths or dot segments. */
export function assertStorageId(
  value: unknown,
  label = "id",
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,239}$/.test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }
}

export function validateIdParam(
  _req: Request,
  res: Response,
  next: NextFunction,
  value: string,
  name: string,
): void {
  try {
    assertStorageId(value, name);
    next();
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
}

export function runDirectory(root: string, runId: string): string {
  assertStorageId(runId, "run id");
  return path.resolve(root, runId);
}

export function evaluationPath(root: string, runId: string): string {
  return path.join(runDirectory(root, runId), "evaluation.json");
}

// One queue per absolute file, shared by every store/router instance in this
// Node process. Callers must hold it for the entire read-modify-publish cycle.
const queues = new Map<string, Promise<void>>();
export async function withFileLock<T>(
  file: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(file);
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  queues.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}

/** Readers see either the old complete file or the new complete file. */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  return writeFileAtomic(file, JSON.stringify(data, null, 2));
}
