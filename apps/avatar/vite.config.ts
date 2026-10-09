import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: `npm run dev` serves the React app on 5173 and proxies /api to the
// backend on 8788. Prod: `npm run build` then the backend serves dist/.
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173, proxy: { "/api": "http://localhost:8788" } },
});
