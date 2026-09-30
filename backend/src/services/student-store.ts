import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertStorageId,
  withFileLock,
  writeJsonAtomic,
} from "./file-store.js";
import type { Student } from "../types.js";

/**
 * Class → students JSON store. One file per class: `<storeDir>/<class>.json`.
 * Class names are slugified to `[a-z0-9-]+` for safe filenames.
 */
export class StudentStore {
  constructor(private storeDir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.storeDir, { recursive: true });
  }

  private path(cls: string): string {
    const slug = cls
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    assertStorageId(slug || "class", "class key");
    return path.resolve(this.storeDir, `${slug || "class"}.json`);
  }

  async list(cls: string): Promise<Student[]> {
    const file = this.path(cls);
    await this.init();
    try {
      const raw = await fs.readFile(file, "utf-8");
      return JSON.parse(raw) as Student[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [];
    }
  }

  async save(cls: string, students: Student[]): Promise<Student[]> {
    await this.init();
    await withFileLock(this.path(cls), () =>
      writeJsonAtomic(this.path(cls), students),
    );
    return students;
  }

  async add(
    cls: string,
    name: string,
    rollNumber?: string | number,
  ): Promise<Student> {
    return withFileLock(this.path(cls), async () => {
      const current = await this.list(cls);
      const student: Student = {
        id: `stu-${randomUUID().slice(0, 8)}`,
        name,
        class: cls,
        rollNumber,
      };
      current.push(student);
      await writeJsonAtomic(this.path(cls), current);
      return student;
    });
  }

  async get(cls: string, studentId: string): Promise<Student | null> {
    assertStorageId(studentId, "student id");
    const list = await this.list(cls);
    return list.find((s) => s.id === studentId) ?? null;
  }
}
