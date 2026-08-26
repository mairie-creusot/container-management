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
import { loadActivePlugins } from "./plugins/loader.js";
import adDnsRoutes from "./routes/adDns.js";
import auditRoutes from "./routes/audit.js";
import authRoutes from "./routes/auth.js";
import automationRoutes from "./routes/automation.js";
import backupsRoutes from "./routes/backups.js";
import certificatesRoutes from "./routes/certificates.js";
import consoleRoutes from "./routes/console.js";
import containerLogsRoutes from "./routes/containerLogs.js";
import containersRoutes from "./routes/containers.js";
import cronJobsRoutes from "./routes/cronJobs.js";
import environmentsRoutes from "./routes/environments.js";
import githubRoutes from "./routes/github.js";
import githubWebhookRoutes from "./routes/githubWebhook.js";
import gitopsRoutes from "./routes/gitops.js";
import glpiRoutes from "./routes/glpi.js";
import glpiInventoryRoutes from "./routes/glpiInventory.js";
import hycuRoutes from "./routes/hycu.js";
import iacRoutes from "./routes/iac.js";
import imagesRoutes from "./routes/images.js";
import lxcRoutes from "./routes/lxc.js";
import metricsRoutes from "./routes/metrics.js";
import networksRoutes from "./routes/networks.js";
import notificationChannelsRoutes from "./routes/notificationChannels.js";
import notificationsRoutes from "./routes/notifications.js";
import nutanixRoutes from "./routes/nutanix.js";
import registriesRoutes from "./routes/registries.js";
import remoteEnvironmentsRoutes from "./routes/remoteEnvironments.js";
import reverseProxyRoutes from "./routes/reverseProxy.js";
import scanRoutes from "./routes/scan.js";
import secretsRoutes from "./routes/secrets.js";
import serviceModulesRoutes from "./routes/serviceModules.js";
import setupRoutes from "./routes/setup.js";
import templatesRoutes from "./routes/templates.js";
import threecxRoutes from "./routes/threecx.js";
import packagesRoutes from "./routes/packages.js";
import pluginsRoutes from "./routes/plugins.js";
import topologyRoutes from "./routes/topology.js";
import volumesRoutes from "./routes/volumes.js";
import { startAutomationEngine } from "./services/automationEngine.js";
import { startBackupScheduler } from "./services/backupScheduler.js";
import { startCertificatesReconciler } from "./services/certificatesReconciler.js";
import { startCrlRefresher, stopCrlRefresher } from "./services/crlRefresher.js";
import { startCronJobsScheduler } from "./services/cronJobsScheduler.js";
import { startGitopsReconciler } from "./services/gitopsReconciler.js";
import { startMetricsCollector } from "./services/metricsCollector.js";
import { startReverseProxyReconciler } from "./services/reverseProxyReconciler.js";
import { startScanScheduler } from "./services/scanScheduler.js";
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

  // Greffons d'intégration : chargés À LA DEMANDE juste avant que le serveur ne serve, et
  // UNIQUEMENT ceux qui ne sont pas en pause (voir plugins/loader.ts). Un `onReady` plutôt qu'un
  // appel ici : l'état d'activation se lit sur le disque, donc de façon asynchrone. Le chargeur ne
  // lève jamais — un greffon fâché ne doit pas empêcher l'API de démarrer.
  fastify.addHook("onReady", async () => {
    const outcome = await loadActivePlugins();
    for (const failure of outcome.failed) {
      fastify.log.error(`Greffon "${failure.id}" non chargé : ${failure.reason}`);
    }
    if (outcome.paused.length > 0) {
      fastify.log.info(`Greffons en pause, non chargés : ${outcome.paused.join(", ")}`);
    }
  });

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
  void fastify.register(templatesRoutes);
  void fastify.register(packagesRoutes);
  void fastify.register(topologyRoutes);
  void fastify.register(notificationsRoutes);
  void fastify.register(nutanixRoutes);
  void fastify.register(hycuRoutes);
  void fastify.register(glpiRoutes);
  void fastify.register(glpiInventoryRoutes);
  void fastify.register(threecxRoutes);
  void fastify.register(remoteEnvironmentsRoutes);
  void fastify.register(lxcRoutes);
  void fastify.register(reverseProxyRoutes);
  void fastify.register(adDnsRoutes);
  void fastify.register(certificatesRoutes);
  void fastify.register(consoleRoutes);
  void fastify.register(githubRoutes);
  void fastify.register(githubWebhookRoutes);
  void fastify.register(containerLogsRoutes);
  void fastify.register(notificationChannelsRoutes);
  void fastify.register(metricsRoutes);
  void fastify.register(cronJobsRoutes);
  void fastify.register(backupsRoutes);
  void fastify.register(automationRoutes);
  void fastify.register(serviceModulesRoutes);
  void fastify.register(pluginsRoutes);

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

  // Republication de la config du reverse proxy au démarrage (Caddy peut démarrer après l'API,
  // d'où les réessais) puis réconciliation périodique — la config de Caddy ne vit qu'en mémoire
  // et disparaît à chaque redémarrage de celui-ci (voir services/reverseProxyReconciler.ts).
  const stopReverseProxyReconciler = startReverseProxyReconciler();

  // Renouvellement automatique des certificats AD CS avant expiration + première émission pour les
  // sous-domaines qui n'en ont pas encore (voir services/certificatesReconciler.ts) : même câblage,
  // démarré seulement ici pour ne jamais contacter l'autorité de certification pendant les tests.
  const stopCertificatesReconciler = startCertificatesReconciler();

  // Rapatriement des listes de révocation de l'autorité, pour les certificats qui habilitent les
  // modules (voir services/crlRefresher.ts). SEUL endroit du dispositif qui touche au réseau : la
  // vérification, elle, ne lit que des fichiers déjà posés. Ne démarre pas sans PLUGIN_CRL_URLS.
  startCrlRefresher();

  // Scan automatique en tâche de fond des images RÉELLEMENT déployées (conteneurs running) qui
  // n'ont jamais été scannées ou dont le dernier scan réussi est trop ancien (voir
  // services/scanScheduler.ts — cron de rafraîchissement périodique, PAS un edge-triggered comme
  // le watchdog ci-dessus) : même câblage, démarré seulement ici pour ne jamais lancer de vrai
  // scan Grype/OSV-Scanner pendant les tests qui construisent juste le serveur avec `app.inject`.
  const stopScanScheduler = startScanScheduler();

  // Scrape périodique des métriques CPU/mémoire de tous les conteneurs `running` (voir
  // services/metricsCollector.ts, priorité #5 du rapport concurrentiel) : même câblage que les
  // schedulers ci-dessus, démarré seulement ici pour ne jamais taper `docker stats` en boucle
  // pendant les tests qui construisent juste le serveur avec `app.inject`.
  const stopMetricsCollector = startMetricsCollector();

  // Tick périodique des cron jobs (voir services/cronJobsScheduler.ts, priorité #6 du rapport
  // concurrentiel) : même câblage, démarré seulement ici pour ne jamais déclencher de vrai
  // `docker exec` pendant les tests.
  const stopCronJobsScheduler = startCronJobsScheduler();

  // Sauvegardes automatiques de volumes/bases de données vers un stockage S3-compatible (voir
  // services/backupScheduler.ts, priorité #4 du rapport concurrentiel) : cron minimal évalué
  // toutes les minutes, exécution réelle (tar/pg_dump/mysqldump/mongodump + upload S3) — même
  // câblage que les schedulers ci-dessus, démarré seulement ici pour ne jamais déclencher de
  // vraie sauvegarde réseau pendant les tests qui construisent juste le serveur avec `app.inject`.
  const stopBackupScheduler = startBackupScheduler();

  // Moteur d'automatisation (trigger -> condition -> action, voir services/automationEngine.ts) :
  // même câblage que les schedulers ci-dessus, démarré seulement ici pour ne jamais évaluer un
  // vrai trigger (sonde TCP réelle, lecture de topologie) ni exécuter une vraie action (docker
  // exec, envoi de notification, start/stop/restart conteneur) pendant les tests qui construisent
  // juste le serveur avec `app.inject`.
  const stopAutomationEngine = startAutomationEngine();

  // Sans ceci, un SIGTERM (docker stop, ou nodemon qui redémarre le process en dev) tue le
  // process sans libérer explicitement le port avant que le suivant ne démarre — source
  // d'EADDRINUSE intermittents observés avec `nodemon --legacy-watch` (voir package.json,
  // nécessaire pour que le hot-reload fonctionne à travers le bind mount Windows -> Docker).
  const shutdown = (signal: string) => {
    fastify.log.info(`${signal} received, closing server`);
    stopWatchdog();
    stopGitopsReconciler();
    stopReverseProxyReconciler();
    stopCertificatesReconciler();
    stopCrlRefresher();
    stopScanScheduler();
    stopMetricsCollector();
    stopCronJobsScheduler();
    stopBackupScheduler();
    stopAutomationEngine();
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
