import path from "node:path";
import { createApp } from "./app.js";

const port = Number(process.env.BACKEND_PORT ?? 8090);
const app = await createApp({ rootDir: path.resolve(process.cwd(), "..") });
app.listen(port, () => {
  console.log(`[copy-check-poc] backend listening on http://localhost:${port}`);
});
