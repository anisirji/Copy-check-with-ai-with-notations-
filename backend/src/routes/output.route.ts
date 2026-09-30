import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { runDirectory, validateIdParam } from "../services/file-store.js";

/** Expose review media only. Never publish evaluation JSON, model traces,
 * cached blocks, verification logs or arbitrary files from the output tree. */
export function outputRoutes(outputRoot: string) {
  const router = Router();
  router.param("runId", validateIdParam);
  router.get(["/:runId/:asset", "/:runId/pages/:page"], async (req, res) => {
    const { asset, page } = req.params;
    if (
      page
        ? !/^page-\d+\.png$/.test(page)
        : !/^(?:original|evaluated|annotated)\.pdf$|^page-\d+-annotated\.png$/.test(
            asset,
          )
    ) {
      return res.status(404).json({ error: "not found" });
    }
    try {
      const directory = runDirectory(outputRoot, req.params.runId);
      const file = path.join(directory, ...(page ? ["pages", page] : [asset]));
      const [realRoot, realFile] = await Promise.all([
        fs.realpath(outputRoot),
        fs.realpath(file),
      ]);
      const relative = path.relative(realRoot, realFile);
      if (
        relative.startsWith(`..${path.sep}`) ||
        relative === ".." ||
        path.isAbsolute(relative)
      )
        return res.status(404).json({ error: "not found" });
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(realFile);
    } catch {
      res.status(404).json({ error: "not found" });
    }
  });
  router.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });
  return router;
}
