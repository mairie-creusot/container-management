/**
 * Bootstrap du serveur Fastify — QUAI API.
 *
 * Écoute sur process.env.PORT (défaut 3000). Voir README.md pour les instructions de
 * lancement et .env.example pour la liste complète des variables d'environnement.
 */

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { FastifyServerOptions } from "fastify";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import auditPlugin from "./plugins/audit.js";
import authPlugin from "./plugins/auth.js";
import auditRoutes from "./routes/audit.js";
import authRoutes from "./routes/auth.js";
import consoleRoutes from "./routes/console.js";
import containersRoutes from "./routes/containers.js";
import environmentsRoutes from "./routes/environments.js";
import gitopsRoutes from "./routes/gitops.js";
import iacRoutes from "./routes/iac.js";
import imagesRoutes from "./routes/images.js";
import networksRoutes from "./routes/networks.js";
import notificationsRoutes from "./routes/notifications.js";
import nutanixRoutes from "./routes/nutanix.js";
import registriesRoutes from "./routes/registries.js";
import reverseProxyRoutes from "./routes/reverseProxy.js";
import scanRoutes from "./routes/scan.js";
import secretsRoutes from "./routes/secrets.js";
import setupRoutes from "./routes/setup.js";
import topologyRoutes from "./routes/topology.js";
import volumesRoutes from "./routes/volumes.js";
import { startGitopsReconciler } from "./services/gitopsReconciler.js";
import { startWatchdog } from "./services/watchdog.js";

function buildLoggerOptions(): NonNullable<FastifyServerOptions["logger"]> {
  if (config.server.nodeEnv === "development") {
    return {
      level: config.server.logLevel,
      transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } },
    };
  }
  return { level: config.server.logLevel };
}

export function buildServer() {
  const fastify = Fastify({ logger: buildLoggerOptions() });

  const corsOrigins = config.server.corsOrigin.split(",").map((origin) => origin.trim());
  void fastify.register(cors, {
    origin: corsOrigins,
    credentials: true,
  });

  void fastify.register(cookie);
  void fastify.register(websocket);
  void fastify.register(authPlugin);
  void fastify.register(auditPlugin);

  void fastify.register(authRoutes);
  void fastify.register(setupRoutes);
  void fastify.register(environmentsRoutes);
  void fastify.register(imagesRoutes);
  void fastify.register(scanRoutes);
  void fastify.register(registriesRoutes);
  void fastify.register(secretsRoutes);
  void fastify.register(containersRoutes);
  void fastify.register(volumesRoutes);
  void fastify.register(networksRoutes);
  void fastify.register(gitopsRoutes);
  void fastify.register(auditRoutes);
  void fastify.register(iacRoutes);
  void fastify.register(topologyRoutes);
  void fastify.register(notificationsRoutes);
  void fastify.register(nutanixRoutes);
  void fastify.register(reverseProxyRoutes);
  void fastify.register(consoleRoutes);

  // /health : chemin attendu par les healthchecks Docker et les probes Kubernetes (voir deploy/).
  // /healthz : alias conservé au cas où un outil externe le suppose (convention courante).
  const healthHandler = async () => ({ status: "ok" });
  fastify.get("/health", healthHandler);
  fastify.get("/healthz", healthHandler);

  return fastify;
}

async function main(): Promise<void> {
  const fastify = buildServer();
  try {
    await fastify.listen({ port: config.server.port, host: "0.0.0.0" });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  // Détection proactive en tâche de fond (nouvelle version d'image, intégration devenue
  // injoignable/de nouveau joignable — voir services/watchdog.ts) : démarré seulement ici,
  // jamais depuis buildServer(), pour ne pas déclencher de vrais appels réseau pendant les
  // tests qui construisent le serveur avec `app.inject` sans jamais appeler main().
  const stopWatchdog = startWatchdog();

  // Boucle de réconciliation GitOps (détection de dérive seulement, jamais d'application
  // automatique — voir services/gitopsReconciler.ts) : même câblage que le watchdog ci-dessus,
  // démarré seulement ici pour ne jamais taper le disque/réseau pendant les tests.
  const stopGitopsReconciler = startGitopsReconciler();

  // Sans ceci, un SIGTERM (docker stop, ou nodemon qui redémarre le process en dev) tue le
  // process sans libérer explicitement le port avant que le suivant ne démarre — source
  // d'EADDRINUSE intermittents observés avec `nodemon --legacy-watch` (voir package.json,
  // nécessaire pour que le hot-reload fonctionne à travers le bind mount Windows -> Docker).
  const shutdown = (signal: string) => {
    fastify.log.info(`${signal} received, closing server`);
    stopWatchdog();
    stopGitopsReconciler();
    void fastify.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// N'exécute le serveur que si ce module est le point d'entrée (permet d'importer
// buildServer() depuis les tests sans démarrer un vrai listener réseau).
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  void main();
}
