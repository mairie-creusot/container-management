import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    // Bind mount Windows -> conteneur Docker (docker-compose.dev.yml) : les événements fs
    // natifs (inotify) ne traversent pas ce type de partage, HMR ne se déclenche jamais sans
    // polling explicite — un `docker compose restart web` était alors nécessaire à chaque
    // modification. host: true pour rester joignable depuis l'hôte Windows (0.0.0.0).
    watch: {
      usePolling: true,
      interval: 300,
    },
    host: true,
  },
});
