import fs from "node:fs/promises";
import path from "node:path";
import {
  assertStorageId,
  withFileLock,
  writeJsonAtomic,
} from "./file-store.js";
import type { TestHistoryEntry } from "../types.js";

/**
 * Append-only per-student test history.
 * File: `<storeDir>/<studentId>.json` → TestHistoryEntry[]
 *
 * Only released runs are appended. `report` builder reads this to compute
 * "vs last test" and "value added / dragged down" deltas.
 */
export class HistoryStore {
  constructor(private storeDir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.storeDir, { recursive: true });
  }

  private path(studentId: string): string {
    assertStorageId(studentId, "student id");
    return path.resolve(this.storeDir, `${studentId}.json`);
  }

  async list(studentId: string): Promise<TestHistoryEntry[]> {
    const file = this.path(studentId);
    await this.init();
    try {
      const raw = await fs.readFile(file, "utf-8");
      const arr = JSON.parse(raw) as TestHistoryEntry[];
      // Sort ascending by releasedAt for consistent downstream math
      return arr.sort((a, b) => a.releasedAt.localeCompare(b.releasedAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [];
    }
  }

  async append(studentId: string, entry: TestHistoryEntry): Promise<void> {
    await withFileLock(this.path(studentId), async () => {
      const current = await this.list(studentId);
      // Idempotent — same runId won't double-count
      const filtered = current.filter((e) => e.runId !== entry.runId);
      filtered.push(entry);
      await writeJsonAtomic(this.path(studentId), filtered);
    });
  }

  /**
   * Average of everything EXCEPT the run we're about to score.
   */
  async averageBefore(
    studentId: string,
    excludingRunId: string,
  ): Promise<number | null> {
    const history = (await this.list(studentId)).filter(
      (e) => e.runId !== excludingRunId,
    );
    if (history.length === 0) return null;
    const sum = history.reduce((s, e) => s + e.percentage, 0);
    return sum / history.length;
  }
}
