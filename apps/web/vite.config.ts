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
    // Le reverse proxy interne (services/reverseProxy.ts) route des sous-domaines internes
    // arbitraires (ex "monapp.lecreusot.priv") vers ce serveur en préservant le header Host
    // d'origine — Vite >=5.1.9/5.4.12 refuse par défaut (403 "Blocked request") tout Host non
    // listé explicitement (protection host-header côté prod). Ce fichier ne sert QUE le dev
    // local en conteneur (deploy/compose/docker-compose.dev.yml) — l'image de production
    // (Dockerfile.web) sert le build statique via un serveur HTTP classique, jamais ce serveur
    // de dev — donc `true` (aucune restriction) reste raisonnable ici, pas en prod.
    allowedHosts: true,
  },
});
