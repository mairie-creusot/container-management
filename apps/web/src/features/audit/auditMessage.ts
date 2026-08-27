import type { AuditEvent } from "@/types";

/** Segment "identifiant" d'un path (ID Docker, nom...) — tronqué s'il ressemble à un hash long. */
export function shortId(segment: string | undefined): string {
  if (!segment) return "";
  return segment.length > 16 ? `${segment.slice(0, 12)}…` : decodeURIComponent(segment);
}

/**
 * Un même compte pouvait s'afficher sous deux libellés selon la façon dont la session avait été
 * ouverte ("BANAS Yann" au format de l'annuaire, "Yann Banas" pour une session forgée en script).
 * Le nom retenu est celui de l'annuaire : la connexion est le seul événement dont le libellé vient
 * toujours d'AD, on l'applique donc à toutes les lignes du même compte.
 */
export function directoryDisplayNames(events: AuditEvent[]): Map<string, string> {
  const byActor = new Map<string, string>();
  for (const event of [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    if (event.path === "/api/auth/login" && event.ok && event.actorDisplayName.trim()) {
      byActor.set(event.actor, event.actorDisplayName);
    }
  }
  return byActor;
}

/** Utilisé par le repli : de quoi parle cette famille de routes, en français. */
const RESOURCE_LABELS: Record<string, string> = {
  "3cx": "la téléphonie 3CX",
  "ad-dns": "la synchronisation DNS Active Directory",
  auth: "l'authentification",
  automation: "les automatisations",
  backups: "les sauvegardes programmées",
  certificates: "les certificats",
  containers: "les conteneurs",
  "cron-jobs": "les tâches planifiées",
  environments: "les environnements",
  github: "l'intégration GitHub",
  gitops: "GitOps",
  glpi: "l'assistance GLPI",
  hycu: "les sauvegardes HYCU",
  iac: "l'Infra-as-code",
  images: "les images",
  lxc: "l'hôte LXD",
  networks: "les réseaux",
  "notification-channels": "les canaux de notification",
  notifications: "les notifications",
  nutanix: "Nutanix",
  packages: "les paquets",
  plugins: "les modules",
  registries: "les registries",
  "remote-environments": "les environnements Docker distants",
  "reverse-proxy": "la publication",
  scan: "les scans de vulnérabilités",
  secrets: "les secrets",
  "service-modules": "les modules métier",
  setup: "la configuration",
  templates: "les templates",
  topology: "le graphe",
  volumes: "les volumes",
};

/** Famille de ressource d'un chemin ("/api/nutanix/vms/x" -> "nutanix") — base du filtre par
 * domaine de la page Traçabilité. Chaîne vide si le chemin n'en porte pas. */
export function resourceOf(path: string): string {
  return path.split("/").filter(Boolean)[1] ?? "";
}

/** Libellé français d'une famille, ou la famille brute si elle n'est pas encore nommée — jamais un
 * libellé inventé qui masquerait une famille inconnue. */
export function resourceLabelOf(resource: string): string {
  if (!resource) return "Autre";
  const label = RESOURCE_LABELS[resource];
  if (!label) return resource;
  // "les conteneurs" -> "Conteneurs" : le filtre affiche un nom, pas un fragment de phrase.
  const withoutArticle = label.replace(/^(les |le |la |l'|des |du )/i, "");
  return withoutArticle.charAt(0).toUpperCase() + withoutArticle.slice(1);
}

/** Ce qu'il faut d'un manifeste de greffon pour nommer ses actions dans le journal. */
export interface PluginAuditLabels {
  /** Nom lisible du greffon ("Virtualisation Nutanix"). */
  name: string;
  /** PluginManifest#auditLabels : identifiant d'action -> libellé français. */
  auditLabels: Record<string, string>;
}

/** Table id de greffon -> libellés, telle que la construit AuditPage depuis GET /api/plugins. */
export function pluginAuditLabels(
  plugins: readonly { manifest: { id: string; name: string; auditLabels?: Record<string, string> } }[],
): Map<string, PluginAuditLabels> {
  const byId = new Map<string, PluginAuditLabels>();
  for (const { manifest } of plugins) {
    byId.set(manifest.id, { name: manifest.name, auditLabels: manifest.auditLabels ?? {} });
  }
  return byId;
}

/**
 * Traduit une entrée du journal en phrase française. Aucun verbe HTTP ni chemin d'API ne doit
 * jamais apparaître à l'écran : une route non reconnue tombe sur un repli lisible, et le test
 * auditMessage.test.ts vérifie que TOUTES les routes mutantes réelles ont leur phrase.
 * Ne touche jamais au corps de la requête (jamais journalisé côté API — ces routes transportent
 * des identifiants et des mots de passe, voir services/auditLog.ts).
 *
 * `plugins` : libellés des manifestes RÉELLEMENT chargés (GET /api/plugins). Le canal d'exécution
 * générique (POST /api/plugins/:id/actions/:actionId) n'a que son chemin dans le journal — c'est
 * `auditLabels` du manifeste qui le nomme. Table absente (liste pas encore chargée, greffon retiré
 * depuis) : la phrase reste lisible, avec l'identifiant brut de l'action plutôt qu'un libellé
 * inventé.
 */
export function describeAction(event: AuditEvent, plugins?: ReadonlyMap<string, PluginAuditLabels>): string {
  const { method, path } = event;
  const segments = path.split("/").filter(Boolean); // ["api", "containers", ":id", "start"]
  const [, resource, idOrAction, subAction, subId] = segments;

  if (path === "/api/auth/login") return event.ok ? "s'est connecté(e)" : "a échoué à se connecter";
  if (path === "/api/auth/logout") return "s'est déconnecté(e)";
  if (path === "/api/auth/ldap-diagnose") return "a diagnostiqué un compte de l'annuaire";
  if (path === "/api/setup/complete") return "a modifié la configuration (assistant)";
  if (path === "/api/setup/reset") return "a réinitialisé l'assistant de configuration";
  if (path === "/api/setup/ldap") return "a modifié la configuration de l'annuaire LDAP";
  if (path.startsWith("/api/setup/test/")) return "a testé une connexion (assistant de configuration)";

  if (resource === "containers" && subAction === "processes" && segments[5]) {
    // Action sur UN processus vu depuis l'intérieur du conteneur (onglet Composition interne).
    const pid = segments[4];
    if (segments[5] === "kill") return `a tué le processus ${pid} dans le conteneur ${shortId(idOrAction)}`;
    if (segments[5] === "restart") return `a relancé le processus ${pid} dans le conteneur ${shortId(idOrAction)}`;
  }
  if (resource === "containers") {
    if (method === "POST" && !idOrAction) return "a déployé un conteneur";
    if (subAction === "start") return `a démarré le conteneur ${shortId(idOrAction)}`;
    if (subAction === "stop") return `a arrêté le conteneur ${shortId(idOrAction)}`;
    if (subAction === "restart") return `a redémarré le conteneur ${shortId(idOrAction)}`;
    if (subAction === "rename") return `a renommé le conteneur ${shortId(idOrAction)}`;
    if (subAction === "mounts") return `a modifié les montages du conteneur ${shortId(idOrAction)}`;
    if (subAction === "env") return `a modifié les variables d'environnement du conteneur ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé le conteneur ${shortId(idOrAction)}`;
  }
  if (resource === "volumes") {
    if (method === "POST") return "a créé un volume";
    if (method === "DELETE") return `a supprimé le volume "${shortId(idOrAction)}"`;
  }
  if (resource === "networks") {
    if (method === "POST" && !idOrAction) return "a créé un réseau";
    if (subAction === "connect") return `a connecté un conteneur au réseau ${shortId(idOrAction)}`;
    if (subAction === "disconnect") return `a déconnecté un conteneur du réseau ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé le réseau ${shortId(idOrAction)}`;
  }
  if (resource === "images") {
    if (idOrAction === "pull") return "a tiré une image";
    if (subAction === "update") return `a mis à jour l'image ${shortId(idOrAction)}`;
    if (subAction === "scan") return `a lancé un scan de vulnérabilités sur l'image ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé l'image ${shortId(idOrAction)}`;
  }
  if (resource === "registries") {
    if (method === "POST") return "a ajouté un registry";
    if (method === "PATCH") return `a modifié le registry ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé le registry ${shortId(idOrAction)}`;
  }
  if (resource === "secrets") {
    if (method === "POST") return "a créé un secret";
    if (method === "PATCH") return `a modifié le secret ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé le secret ${shortId(idOrAction)}`;
    if (subAction === "reveal") return `a révélé la valeur du secret ${shortId(idOrAction)}`;
  }
  if (resource === "cron-jobs") {
    if (method === "POST" && !idOrAction) return "a créé une tâche planifiée";
    if (subAction === "trigger") return `a déclenché manuellement la tâche planifiée ${shortId(idOrAction)}`;
    if (method === "PATCH") return `a modifié la tâche planifiée ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé la tâche planifiée ${shortId(idOrAction)}`;
  }
  if (resource === "backups") {
    if (method === "POST" && !idOrAction) return "a créé une sauvegarde programmée";
    if (subAction === "run") return `a lancé la sauvegarde ${shortId(idOrAction)}`;
    if (subAction === "restore") return `a restauré la sauvegarde ${shortId(idOrAction)} (exécution ${shortId(subId)})`;
    if (method === "PATCH") return `a modifié la sauvegarde ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé la sauvegarde ${shortId(idOrAction)}`;
  }
  if (resource === "iac") {
    const [, , , workspaceId, action] = segments;
    if (idOrAction === "lint") return "a vérifié la syntaxe d'un script Infra-as-code";
    if (method === "POST" && !workspaceId) return "a créé un workspace Infra-as-code";
    if (method === "PUT" && action === "files") return `a modifié un fichier du workspace Infra-as-code ${shortId(workspaceId)}`;
    if (method === "DELETE" && action === "files") return `a supprimé un fichier du workspace Infra-as-code ${shortId(workspaceId)}`;
    if (action === "run") return `a exécuté une action Infra-as-code sur le workspace ${shortId(workspaceId)}`;
    if (method === "DELETE" && !action) return `a supprimé le workspace Infra-as-code ${shortId(workspaceId)}`;
  }
  if (resource === "gitops" && idOrAction === "sync") return "a synchronisé GitOps";
  if (resource === "github") {
    if (path === "/api/github/token") return "a configuré le jeton d'accès GitHub";
    if (path === "/api/github/webhook") return "a reçu un événement GitHub (webhook)";
    if (path.endsWith("/deploy")) {
      const [, , , owner, repo] = segments;
      return `a déployé ${owner}/${repo} depuis GitHub`;
    }
    if (path.endsWith("/auto-deploy")) {
      const [, , , owner, repo] = segments;
      return `a configuré le déploiement automatique de ${owner}/${repo}`;
    }
    if (path.endsWith("/config-values")) {
      const [, , , owner, repo] = segments;
      // Les valeurs elles-mêmes ne sont jamais journalisées (elles peuvent référencer un secret).
      return `a modifié les variables de déploiement de ${owner}/${repo}`;
    }
    if (path.endsWith("/file-overrides")) {
      const [, , , owner, repo] = segments;
      return method === "DELETE"
        ? `a rétabli un fichier d'origine de ${owner}/${repo}`
        : `a surchargé un fichier de ${owner}/${repo} pour le déploiement`;
    }
  }
  if (resource === "notification-channels") {
    if (method === "POST" && !idOrAction) return "a créé un canal de notification";
    if (subAction === "test") return `a testé le canal de notification ${shortId(idOrAction)}`;
    if (method === "PATCH") return `a modifié le canal de notification ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé le canal de notification ${shortId(idOrAction)}`;
  }
  if (path === "/api/notifications/read-all") return "a marqué toutes les notifications comme lues";
  if (resource === "ad-dns") {
    if (idOrAction === "config" && method === "PUT") return "a configuré la synchronisation DNS Active Directory";
    if (idOrAction === "config" && method === "DELETE") return "a désactivé la synchronisation DNS Active Directory";
    if (idOrAction === "test") return "a testé la connexion DNS Active Directory";
  }
  if (resource === "nutanix") {
    if (idOrAction === "config" && method === "PUT") return "a configuré le cluster Nutanix";
    if (idOrAction === "config" && method === "DELETE") return "a désactivé le cluster Nutanix";
    if (idOrAction === "images" && subAction === "upload") return "a téléversé une image disque sur Nutanix";
    if (idOrAction === "images") return "a créé une image disque sur Nutanix";
    if (idOrAction === "vms") {
      if (subId === "start") return `a démarré la VM Nutanix ${shortId(subAction)}`;
      if (subId === "stop") return `a arrêté la VM Nutanix ${shortId(subAction)}`;
      if (subId === "restart") return `a redémarré la VM Nutanix ${shortId(subAction)}`;
      if (subId === "disks") return `a ajouté un disque à la VM Nutanix ${shortId(subAction)}`;
      // PATCH .../compute : vCPU, cœurs par vCPU et/ou mémoire (routes/nutanix.ts) — le corps n'est
      // jamais journalisé, donc on nomme ce qui est modifiable, pas la valeur choisie.
      if (subId === "compute") return `a modifié les ressources (vCPU/mémoire) de la VM Nutanix ${shortId(subAction)}`;
      if (subId === "migrate") return `a migré à chaud la VM Nutanix ${shortId(subAction)} vers un autre hôte`;
      if (subId === "nics") return `a ajouté une carte réseau à la VM Nutanix ${shortId(subAction)}`;
      if (method === "POST" && !subAction) return "a créé une VM Nutanix";
      if (method === "DELETE") return `a supprimé la VM Nutanix ${shortId(subAction)}`;
    }
  }
  if (resource === "plugins" && idOrAction) {
    if (idOrAction === "installed") {
      if (subId === "restore") return `a réinstallé le module « ${shortId(subAction)} » depuis l'image`;
      if (method === "POST") return "a installé un module";
      if (method === "DELETE") return `a désinstallé le module « ${shortId(subAction)} »`;
    }
    const plugin = plugins?.get(idOrAction);
    const pluginName = plugin?.name ?? idOrAction;
    if (subAction === "actions" && subId) {
      const actionId = decodeURIComponent(subId);
      const label = plugin?.auditLabels[actionId];
      // Le libellé du manifeste se suffit à lui-même ("Démarrer une VM Nutanix") — le greffon n'est
      // rappelé que lorsqu'aucun libellé n'est connu, pour que la ligne reste identifiable.
      return label ? `a exécuté « ${label} »` : `a exécuté l'action « ${actionId} » du module « ${pluginName} »`;
    }
    if (subAction === "config" && subId === "test") return `a testé la connexion du module « ${pluginName} »`;
    if (subAction === "config" && method === "PUT") return `a configuré le module « ${pluginName} »`;
    if (subAction === "config" && method === "DELETE") return `a retiré la configuration du module « ${pluginName} »`;
    // Le corps de la requête n'est jamais journalisé (il peut porter un secret) : le sens de la
    // bascule n'est donc pas connu ici, et on ne l'invente pas.
    if (subAction === "enabled") return `a changé l'activation du module « ${pluginName} »`;
  }
  if (resource === "glpi" && idOrAction === "tickets" && subId === "followup") {
    return `a ajouté un suivi au ticket GLPI ${shortId(subAction)}`;
  }
  if (resource === "windows" && idOrAction === "services" && subId) {
    const service = shortId(subAction);
    if (subId === "start") return `a démarré le service Windows « ${service} »`;
    if (subId === "stop") return `a arrêté le service Windows « ${service} »`;
  }
  if (resource === "lxc") {
    if (idOrAction === "config" && method === "PUT") return "a configuré l'hôte LXD";
    if (idOrAction === "config" && method === "DELETE") return "a désactivé l'hôte LXD";
  }
  if (resource === "remote-environments") {
    if (method === "POST") return "a ajouté un environnement Docker distant";
    if (method === "PATCH") return `a modifié l'environnement Docker distant ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé l'environnement Docker distant ${shortId(idOrAction)}`;
  }
  if (resource === "reverse-proxy") {
    if (idOrAction === "routes" && method === "POST" && !subAction) return "a publié un service (route de reverse proxy)";
    if (idOrAction === "routes" && subId === "resync-dns") return `a retesté la synchronisation DNS de la route ${shortId(subAction)}`;
    if (idOrAction === "routes" && method === "DELETE") return `a retiré la publication ${shortId(subAction)}`;
    if (idOrAction === "push") return "a repoussé la configuration vers Caddy";
  }
  if (resource === "certificates") {
    if (idOrAction === "config" && subAction === "test") return "a testé la connexion à l'autorité de certification";
    if (idOrAction === "config" && method === "PUT") return "a configuré l'autorité de certification AD CS";
    if (idOrAction === "config" && method === "DELETE") return "a désactivé l'autorité de certification AD CS";
    if (idOrAction === "issue") return "a demandé l'émission d'un certificat";
    if (method === "DELETE") return `a retiré le certificat de ${shortId(idOrAction)}`;
  }
  if (resource === "hycu" || resource === "glpi" || resource === "3cx") {
    const what =
      resource === "hycu"
        ? "des sauvegardes HYCU"
        : resource === "glpi"
          ? "de l'assistance GLPI"
          : "de la téléphonie 3CX";
    if (idOrAction === "config" && subAction === "test") return `a testé la connexion ${what}`;
    if (idOrAction === "config" && method === "PUT") return `a configuré l'intégration ${what}`;
    if (idOrAction === "config" && method === "DELETE") return `a désactivé l'intégration ${what}`;
    if (resource === "glpi" && idOrAction === "inventory") {
      if (method === "POST") return "a créé une fiche d'inventaire GLPI";
      if (method === "PATCH") return `a réconcilié la fiche d'inventaire GLPI ${shortId(subId)}`;
    }
  }
  if (resource === "templates") {
    if (idOrAction === "build-defaults") return "a modifié les valeurs par défaut de construction des templates";
    if (subAction === "build") return `a lancé la construction du template ${shortId(idOrAction)}`;
    if (subAction === "validate") return `a vérifié le template ${shortId(idOrAction)}`;
    if (method === "POST" && !idOrAction) return "a créé un template";
    if (method === "PUT") return `a modifié le template ${shortId(idOrAction)}`;
    if (method === "DELETE") return `a supprimé le template ${shortId(idOrAction)}`;
  }
  if (resource === "service-modules" && idOrAction === "bindings") {
    if (method === "PUT") return "a rattaché un module métier à un nœud";
    if (method === "DELETE") return `a détaché le module métier du nœud ${shortId(subAction)}`;
  }
  if (resource === "automation") {
    if (idOrAction === "nodes" && method === "POST") return "a ajouté une étape d'automatisation";
    if (idOrAction === "nodes" && method === "DELETE") return `a supprimé l'étape d'automatisation ${shortId(subAction)}`;
    if (idOrAction === "edges" && method === "POST") return "a relié deux étapes d'automatisation";
    if (idOrAction === "edges" && method === "DELETE") return "a supprimé un lien entre étapes d'automatisation";
  }
  if (resource === "topology") {
    if (idOrAction === "positions") return "a réorganisé le graphe (positions des nœuds)";
    if (idOrAction === "groups" && subId === "positions") return `a réorganisé le groupe ${shortId(subAction)}`;
    if (idOrAction === "groups" && method === "POST") return "a regroupé des nœuds";
    if (idOrAction === "groups" && method === "PATCH") return `a modifié le groupe ${shortId(subAction)}`;
    if (idOrAction === "groups" && method === "DELETE") return `a dissocié le groupe ${shortId(subAction)}`;
  }

  const label = RESOURCE_LABELS[resource ?? ""];
  return label ? `a effectué une action sur ${label}` : "a effectué une action d'administration";
}
