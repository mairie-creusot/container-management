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
  optimizeDeps: {
    // @novnc/novnc (console VNC des VMs Nutanix, voir VmConsole.tsx) utilise un `await` de haut
    // niveau dans un de ses fichiers internes (core/util/browser.js, détection de support
    // WebCodecs) — la cible esbuild PAR DÉFAUT du pré-bundling de dépendances de Vite (baseline
    // ancienne : chrome87/es2020/safari14...) ne le supporte pas et fait planter le serveur de
    // dev entier au démarrage ("Top-level await is not available...", bug réel constaté le
    // 14/08/2026). Les navigateurs réels ciblés par cette app supportent nativement le top-level
    // await depuis longtemps — on exclut simplement ce paquet du PRÉ-bundling esbuild (il reste
    // servi tel quel, en ESM natif, ce que le navigateur exécute très bien) plutôt que de relever
    // la cible globale de tout le pré-bundling pour un seul paquet.
    exclude: ["@novnc/novnc"],
  },
  build: {
    // Même cause que l'exclusion ci-dessus, mais pour `vite build` : l'exclusion du pré-bundling ne
    // vaut QUE pour le serveur de dev. À la construction, @novnc/novnc est bien transpilé et sa
    // cible par défaut (es2020/chrome87...) refuse son `await` de haut niveau — la construction de
    // production échouait donc, y compris en CI (constaté le 24/08/2026). es2022 le supporte
    // nativement et reste très en deçà des navigateurs réellement utilisés ici.
    target: "es2022",
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
    // Proxy interne vers le conteneur API (nom de service docker-compose "api", résolu par le
    // DNS interne Docker — même principe que "caddy"/"quai-dev-web-1" ailleurs dans ce fichier)
    // pour que le frontend puisse appeler une URL RELATIVE ("/api/...", voir api/client.ts) plutôt
    // qu'une URL absolue "http://localhost:3000" figée. Sans ça, une page chargée en HTTPS via le
    // reverse proxy interne (ex: https://quai.lecreusot.priv, services/reverseProxy.ts) voit ses
    // appels vers "http://localhost:3000" bloqués par le navigateur comme contenu mixte (HTTP
    // actif depuis une page HTTPS) — constaté en conditions réelles le 13/08/2026 : la connexion
    // LDAP échouait silencieusement ("Connexion impossible") sans qu'aucune requête n'atteigne
    // jamais l'API. `ws: true` couvre aussi les deux WebSocket de l'app (console, logs stream —
    // voir api/client.ts#wsUrl) qui passent par ce même préfixe "/api".
    proxy: {
      "/api": { target: "http://api:3000", changeOrigin: true, ws: true },
    },
  },
});
