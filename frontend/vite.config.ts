import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.FRONTEND_PORT ?? 5190),
    strictPort: true,
    proxy: {
      "/grade": "http://localhost:8090",
      "/run": "http://localhost:8090",
      "/output": "http://localhost:8090",
      "/health": "http://localhost:8090",
      "/exam": {
        target: "http://localhost:8090",
        // Exam screens and API endpoints share the same prefix. Navigation
        // needs the SPA shell; fetch requests still go to the backend.
        bypass(req) {
          if (
            req.method === "GET" &&
            req.headers.accept?.includes("text/html") &&
            /\/exam\/[^/]+\/(questions|scheme|grade|report|matrix|students)(?:[/?#]|$)/.test(
              req.url ?? "",
            )
          ) {
            return "/index.html";
          }
        },
      },
    },
  },
});
