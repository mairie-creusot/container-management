# QUAI — Architecture

Alternative moderne et ciblée à Portainer. Concept validé (voir artifacts de cadrage). Ce document est le contrat partagé entre les modules du monorepo : toute personne (ou agent) qui implémente une brique doit s'y tenir pour que les briques s'assemblent sans réécriture.

## Vision & périmètre

Quatre priorités, rien de plus dans ce premier lot :

1. **Registries multi-sources** — Docker Hub, GHCR, GitLab Registry, Harbor. Lister les images locales et distantes, comparer tag courant / dernier tag disponible.
2. **Mises à jour d'images** — détection des nouvelles versions, action de mise à jour explicite (jamais automatique).
3. **GitOps** — le dépôt Git est la seule source de vérité. Le contrôleur compare l'état désiré (manifestes) à l'état réel (cluster) et affiche la dérive ; l'application du changement reste une action explicite depuis l'UI.
4. **Swarm + Kubernetes** — les deux orchestrateurs cohabitent (migration en cours pour l'utilisateur cible), mêmes écrans, sélecteur d'environnement.

Ajout validé : **authentification LDAP** (annuaire de la mairie) comme méthode de connexion principale, avec mapping de groupes LDAP → rôles applicatifs.

Ajout validé : **Nutanix** comme troisième type d'environnement géré, au même niveau que Docker/Swarm et Kubernetes — pilotage d'un cluster Nutanix réel via l'API REST v3 de Prism Central (https://www.nutanix.dev/api-reference/), visualisation des VMs.

Ajout validé (en cours, voir « Environnements Docker distants »/« Support LXC (via LXD) ») : **environnements Docker distants** (TCP+TLS, un ou plusieurs, en plus du démon local) et **LXC via LXD** comme quatrième/cinquième types d'environnement gérés — la lecture des conteneurs/volumes/networks d'un hôte Docker distant précis est câblée bout-en-bout ; les actions d'écriture distantes, la topologie complète et l'UI LXC restent à faire (chantier volontairement non fini à 100% dans cette passe, voir les deux chapitres dédiés pour le détail précis de la frontière).

## Stack

- **apps/web** — TypeScript, React, Redux Toolkit, Vite. Terminal interactif : [xterm.js](https://xtermjs.org/) (`@xterm/xterm` + `@xterm/addon-fit`) pour la console conteneur.
- **apps/api** — TypeScript, Node.js (Fastify), pilote Docker Engine/Swarm (dockerode), Kubernetes (@kubernetes/client-node) et Nutanix (API REST v3 de Prism Central, `node:https`), clients registries, moteur GitOps, auth LDAP (ldapjs) + session JWT. WebSocket : `@fastify/websocket` (route console conteneur, voir « Console interactive dans un conteneur »).
- **packages/wasm-core** — Rust compilé en WebAssembly (wasm-pack) : diff de manifestes YAML (état désiré vs état réel) et hachage de comparaison, exposé en TS via un wrapper généré. Utilisé côté `api` (calcul de dérive) et potentiellement côté `web` (aperçu diff instantané).
- **deploy** — Dockerfiles, docker-compose de dev, manifestes Kubernetes/Swarm d'exemple, pipeline GitHub Actions → GHCR.

## Layout du monorepo

```
apps/
  api/            # serveur Fastify, intégrations Docker/K8s/registries/LDAP
  web/            # UI React/Redux (porte le prototype d'artifact validé)
packages/
  wasm-core/      # crate Rust + wasm-pack + wrapper TS (@quai/wasm-core)
deploy/
  docker/         # Dockerfile api, Dockerfile web
  compose/        # docker-compose.dev.yml
  k8s/            # manifestes d'exemple
  swarm/          # stack.yml d'exemple
.github/workflows/  # build + push GHCR
```

Chaque module ne modifie que son propre sous-arbre. Les points de contact (contrats de données, interface WASM) sont figés ci-dessous pour éviter toute dépendance croisée en cours de développement.

## Contrats de données (partagés web ↔ api)

```ts
type RegistryKind = "dockerhub" | "ghcr" | "gitlab" | "harbor";

interface ImageRef {
  id: string;
  name: string;              // ex: "nginx" ou "ghcr.io/ville-lecreusot/portail-citoyen"
  registry: RegistryKind;
  currentTag: string;
  latestTag: string;
  environment: string;       // nom de l'environnement où l'image tourne
  status: "update" | "uptodate";
  digest: string;
  sizeBytes: number;
  layers: number;
}

interface Registry {
  id: string;
  kind: RegistryKind;
  name: string;
  url: string;
  status: "connected" | "unconfigured" | "error";
  trackedImages: number;
  lastSyncAt: string | null;  // ISO 8601
  statusDetail?: string;      // raison concrète de "error" (ex: "GHCR : identifiants invalides ou expirés (401)")
  org?: string;                // organisation GitHub (ghcr) / namespace-compte (dockerhub) EXPLICITE, indépendant
                                // de `username` (identité de connexion) — pas un secret. Voir « Assistant de
                                // configuration » ci-dessous, SetupRegistryConfig#org.
}

interface ContainerRef {
  id: string;
  name: string;
  image: string;
  environment: string;
  node: string;
  state: "running" | "restarting" | "stopped";
  cpuPercent: number;
  memBytes: number;
}

// Composition interne d'un conteneur (voir « Graphe de topologie » plus bas, vue "composition
// interne" du sous-graphe) — UNIQUEMENT ce que Docker expose réellement, rien d'inventé sur
// l'architecture applicative (impossible à connaître sans tracing applicatif, hors périmètre).

/** GET /api/containers/:id/processes — équivalent `docker top <id>`. `titles` reflète les
 * colonnes RÉELLES retournées par le démon (dépend de la commande `ps` de l'image cible, pas un
 * schéma fixe imposé côté QUAI) ; `processes` porte une entrée par ligne, alignée avec `titles`. */
interface ContainerProcessList {
  titles: string[];
  processes: string[][];
}

/** GET /api/images/:id/history — équivalent `docker history <image>`. `id` vaut souvent
 * "<missing>" pour une couche intermédiaire (comportement natif Docker, pas une anomalie). */
interface ImageHistoryLayer {
  id: string;
  createdAt: string;             // ISO 8601, chaîne vide si le démon ne l'a pas fournie
  createdBy: string;             // commande Dockerfile telle que Docker la restitue (déjà tronquée par le démon)
  sizeBytes: number;
  comment: string;
}

// Explorateur de fichiers d'un volume (lecture seule) — voir chapitre dédié plus bas.
interface VolumeFileEntry {
  name: string;
  path: string;                 // relatif à la racine du volume, POSIX, toujours préfixé par "/"
  isDirectory: boolean;
  sizeBytes: number;
  modifiedAt: string;           // ISO 8601 ; chaîne vide si le mtime n'a pas pu être déterminé
}

interface ClusterNode {
  id: string;
  environmentId: string;
  role: string;               // manager | worker | control-plane | standalone
  cpuPercent: number;
  memPercent: number;
  status: "ok" | "warn" | "crit";
  containerCount: number;
}

interface Environment {
  id: string;
  name: string;
  orchestrator: "swarm" | "kubernetes" | "compose" | "nutanix" | "docker-remote" | "lxc";
  status: "ok" | "warn";
  nodes: ClusterNode[];
}

interface NutanixVm {
  id: string;
  name: string;
  powerState: "on" | "off" | "unknown";
  numVcpus: number;
  memoryMib: number;
  cluster: string;              // nom du cluster Nutanix physique hébergeant la VM
}

// Environnements Docker distants — voir « Environnements Docker distants » plus bas.
// ca/cert/key ne transitent JAMAIS par ce contrat une fois enregistrés (write-only) :
// seul `hasTls` indique leur présence.
interface RemoteDockerEnvironmentRef {
  id: string;
  name: string;
  host: string;
  port: number;
  hasTls: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RemoteDockerTestResult {
  ok: boolean;
  message: string;
}

// Support LXC (via LXD) — voir « Support LXC (via LXD) » plus bas.
interface LxcContainer {
  name: string;
  status: string;                // reflète tel quel le champ "status" de l'API LXD (ex: "Running")
  architecture: string;
  createdAt: string;
  type: string;                  // "container" | "virtual-machine"
}

interface GitOpsFile {
  path: string;                 // ex: "prod/nginx.yaml"
  desiredManifest: string;      // YAML brut
  actualManifest: string;       // YAML brut reconstruit depuis le cluster
  drift: boolean;
}

interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;                 // ISO 8601
}

// Gestionnaire de secrets nommés (façon Vault/GitHub Actions secrets) — voir chapitre
// "Gestionnaire de secrets" plus bas. La valeur elle-même n'apparaît JAMAIS dans ce contrat.
interface SecretRef {
  id: string;
  name: string;                 // clé de référence unique, utilisée par secretEnv à la création d'un conteneur
  description?: string;
  createdAt: string;            // ISO 8601
  updatedAt: string;            // ISO 8601
}

interface Session {
  username: string;
  displayName: string;
  roles: ("admin" | "operator" | "viewer")[];
}

// Reverse proxy interne (façon Portainer + un vrai reverse proxy devant) — voir chapitre
// "Reverse proxy interne" plus bas. Une route cible soit un conteneur géré par QUAI (IP résolue
// en direct sur le réseau Docker à chaque push vers Caddy, jamais figée), soit un host:port
// arbitraire.
interface ReverseProxyRoute {
  id: string;
  subdomain: string;            // ex: "monapp.lecreusot.priv" — matché sur l'en-tête Host par Caddy
  targetContainerId?: string;
  targetHost?: string;
  targetPort: number;
  createdAt: string;            // ISO 8601
}

/** GET /api/reverse-proxy/status — même pattern que ScannerStatus. */
interface ReverseProxyStatus {
  reachable: boolean;
  adminUrl: string;
}

type SystemNotificationKind = "image_update_available" | "integration_unreachable" | "integration_reachable" | "gitops_drift_detected" | "vulnerability_detected";

interface SystemNotificationEvent {
  id: string;
  timestamp: string;            // ISO 8601
  kind: SystemNotificationKind;
  level: "error" | "success" | "info";
  message: string;              // concret et actionnable, ex: "Nouvelle version disponible pour nginx:1.25 -> 1.27"
  read: boolean;
}

// Scan de vulnérabilités — QUAI pilote les VRAIS binaires Grype (anchore/grype) ET OSV-Scanner
// (google/osv-scanner, tous deux Apache-2.0) en sous-processus (voir apps/api/src/services/
// scan.ts) : les deux scanners coexistent, un seul historique de scans par image, chaque entrée
// sait de quel scanner elle vient.
type ScannerId = "grype" | "osv-scanner";

interface ScannerStatus {
  scanner: ScannerId;
  available: boolean;
  version: string | null;
}

type VulnSeverity = "Critical" | "High" | "Medium" | "Low" | "Negligible" | "Unknown";

interface Vulnerability {
  id: string;                   // ex: "CVE-2023-1255", ou "GHSA-..."/"DEBIAN-CVE-..." pour OSV-Scanner
  severity: VulnSeverity;
  packageName: string;
  installedVersion: string;
  fixedInVersion: string | null;
}

// "manual" (clic operator/admin, ImagesPage.tsx) vs "automatic" (services/scanScheduler.ts, voir
// « Scan automatique des images déployées » plus bas) — optionnel pour rester lisible sur les
// scans persistés avant l'introduction de ce champ (undefined = "manual", comportement historique).
type ScanTrigger = "manual" | "automatic";

interface ScanResult {
  id: string;
  scanner: ScannerId;           // scanner à l'origine de ce résultat
  image: string;                // référence Docker passée au scanner, ex: "nginx:1.27"
  status: "running" | "success" | "failed";
  startedAt: string;            // ISO 8601
  finishedAt: string | null;
  vulnerabilities: Vulnerability[];
  summary: Record<VulnSeverity, number>;
  trigger?: ScanTrigger;
}

// Graphe de topologie (voir chapitre dédié plus bas) — nœuds "conteneur"/"volume"/"network"
// (Docker) + "nutanix-vm" (VMs Nutanix, ajouté en même temps que GET /api/nutanix/vms ci-dessous).
type TopologyNodeKind = "container" | "volume" | "network" | "nutanix-vm";

interface TopologyNode {
  id: string;                   // ex: "container:<id>", "volume:<name>", "network:<id>", "nutanix-vm:<uuid>"
  kind: TopologyNodeKind;
  label: string;
  subtitle: string;             // image/driver pour Docker, cluster physique pour une VM Nutanix
  status: "running" | "stopped" | "restarting" | "neutral";
  cpuPercent?: number;
  memBytes?: number;
  updateAvailable?: boolean;    // rapproché de GET /api/images (status "update") par "name:tag"
  drift?: boolean;              // rapproché de GET /api/gitops/files (drift=true) par nom de fichier ~ nom de conteneur
  // Rapprochés du DERNIER scan RÉUSSI connu (Grype et/ou OSV-Scanner) pour l'image "name:tag" du
  // conteneur — absents (pas 0) si aucun scan n'a jamais tourné pour cette image. Règle si les
  // deux scanners ont chacun un dernier scan réussi : le plus sévère l'emporte (MAX des comptes
  // Critical d'un côté, High de l'autre) — voir apps/api/src/services/topology.ts#vulnSummaryForImage.
  vulnCritical?: number;
  vulnHigh?: number;
  // Conteneurs uniquement : état de santé Docker NATIF (`State.Health.Status`, résolu par un
  // inspect() par conteneur — apps/api/src/services/docker.ts#readContainerHealth). "none" si
  // l'image ne définit aucune instruction HEALTHCHECK : résultat honnête et attendu pour la
  // plupart des conteneurs de ce projet, jamais une valeur fabriquée par convention de port/
  // chemin "/health" deviné (non implémenté volontairement, voir « Santé des conteneurs » plus bas).
  healthStatus?: "healthy" | "unhealthy" | "starting" | "none";
  numVcpus?: number;            // VMs Nutanix uniquement
  memoryMib?: number;           // VMs Nutanix uniquement
}
```

## Authentification LDAP

- `POST /api/auth/login` — `{ username, password }` → bind LDAP (`ldapjs`) contre l'annuaire configuré par variables d'environnement (`LDAP_URL`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`, `LDAP_SEARCH_BASE`, `LDAP_SEARCH_FILTER`).
- Après bind réussi, recherche des groupes de l'utilisateur (`memberOf` ou requête inverse selon l'annuaire) et mapping vers les rôles applicatifs via `LDAP_GROUP_ROLE_MAP` (JSON en variable d'environnement, ex: `{"cn=dsi-admins,ou=groupes,dc=lecreusot,dc=fr":"admin"}`).
- Émission d'un JWT de session (cookie `httpOnly`, `secure`, `sameSite=strict`) contenant `username`, `roles`, expiration courte + refresh.
- `viewer` : lecture seule. `operator` : peut déclencher mises à jour d'image et resynchronisations GitOps. `admin` : + gestion des registries et des accès.
- Aucune donnée LDAP (mot de passe compris) n'est journalisée ni mise en cache au-delà de la session.

## Interface WASM (`@quai/wasm-core`)

Contrat minimal pour que `apps/api` et `packages/wasm-core` puissent être développés indépendamment :

```ts
// packages/wasm-core — API exposée après wasm-pack build
export function diffManifests(desiredYaml: string, actualYaml: string): DiffResult;

interface DiffLine {
  kind: "context" | "add" | "remove";
  text: string;
}
interface DiffResult {
  lines: DiffLine[];
  hasDrift: boolean;
}
```

`apps/api` importe ce package par son nom (`@quai/wasm-core`) sans connaître son implémentation interne. Tant que la signature ci-dessus est respectée, les deux modules s'intègrent sans coordination supplémentaire.

## Secrets au repos

Tout secret persisté dans `config.json` (mot de passe LDAP, kubeconfig, mot de passe Nutanix, identifiants de registry) est chiffré avec AES-256-GCM avant écriture disque (`apps/api/src/services/crypto.ts`) — la clé vient de `CONFIG_ENCRYPTION_KEY` (jamais stockée dans le même fichier que ce qu'elle protège), obligatoire en production, à défaut d'une clé aléatoire éphémère en développement (avertissement explicite au démarrage). Un `config.json` écrit avant l'introduction de ce chiffrement est migré automatiquement (rechiffré et réécrit) au premier accès suivant. Le fichier est aussi écrit avec des permissions restrictives (`0600`). Voir `apps/api/.env.example` pour la génération de la clé.

## Gestionnaire de secrets

Console de secrets nommés façon Vault/GitHub Actions secrets (`apps/api/src/services/secretsStore.ts`, `apps/api/src/routes/secrets.ts`, `apps/web/src/features/secrets/`) : un admin définit une valeur une seule fois sous un nom unique, cette valeur est ensuite référencée **par nom** lors de la création d'un conteneur — jamais retapée, jamais exposée dans le navigateur après sa saisie initiale.

**Persistance** : `apps/api/data/secrets.json` (chemin `SECRETS_PATH`, même répertoire et même pattern que `config.json` — cache mémoire process invalidé à chaque écriture, fichier `0600`). Réutilise **exactement** le mécanisme de chiffrement au repos ci-dessus (`crypto.ts`, AES-256-GCM, `CONFIG_ENCRYPTION_KEY`) — aucun nouveau mécanisme introduit. `name` sert de clé de référence : unique, vérifié à la création et au renommage (`409` en cas de collision).

**Write-only côté API** : `GET /api/secrets` (liste) ne renvoie jamais la valeur, seulement `id/name/description/createdAt/updatedAt` (`SecretRef`, voir « Contrats de données »). Aucune route ne l'expose jamais, sous aucune forme — seule une fonction interne non exposée (`getDecryptedSecretValue(name)`) la déchiffre, réservée à la résolution serveur lors de la création d'un conteneur. `PATCH /api/secrets/:id` avec `value` omise ou vide conserve la valeur déjà enregistrée (même convention que `password`/`token` sur `PATCH /api/registries/:id`).

**Rôle requis** : un secret est plus sensible qu'un registry — les 3 routes mutantes (`POST`/`PATCH`/`DELETE`) exigent explicitement le rôle `admin` (403 sinon), au-delà du operator/admin déjà exigé par le hook global pour toute méthode mutante. `GET /api/secrets` reste ouvert à toute session authentifiée (nécessaire pour peupler le sélecteur de secrets du formulaire de création de conteneur, y compris pour un `operator`).

**Intégration à la création de conteneur** : `POST /api/containers` accepte, en plus de `env?: string[]` (texte brut, inchangé), un champ optionnel `secretEnv?: { key: string; secretName: string }[]`. Résolu **côté serveur uniquement**, avant tout appel Docker : chaque `secretName` est déchiffré et fusionné en `"${key}=${valeur}"` dans l'`Env` final. Un `secretName` introuvable fait échouer toute la requête en `400` (`Secret "X" not found`) — jamais de conteneur créé avec un environnement partiellement résolu. Aucune valeur de secret n'est jamais journalisée (audit log, console) : `plugins/audit.ts` ne trace que method/path/statusCode/acteur, jamais le corps de la requête.

## Reverse proxy interne

Chaque conteneur géré par QUAI peut être exposé sous un sous-domaine interne (`*.lecreusot.priv`) via un **VRAI** reverse proxy — [Caddy](https://caddyserver.com) (Apache-2.0) — piloté en direct par QUAI, même philosophie que OpenTofu/Ansible/Packer/Grype/OSV-Scanner déjà intégrés dans ce projet : aucune réimplémentation d'un serveur HTTP/proxy.

**Mécanisme retenu — API d'administration JSON de Caddy, pas de Caddyfile généré.** Caddy expose une API d'admin en direct sur `:2019` (`POST /load`, voir https://caddyserver.com/docs/api) qui accepte la configuration **complète** du serveur en JSON et la remplace atomiquement en mémoire, sans jamais toucher au disque ni redémarrer le process. `apps/api/src/services/reverseProxy.ts#pushConfigToCaddy()` reconstruit cette configuration complète (un serveur HTTP `quai` écoutant sur `:80`, une route par sous-domaine actif, chacune avec un handler `reverse_proxy` vers l'upstream résolu) et la pousse à chaque création/suppression de route — jamais de fichier Caddyfile écrit, jamais de `caddy reload`. `pushConfigToCaddy()` est réutilisable et rejouable manuellement (`POST /api/reverse-proxy/push`), utile après un redémarrage de Caddy qui repartirait de son Caddyfile de bootstrap minimal (`deploy/compose/caddy/Caddyfile`, qui ne sert qu'à démarrer Caddy avec son admin API accessible sur le réseau docker-compose — `admin 0.0.0.0:2019`, le défaut `localhost:2019` étant injoignable depuis les autres conteneurs).

**Résolution de cible.** `targetContainerId` n'est jamais résolu en IP à la création puis figé : l'IP réelle du conteneur sur le réseau Docker (`docker.ts#getContainerNetworkAddress`, dockerode) est relue à **chaque** push vers Caddy, pour ne jamais casser une route quand le conteneur cible est recréé/redémarré (nouvelle IP à chaque fois côté Docker — utiliser une IP statique aurait cassé la route au premier redémarrage). Une route peut aussi cibler un `targetHost:targetPort` arbitraire (cas générique, hors conteneurs QUAI). Un conteneur cible introuvable/arrêté au moment du push voit sa route simplement omise de la config envoyée à Caddy (les autres routes actives restent fonctionnelles) — elle revient automatiquement au push suivant une fois le conteneur de nouveau joignable.

**Persistance** : `apps/api/data/reverse-proxy.json` (chemin `REVERSE_PROXY_PATH`), même répertoire et même pattern que `secrets.json` (cache mémoire process invalidé à chaque écriture, fichier `0600`) — aucune valeur sensible dans une route, donc pas de chiffrement au repos nécessaire ici contrairement à `secretsStore.ts`.

**Piège vérifié en conditions réelles — liste blanche `origins` de l'admin API.** Caddy rejette par défaut (`403`) toute requête admin dont l'en-tête `Host` ne fait pas partie d'une liste blanche qui ne connaît nativement que `localhost`/`127.0.0.1`/`::1` — un nom de service docker-compose comme `caddy:2019` (ce que QUAI utilise forcément pour joindre Caddy depuis `quai-dev-api-1`) en est absent par défaut. `pushConfigToCaddy()` réinclut donc explicitement `admin.origins` (l'autorité de `CADDY_ADMIN_URL` + les variantes localhost) à chaque `/load`, sinon toute mutation de route échouerait silencieusement côté Caddy malgré une route correctement persistée côté QUAI.

**Échec de push explicite, jamais silencieux.** Si Caddy ne répond pas (pas encore démarré, réseau...), `pushConfigToCaddy()` lève une erreur explicite (`CaddyPushFailedError`) — mais la mutation locale (création/suppression) a déjà été persistée avant l'appel et reste donc acquise : `POST /api/reverse-proxy/routes` répond quand même `201` avec la route créée (+ `caddyPushError` dans la réponse), `DELETE .../routes/:id` répond quand même `{ ok: true, caddyPushError }`. Un re-push peut être retenté via `POST /api/reverse-proxy/push`.

**Limite assumée — résolution DNS hors périmètre.** La résolution DNS réelle de `*.lecreusot.priv` vers l'hôte Docker qui exécute Caddy (DNS interne de la mairie, ou à défaut un fichier hosts) est une responsabilité de l'infra réseau, **pas** quelque chose que cette fonctionnalité peut garantir depuis l'intérieur de l'app : QUAI configure uniquement le routage HTTP côté Caddy une fois qu'une requête portant le bon en-tête `Host` lui est effectivement parvenue. Documenté explicitement dans l'aide contextuelle de `ReverseProxyPage.tsx` — jamais présenté comme fonctionnant "tout seul".

**TLS interne hors périmètre de ce premier lot.** Caddy sert exclusivement en HTTP (port `80`) pour l'instant ; `auto_https off` dans `deploy/compose/caddy/Caddyfile` empêche toute tentative ACME sur des noms internes non résolubles publiquement. Le port `443` est déjà exposé côté `docker-compose.dev.yml` pour un futur lot (Caddy sait faire du TLS interne auto-signé assez simplement), volontairement non implémenté ici faute de temps — choix documenté plutôt que passé sous silence.

**Service compose** (`deploy/compose/docker-compose.dev.yml`) : `caddy` (image officielle `caddy:2-alpine`), ports `80`/`443` publiés sur l'hôte pour un test réel, API d'admin `:2019` **non** publiée à l'hôte — joignable uniquement depuis les autres conteneurs du réseau `quai-dev` par son nom de service DNS docker-compose (`http://caddy:2019`, utilisé par `quai-dev-api-1`).

## Explorateur de fichiers d'un volume (lecture seule)

Parcours de l'arborescence d'un volume Docker réel, façon Portainer, déclenché par le bouton **« Parcourir »** de l'Inspector d'un volume (`apps/web/src/features/volumes/VolumesPage.tsx`), affiché dans un `Modal` (`apps/web/src/components/VolumeFilesModal.tsx`). **Lecture seule pour ce premier lot** : aucune route d'édition, de suppression ni d'upload de fichier — le bandeau « Lecture seule » est affiché explicitement dans la modale.

**Mécanisme — conteneur helper éphémère, pas d'API Docker native pour lister un volume.** `apps/api/src/services/docker.ts#listVolumeFiles(volumeName, subPath)` lance un conteneur `alpine:3.19` (même image que les workspaces IaC de démo, tirée à la volée si absente localement) avec le volume monté **en lecture seule** sur `/volume` (`Binds: ["<volume>:/volume:ro"]`), `HostConfig.AutoRemove: true` **et** un `container.remove({ force: true })` défensif dans un `finally` (au cas où `create`/`start` échouerait avant que l'auto-remove ne s'applique) — aucun conteneur helper ne doit jamais rester après usage, vérifié par `docker ps -a` en conditions réelles pendant le développement.

**Listing — `stat`, pas `ls --time-style=full-iso`.** BusyBox (l'`ls` embarqué dans `alpine`) ne supporte pas l'option GNU coreutils `--time-style=full-iso` (vérifié manuellement : `ls: unrecognized option`). Le conteneur helper exécute à la place un petit script shell fixe (jamais construit à partir d'une entrée utilisateur — voir sécurité ci-dessous) qui utilise `stat -c '%n\t%s\t%Y\t%F'` sur `"$dir"/* "$dir"/.[!.]*` (glob shell classique pour inclure les fichiers cachés sauf `.`/`..`), parsé côté Node en `VolumeFileEntry[]` (voir « Contrats de données »).

**Sécurité du chemin (`?path=`) — défense en profondeur à trois niveaux :**
1. Liste blanche de caractères (`/^[a-zA-Z0-9 _./-]*$/`) — aucun métacaractère shell/glob n'est autorisé dans `path`, ce qui garantit qu'il ne peut jamais altérer le glob shell exécuté dans le conteneur helper.
2. Résolution POSIX (`path.posix.normalize(path.posix.join("/volume", path))`) qui collapse tout `..`, puis vérification stricte que le résultat reste sous `/volume` — un `path=../../etc` (ou toute variante) est rejeté en `400` avant même d'atteindre Docker.
3. La valeur validée n'est **jamais interpolée dans une chaîne de commande shell** : elle est passée comme argument positionnel (`$1`) d'un script shell fixe (`/bin/sh -c "$SCRIPT" -- "$path"`), le pattern standard pour éviter l'injection shell.

**Piège vérifié en conditions réelles.** Monter un volume Docker **nommé mais inexistant** via `HostConfig.Binds` le **crée silencieusement** (comportement du démon Docker, pas un bug QUAI) — sans garde-fou, lister un volume inexistant aurait pollué l'hôte d'un volume vide fantôme au lieu de répondre `404`. `listVolumeFiles` vérifie donc explicitement `docker.getVolume(name).inspect()` **avant** tout `createContainer`.

**Route** : `GET /api/volumes/:name/files?path=<sous-chemin>` (`apps/api/src/routes/volumes.ts`) — `400` si `path` est invalide/tente une évasion ou si la cible n'est pas un dossier, `404` si le volume ou le sous-chemin n'existe pas, `502` pour toute autre erreur Docker. Ouvert à toute session authentifiée (comme `GET /api/volumes`), aucune restriction de rôle : lister un contenu en lecture seule n'est pas plus sensible que le reste des vues déjà accessibles à un `viewer`.

## Console interactive dans un conteneur

Terminal shell réel dans un conteneur **en cours d'exécution**, façon Portainer, déclenché par le bouton **« Console »** de l'Inspector d'un conteneur (visible uniquement si `state === "running"` **et** `canOperate(session)`), affiché dans un `Modal` avec un terminal [xterm.js](https://xtermjs.org/) (`@xterm/xterm` + `@xterm/addon-fit`, `apps/web/src/components/ContainerConsole.tsx`).

**Mécanisme — `docker exec` réel via dockerode, relayé par WebSocket.** `apps/api/src/services/docker.ts#openContainerConsole(id)` vérifie d'abord que le conteneur est `running` (lève une erreur explicite sinon — jamais d'exec ouvert dans le vide), puis crée un exec réel (`container.exec({ Cmd: ["/bin/sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"], AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true })`) et l'attache (`exec.start({ hijack: true, stdin: true, Tty: true })`). `apps/api/src/routes/console.ts` (route WebSocket `GET /api/console/:id`, plugin [`@fastify/websocket`](https://github.com/fastify/fastify-websocket) `^10` — la branche `11.x` exige Fastify 5, incompatible avec le Fastify `^4` de ce projet) relaie bidirectionnellement le flux dockerode hijacké et le socket du navigateur : `stream.on("data", ...)` → `socket.send`, `socket.on("message", ...)` → `stream.write`. Fermeture propre dans les deux sens (fermeture du WS → `stream.end()`, fin/erreur du flux dockerode → `socket.close()`) — pas de process qui traîne.

**Sécurité — vérifiée réellement, pas supposée.** Le hook `preHandler` global (`apps/api/src/plugins/auth.ts`) s'applique bien à la requête HTTP d'upgrade WebSocket (confirmé par test manuel : une connexion sans cookie de session valide est rejetée en `401` **avant** l'upgrade, jamais acceptée puis fermée) — mais il n'exige le rôle `operator`/`admin` que pour les méthodes HTTP mutantes, et une requête d'upgrade WS est un `GET`. `routes/console.ts` ajoute donc un hook `preHandler` supplémentaire, local à ce plugin, qui exige explicitement `operator`/`admin` avant d'accepter l'upgrade (`403` sinon, testé avec une session `viewer` : rejet confirmé avant tout accès WebSocket). Un conteneur non `running` (ou introuvable) fait échouer l'ouverture de l'exec avec un message clair envoyé dans le terminal puis fermeture du WebSocket (code `4404`).

## Assistant de configuration au premier lancement

Au tout premier démarrage (aucune configuration persistée), l'API répond "non configurée" et `apps/web` affiche un **assistant plein écran** à la place de l'écran de connexion — pas de sidebar, l'app n'est pas encore utilisable tant que l'assistant n'est pas terminé.

**Persistance** : fichier JSON sur disque, chemin `CONFIG_PATH` (défaut `./data/config.json` en dev, `/data/quai/config.json` en conteneur — volume monté, voir `deploy/`). Chargé au démarrage de l'API. Les variables d'environnement (`LDAP_*`, etc.) restent un mécanisme de bootstrap pour un déploiement scripté qui veut pré-remplir sans passer par l'UI ; si présentes au démarrage et qu'aucun `config.json` n'existe encore, elles pré-remplissent l'assistant (mais ne le marquent pas `completed` automatiquement — l'étape de test/validation reste requise). Aucun secret (mot de passe LDAP, jeton de registry) n'est loggé.

**Étapes de l'assistant** (composant `apps/web`, un écran par étape, indicateur de progression en tête) :

1. **Bienvenue** — résumé des étapes à venir.
2. **Annuaire LDAP** *(obligatoire — c'est le mécanisme d'auth principal, on ne peut pas passer l'étape)* : formulaire URL / Bind DN / mot de passe / base de recherche / filtre / mapping groupe→rôle (éditeur clé-valeur répétable). Bouton **« Tester la connexion »** → `POST /api/setup/test/ldap` avant de pouvoir continuer ; affiche succès/échec avec message clair et, si succès, un aperçu (ex. nombre de groupes résolus, DN de l'utilisateur test).
3. **Orchestrateurs** *(optionnel, « configurer plus tard » possible)* : bloc Docker/Swarm (détection auto du socket, bouton tester) + bloc Kubernetes (coller un kubeconfig, bouton tester) + bloc Nutanix (URL Prism Central, utilisateur, mot de passe, bouton tester). Chaque bloc a sa propre pastille de statut.
4. **Registries** *(optionnel)* : ajout rapide d'un ou plusieurs registries (Docker Hub, GHCR, GitLab, Harbor) avec test individuel par registry.
5. **Récapitulatif** : liste de toutes les vérifications avec pastille (vert = validé, ambre = configuré non testé/skippé, gris = non configuré). Bouton **« Terminer la configuration »** → `POST /api/setup/complete`, puis redirection vers l'écran de connexion LDAP normal.

Un utilisateur `admin` déjà authentifié peut rouvrir cet assistant depuis Paramètres (`POST /api/setup/reset` puis re-parcours des étapes) pour changer la configuration plus tard — dans ce cas l'app reste accessible en lecture pendant la reconfiguration, contrairement au tout premier lancement. Contrairement à un vrai premier démarrage, `/api/setup/*` N'EST PAS réouvert sans authentification pendant cette fenêtre : `setupStore.ts` retient que l'assistant a déjà été terminé au moins une fois (`everCompleted`, jamais remis à `false` par `resetSetup()`) et le hook global continue d'exiger une session admin — sans cette distinction, `POST /api/setup/complete` redevenait accessible à n'importe qui sur le réseau pendant toute la reconfiguration (faille corrigée le 12/08/2026, voir `docs/reports/security-audit-2026-08-12.md`, finding C1).

**Nouvelles routes** (voir liste complète ci-dessous) : chacune des routes `test/*` prend la config candidate dans le corps de la requête (pas la config déjà persistée) pour permettre de tester avant de sauvegarder, et ne modifie jamais l'état persisté.

## Environnements Docker distants

QUAI pilote un ou plusieurs démons Docker **distants** (TCP+TLS), en plus du démon local piloté par défaut — sélectionnables depuis le sélecteur d'environnement du Topbar. Chantier volontairement traité en profondeur sur UN chemin de lecture plutôt qu'en largeur sur dix routes à moitié câblées (voir « Ce qui reste à faire » ci-dessous).

**Persistance** (`apps/api/src/services/remoteDockerStore.ts`, `apps/api/data/remote-docker.json`, chemin `REMOTE_DOCKER_PATH`) : liste nommée `{ id, name, host, port, tls?: { ca, cert, key } }`, même pattern que `secretsStore.ts` — cache mémoire process invalidé à chaque écriture, fichier `0600`, `ca`/`cert`/`key` chiffrés au repos champ par champ (`crypto.ts`, réutilisé tel quel). `GET /api/remote-environments` ne renvoie jamais `ca`/`cert`/`key`, seulement `hasTls` (write-only, même principe que `SecretRef`).

**Connexion — dockerode natif, aucune réimplémentation.** `docker-modem` (la lib HTTP sous-jacente de dockerode) accepte `host`/`port`/`ca`/`cert`/`key` directement dans son constructeur pour une connexion TCP+TLS — c'est la méthode standard documentée par Docker Engine (https://docs.docker.com/engine/security/protect-access/). **Piège vérifié dans ses sources** (`docker-modem/lib/modem.js`) : le protocole ne bascule automatiquement en `https` que si `ca` **ET** `cert` **ET** `key` sont **tous les trois** présents — un déploiement avec seulement `cert`+`key` (CA système déjà approuvée, cas courant) retomberait sinon silencieusement en HTTP en clair. `docker.ts#buildRemoteDockerClient` fixe donc `protocol: "https"` explicitement dès que `cert`+`key` sont fournis.

**`docker.ts#getClient(remoteEnvironmentId?)`** : signature étendue avec un paramètre optionnel, **comportement inchangé sans argument** (démon local/`DOCKER_HOST`, exactement comme avant). Avec un id, résout un client dockerode dédié à cet hôte distant persisté — lève une erreur explicite si l'id n'existe pas (traduite en `404` par les routes, jamais un `502` trompeur). Étendu de la même façon (même paramètre optionnel, même règle) sur `getDockerContainers`, `listVolumes`, `listNetworks`, `getDockerHostInfo` — toutes utilisables avec ou sans id distant.

**Câblé bout-en-bout (vérifié réellement, voir « Vérifications effectuées ») :**
- `GET /api/containers?environmentId=remote-docker:<id>` — liste RÉELLE des conteneurs de l'hôte distant (`environment` = nom de l'environnement distant, `node` = `remote-docker:<id>`). Tout autre `environmentId` (environnement local, Kubernetes, Nutanix, LXC, absent) retombe sur le comportement historique.
- `GET /api/volumes?environmentId=...` / `GET /api/networks?environmentId=...` — même mécanisme, résolution `getClient(id)` partagée.
- `GET /api/environments` agrège un `Environment` (`orchestrator: "docker-remote"`) par hôte distant persisté, avec `hostInfo` réel (`docker info`/`docker version`) si joignable — rend chaque environnement distant sélectionnable depuis le Topbar.
- Frontend : section « Environnements Docker distants » sur `EnvironmentsPage.tsx` (ajout nom/host/port, test de connectivité réel, suppression — admin pour les mutations) + `ContainersPage.tsx` re-fetch réellement `GET /api/containers` avec l'`environmentId` sélectionné dans le Topbar à chaque changement.
- `GET /api/remote-environments/:id/test` : résout le VRAI client dockerode pour cet hôte et appelle `docker.ping()` dessus (pas une simple validation de forme).

**Un hôte distant injoignable ou jamais configuré ne retombe JAMAIS sur le jeu de données de démonstration** (contrairement au démon local) : `[]` honnête, comme Nutanix/LXC — faire croire qu'un environnement distant qu'on vient d'ajouter fait déjà tourner le jeu de démo serait trompeur.

**Rôle requis** : CRUD (`POST`/`PATCH`/`DELETE /api/remote-environments*`) réservé à `admin`, comme `/api/secrets/*` — un environnement Docker distant est un point d'accès administratif à un démon Docker entier. `GET` (liste, détail, test) ouvert à toute session authentifiée.

**Ce qui reste à faire (non câblé dans cette passe)** : les routes d'écriture (créer/démarrer/arrêter un conteneur, créer un volume/network, `POST /api/containers`...) restent démon local uniquement — étendre `createAndStartContainer`/`startContainer`/etc. avec le même paramètre optionnel suivrait exactement le même pattern, non fait faute de temps dans cette passe. La construction de topologie (`services/topology.ts`) ignore aussi les environnements distants pour l'instant (nœuds/arêtes Docker uniquement pour le démon local). Le formulaire d'ajout minimal du Topbar ne saisit pas encore `ca`/`cert`/`key` (à passer via `PATCH /api/remote-environments/:id` pour l'instant).

## Support LXC (via LXD)

LXC seul n'a pas d'API réseau standard (techno de conteneurisation bas niveau, pilotée localement via `lxc-*`) — **LXD**, le démon de gestion LXC de Canonical (largement utilisé, notamment indirectement par Proxmox), **EST** la façon standard de piloter des conteneurs LXC à distance, via une vraie API REST (unix socket local ou HTTPS + certificat client à distance, https://documentation.ubuntu.com/lxd/en/latest/rest-api/). QUAI cible LXD — pas une réimplémentation de `lxc-*` en sous-processus distant (aucun sens pour un accès distant).

**`apps/api/src/services/lxc.ts`** : même pattern **exact** que `nutanix.ts` — `isLxcConfigured()`, `isLxcReachable()`, `getLxcContainers()` (liste réelle via `GET /1.0/instances?recursion=1`), `getLxcEnvironment()` (agrégé dans `environments.ts#getAllEnvironments`, `orchestrator: "lxc"`). **Jamais de donnée fabriquée** : `[]`/`null` si LXD n'a jamais été configuré, idem si configuré mais injoignable — jamais mélangé aux vraies données Docker/Kubernetes/Nutanix.

**Authentification — mTLS, comme documenté pour tout accès distant à LXD.** `apps/api/src/services/lxcStore.ts` persiste UN endpoint LXD (`https://host:port`) + certificat client (`clientCert`/`clientKey`, chiffrés au repos champ par champ comme `remoteDockerStore.ts`) — pas une liste nommée comme les environnements Docker distants : LXD n'a, dans ce premier lot, pas de notion de plusieurs intégrations LXC côté QUAI (même principe qu'une seule config Nutanix).

**Route branchée dès sa création** — `GET /api/lxc/containers` (comme `GET /api/nutanix/vms`, resté du code mort un temps avant d'être branché) : câblée dans `index.ts` dans le même commit que sa création, jamais laissée orpheline. `GET/PUT/DELETE /api/lxc/config` (admin pour les mutations) + `GET /api/lxc/config/test` (test réel contre la config persistée, `GET /1.0/instances` authentifié par certificat client) complètent le CRUD minimal nécessaire pour rendre l'intégration testable sans passer par l'assistant de configuration (pas de nouvelle étape LXC ajoutée à `SetupWizard.tsx` dans cette passe).

**Reporté explicitement — nœuds LXC dans la topologie.** Un nouveau `kind: "lxc-container"` dans `TopologyNode["kind"]` (même traitement que `"nutanix-vm"` : nœuds isolés, pas d'arête forcée vers Docker) n'a pas été ajouté dans cette passe, faute de temps après la profondeur donnée aux environnements Docker distants — la mécanique serait strictement identique à celle déjà en place pour les VMs Nutanix dans `services/topology.ts`.

**Reporté explicitement — frontend LXC.** Aucune UI dédiée (le sujet demandait une UI minimale pour les environnements Docker distants, pas pour LXC) : `GET /api/lxc/containers` et le CRUD de config sont câblés côté API et vérifiables via l'API/tests, mais pas encore consommés par `apps/web`.

## Détection proactive (watchdog)

Le reste de l'app ne notifie qu'en réaction à une action utilisateur (ex: une mise à jour d'image qui échoue). Le watchdog (`apps/api/src/services/watchdog.ts`) fait l'inverse : il détecte tout seul, en tâche de fond, sans qu'aucun utilisateur n'ait rien demandé.

**Scheduler** : `startWatchdog()` est démarré une seule fois depuis `index.ts#main()` (jamais depuis `buildServer()`, pour ne déclencher aucun appel réseau pendant les tests), un cycle toutes les 75s par défaut, arrêté proprement sur `SIGTERM`/`SIGINT` comme le reste du serveur.

**Ce qu'un cycle vérifie** :

1. **Nouvelles versions d'image** — réutilise `getImages("update")` (`services/images.ts`, déjà utilisé pour les badges "MàJ dispo") et compare aux ids déjà connus lors du cycle précédent : un événement `image_update_available` n'est émis QUE pour une image nouvellement détectée en mise à jour, jamais répété à chaque cycle pour la même image.
2. **Joignabilité des intégrations réellement configurées** — Docker (toujours surveillé, l'app tente toujours de le joindre), Kubernetes (`isKubernetesConfigured()`), Nutanix (`isNutanixConfigured()`), chaque registry avec des identifiants persistés (`getEffectiveRegistryCredentials`). Jamais de vérification, donc jamais de notification, pour une intégration qui n'a jamais été configurée — même garde que partout ailleurs dans le projet. Émission edge-triggered : `integration_unreachable` sur la transition joignable → injoignable, `integration_reachable` sur la transition inverse, jamais de répétition tant que l'état ne change pas.

**Baseline sans bruit** : au tout premier cycle après déploiement de la fonctionnalité (aucun état persisté trouvé), le watchdog enregistre juste l'état courant comme référence sans rien notifier — sinon tout ce qui serait déjà en attente de mise à jour ou déjà injoignable au moment de l'activation déclencherait une notification, alors que ce n'est pas un nouvel événement.

**Persistance** (même répertoire que `CONFIG_PATH`, même pattern JSON Lines append-only que `services/auditLog.ts`) :

- `watchdog-state.json` — dernier état connu (ids d'images en mise à jour, joignabilité par intégration), pour que les transitions survivent à un redémarrage de l'API sans spam au reboot.
- `gitops-reconciler-state.json` — dernier ensemble connu de chemins GitOps en dérive (voir « Réconciliation GitOps » ci-dessous), même raison que watchdog-state.json.
- `notifications-log.jsonl` — un événement par ligne (`SystemNotificationEvent`, voir « Contrats de données »), jamais réécrit, exposé par `GET /api/notifications`.
- `notifications-read-state.json` — un curseur temporel (`readAllBeforeIso`) plutôt qu'un ensemble d'ids lus : `POST /api/notifications/read-all` le positionne à l'instant présent, un événement est considéré lu s'il est antérieur ou égal à ce curseur.

Chaque message est concret et actionnable (jamais de texte générique) : ex. `"Nouvelle version disponible pour nginx:1.25 -> 1.27"`, `"Kubernetes injoignable depuis 11:42"`, `"Kubernetes de nouveau joignable"`.

Côté `apps/web`, `notificationsSlice.ts` récupère ces événements au chargement puis les repolle (`App.tsx`, indépendant de la vue affichée) et les fusionne par id dans le même état que les notifications purement client existantes (`pushNotification`/`errorNotificationMiddleware.ts`, inchangées) — un événement système apparaît donc à la fois en toast (`ToastStack.tsx`) et dans l'historique (`NotificationsPage.tsx`) sans code supplémentaire dans ces deux composants.

## Scan automatique des images déployées

Avant ce chantier, un scan de vulnérabilités (Grype/OSV-Scanner, `services/scan.ts`) ne partait que d'un clic operator/admin sur `ImagesPage.tsx` (`POST /api/images/:id/scan`) : une image tirée puis déployée en prod pouvait donc n'être jamais scannée si personne n'y pensait. `apps/api/src/services/scanScheduler.ts` comble ce trou en rafraîchissant tout seul, en tâche de fond, les scans des images **réellement déployées** (conteneurs `running`, la même notion que celle affichée dans le graphe de topologie).

**DIFFÉRENCE DE NATURE avec le watchdog ci-dessus — à ne pas confondre.** Le watchdog est *edge-triggered* : il compare l'état courant à un état PRÉCÉDENT persisté (`watchdog-state.json`) pour détecter une TRANSITION et n'émet qu'au moment du changement — y compris pour `image_update_available`, qui détecte qu'une **nouvelle version d'image** est disponible (un `docker pull` la mettrait à jour), une notion totalement indépendante des CVE qu'elle contient. Le scheduler de scan n'a **aucune** notion de transition : sa question à chaque cycle n'est pas « qu'est-ce qui a changé depuis le dernier cycle ? » mais « quelles images déployées n'ont jamais été scannées par tel scanner, ou dont le dernier scan réussi par ce scanner date de plus de `STALE_AFTER_MS` (24h par défaut) ? » — un cron de rafraîchissement périodique (façon renouvellement de certificat), pas une détection de changement d'état. Conséquence directe : **pas de fichier d'état séparé** comme `watchdog-state.json` — l'historique déjà persisté (`scans.jsonl`, `services/scan.ts#listAllScans`) donne déjà, pour n'importe quelle image, tout ce qu'il faut pour décider (déjà scannée ? quand ? avec succès ?), sans rien dupliquer sur disque. Un redémarrage de l'API ne perd donc aucune information utile pour ce module.

**Résolution "image déployée"** : réutilise le même client Docker/la même garde de joignabilité que `services/topology.ts` (`getClient` + `isDockerReachable`), mais `listContainers({ all: false })` plutôt que `{ all: true }` — seuls les conteneurs `running` comptent comme "actuellement déployés" ; une image seulement tirée ou un conteneur arrêté n'est volontairement pas scanné ici.

**Ce qu'un cycle vérifie** : pour chaque image déployée, pour chacun des deux scanners (Grype et OSV-Scanner, indépendamment), l'image est "due" si aucun scan de ce scanner n'est déjà `"running"` pour elle (jamais de double-lancement — même vérification que le bouton "Scanner" désactivé pendant qu'un scan tourne côté `ImagesPage.tsx`) **et** (aucun scan réussi de ce scanner n'existe jamais pour cette image, **ou** son dernier scan réussi date de plus de 24h). `scanScheduler.ts#isScanDue` est pure et testable sans I/O (voir `test/scanScheduler.test.ts`), même esprit que `watchdog.ts#detectNewlyUpdatedImages`/`detectReachabilityTransition` mais sans comparaison à un état précédent.

**Concurrence** : au plus 2 scans lancés en parallèle par cycle (`MAX_CONCURRENT_SCANS`) — un scan Grype/OSV-Scanner peut être lourd en CPU, lancer tous les scans dus simultanément serait irresponsable sur un hôte de dev ; un léger parallélisme (2, pas 1 strictement séquentiel) raccourcit un cycle avec plusieurs images dues sans saturer l'hôte. Chaque scan lancé (`startScan(image, scanner, "automatic")`) est attendu par polling (`getScan`, même principe que le frontend) avant de passer au suivant de son slot, plafonné à 10 min par scan (`MAX_WAIT_MS`) pour ne jamais bloquer indéfiniment un cycle — un scan encore `"running"` au-delà est simplement retrouvé comme tel par `isScanDue()` au cycle suivant (pas de double-lancement), son résultat restant consultable par polling normal côté frontend.

**Scheduler** : `startScanScheduler()` est démarré une seule fois depuis `index.ts#main()` (jamais depuis `buildServer()`, même raison que le watchdog : ne jamais déclencher de vrai scan Docker/Grype/OSV-Scanner pendant les tests qui construisent juste le serveur avec `app.inject`), un cycle toutes les 45 min par défaut — bien plus espacé que le watchdog (75s) : un scan complet est coûteux, inutile de revérifier en boucle serrée un état qui ne bouge pas vite. Arrêté proprement sur `SIGTERM`/`SIGINT` comme le reste du serveur.

**Notification** : un scan automatique qui se termine avec au moins une vulnérabilité Critical émet `vulnerability_detected` (level `error`, message concret ex. `"6 vulnérabilité(s) critique(s) détectée(s) sur nginx:1.27 (Grype)"`) via `notificationsStore.ts` — un scan qui ne trouve rien de Critical ne notifie pas (ce serait du bruit vu la fréquence du cycle). Contrairement au watchdog, ce n'est **pas** edge-triggered : un même Critical déjà connu au cycle précédent notifie de nouveau au prochain scan qui le retrouve (pas de mémoire "déjà notifié pour ce CVE") — accepté pour ce premier lot, la fréquence du cycle (45 min) et le seuil de staleness (24h) limitent déjà le bruit en pratique.

**Frontend minimal** : `ScanResult.trigger` (`"manual" | "automatic"`, absent = "manual" sur les scans persistés avant ce champ) est affiché dans l'historique des scans de `ImagesPage.tsx` (colonne "Origine") pour distinguer un scan déclenché par un clic d'un scan lancé tout seul par ce scheduler.

**Vérifié en conditions réelles** : un cycle réel (`runScanSchedulerCycle()`, exporté pour les tests/un déclenchement manuel — même pattern que `watchdog.ts#runWatchdogCycle`) lancé contre la stack de dev a bien détecté `caddy:2-alpine` (conteneur `quai-dev-caddy-1`, réellement déployé, jamais scanné) comme dû pour Grype **et** OSV-Scanner, lancé les deux scans avec `trigger: "automatic"`, et le résultat était bien consultable via `GET /api/images/:id/scans` (OSV-Scanner : 6 High/13 Medium/13 Unknown trouvés réellement sur l'image, aucun inventé).

## Réconciliation GitOps (détection de dérive)

Même principe que le watchdog ci-dessus, appliqué à la dérive GitOps : `apps/api/src/services/gitopsReconciler.ts` détecte tout seul, en tâche de fond, qu'un manifeste s'est mis à dériver (ou a cessé de dériver) — mais ne l'applique **jamais**. Conformément à « GitOps » ci-dessus (« l'application du changement reste une action explicite depuis l'UI »), ce module n'appelle que `listGitOpsFiles()` (lecture pure) ; `sync()` reste déclenché exclusivement par un clic humain sur `POST /api/gitops/sync`, inchangé.

**Scheduler** : `startGitopsReconciler()` est démarré une seule fois depuis `index.ts#main()` (jamais depuis `buildServer()`, même raison que le watchdog), un cycle toutes les 90s par défaut, arrêté proprement sur `SIGTERM`/`SIGINT`.

**Ce qu'un cycle vérifie** : compare l'ensemble des chemins actuellement en dérive (`listGitOpsFiles().filter(f => f.drift)`) à l'ensemble précédemment connu (persisté sur disque). Edge-triggered, comme le watchdog : un chemin qui passe de « pas en dérive » à « en dérive » émet `gitops_drift_detected` (level `error`) ; un chemin qui repasse de « en dérive » à « pas en dérive » (ex: sync manuel entre deux cycles) émet le même `kind` en level `success`. Baseline sans bruit au premier cycle (aucun état persisté), même garde que le watchdog.

**Persistance** : `gitops-reconciler-state.json` (même répertoire que `watchdog-state.json`) — chemins actuellement en dérive, pour que les transitions survivent à un redémarrage sans spam au reboot.

Côté `apps/web`, `GitOpsPage.tsx` affiche un indicateur discret « Dernière vérification automatique : HH:MM » basé sur son propre polling read-only de `GET /api/gitops/files` toutes les 90s (coupé quand l'onglet est en arrière-plan, même garde que `OverviewPage.tsx`) — pas de nouvelle route dédiée.

## Routes API (consommées par `apps/web`)

```
GET  /api/setup/status
POST /api/setup/test/ldap
POST /api/setup/test/docker
POST /api/setup/test/kubernetes
POST /api/setup/test/nutanix
POST /api/setup/test/registry
POST /api/setup/complete
POST /api/setup/reset            # admin authentifié uniquement

GET  /api/session
POST /api/auth/login
POST /api/auth/logout

GET  /api/environments                      # inclut désormais un Environment par environnement Docker distant
                                             # persisté (orchestrator "docker-remote") et, si LXD est configuré,
                                             # un Environment "lxc" — voir « Environnements Docker distants »/
                                             # « Support LXC (via LXD) »
GET  /api/environments/:id/nodes
GET  /api/nutanix/vms                       # détail par VM (nom, powerState, vCPUs, mémoire, cluster physique) —
                                             # distinct de GET /api/environments (un nœud PAR CLUSTER PHYSIQUE,
                                             # compteur de VMs agrégé). Enfin branché sur services/nutanix.ts#
                                             # getNutanixVms(), jusque-là du code mort (appelé par aucune route) —
                                             # [] si Nutanix n'a jamais été configuré ou injoignable, jamais de VM
                                             # inventée. Consommé par EnvironmentsPage.tsx (section "VMs" de
                                             # l'environnement Nutanix) et par GET /api/topology ci-dessous.

GET    /api/remote-environments             # liste des environnements Docker distants persistés — jamais
                                             # ca/cert/key, seulement `hasTls` (voir « Environnements Docker
                                             # distants »). Ouvert à toute session authentifiée.
POST   /api/remote-environments             # { name, host, port, tls? } — admin uniquement.
GET    /api/remote-environments/:id
PATCH  /api/remote-environments/:id         # { name?, host?, port?, tls?, clearTls? } — admin uniquement.
DELETE /api/remote-environments/:id         # admin uniquement.
GET    /api/remote-environments/:id/test    # test de connectivité RÉEL — docker.ping() sur le client dockerode
                                             # résolu pour cet hôte précis (services/docker.ts#getClient).

GET    /api/lxc/containers                  # instances LXD réelles (nom, statut, architecture, type) — []
                                             # si LXD n'a jamais été configuré ou injoignable, jamais de conteneur
                                             # LXC inventé (voir « Support LXC (via LXD) »). Branchée dès sa
                                             # création (contrairement à GET /api/nutanix/vms, resté du code mort
                                             # un temps).
GET    /api/lxc/config                      # { configured, endpoint?, updatedAt? } — jamais le certificat/la clé.
PUT    /api/lxc/config                      # { endpoint, clientCert, clientKey } — admin uniquement.
DELETE /api/lxc/config                      # admin uniquement.
GET    /api/lxc/config/test                 # test de connectivité RÉEL contre la config persistée (GET
                                             # /1.0/instances authentifié par certificat client mTLS).

GET    /api/images?status=update|uptodate   # images Docker réelles de l'hôte (docker.ts), démo en repli
POST   /api/images/:id/update               # pull réel du dernier tag connu (image locale) ou màj démo
DELETE /api/images/:id?force=true           # équivalent `docker rmi`, image locale uniquement
POST   /api/images/pull                     # { reference } — équivalent `docker pull`, retourne la liste rafraîchie

GET   /api/registries
POST  /api/registries                                   # { kind, name, url, username?, password?, token?, org? } —
                                                         # identifiants + org saisissables dès la création (formulaire
                                                         # "+ Ajouter un registry", modal — RegistriesPage.tsx), plus
                                                         # besoin d'un détour par PATCH pour un dépôt privé.
GET   /api/registries/:id
PATCH /api/registries/:id                              # { name?, url?, username?, password?, token?, org? } — password/token
                                                         # omis ou vides = identifiant déjà enregistré conservé (voir
                                                         # setupStore.ts#updateRegistryAt). `org` a une convention
                                                         # DIFFÉRENTE (pas un secret) : absent = org déjà enregistrée
                                                         # inchangée, mais une chaîne VIDE l'efface explicitement et fait
                                                         # retomber la résolution sur l'ancienne déduction (voir
                                                         # registriesStore.ts#resolveRegistryOrg). Icône engrenage sur
                                                         # chaque carte de RegistriesPage.tsx (admin uniquement).
GET   /api/registries/:id/repositories                 # { repositories, diagnostic? } — vrai catalogue distant (GHCR/
                                                         # Docker Hub). diagnostic = raison concrète d'un catalogue
                                                         # vide (401/403/404/429, org introuvable, aucune org déduite,
                                                         # aucun identifiant...) au lieu d'un [] muet — voir
                                                         # registries/index.ts#diagnosticFromError. Bouton "Retester"
                                                         # sur RegistryExplorerPage.tsx.
GET   /api/registries/:id/repositories/:repo/tags       # tags d'un dépôt du catalogue (:repo encodé)

GET    /api/secrets       # id/name/description/createdAt/updatedAt — JAMAIS la valeur (voir « Gestionnaire
                           # de secrets » ci-dessus). Ouvert à toute session authentifiée.
POST   /api/secrets       # { name, value, description? } — admin uniquement (403 sinon).
PATCH  /api/secrets/:id   # { name?, value?, description? } — value omise/vide = valeur conservée,
                           # admin uniquement.
DELETE /api/secrets/:id   # admin uniquement.

GET  /api/containers    # ?environmentId=remote-docker:<id> cible un environnement Docker distant persisté
                        # au lieu du démon local — câblé bout-en-bout (voir « Environnements Docker
                        # distants »). GET /api/volumes et GET /api/networks acceptent le même paramètre.
POST /api/containers   # { image, name?, ports?, env?, secretEnv?, volumes?, network? } — équivalent
                        # `docker run -d`. L'image doit déjà être locale : faire POST /api/images/pull
                        # avant si besoin. `env` : texte brut ("CLE=valeur"). `secretEnv` :
                        # { key, secretName }[], résolu côté serveur via le gestionnaire de secrets
                        # ci-dessus et fusionné dans l'Env final — secretName introuvable = 400 avant
                        # toute création. La gestion déclarative complète passe par GitOps (voir plus
                        # bas) ; ceci reste pensé pour tester vite en local.
GET  /api/containers/:id/processes  # ContainerProcessList — équivalent `docker top <id>`, voir « Graphe
                                     # de topologie » (vue "composition interne"). 409 si le conteneur
                                     # n'est pas démarré (docker top l'exige), 404 s'il n'existe plus,
                                     # jamais une liste vide silencieuse pour un échec réel.
GET  /api/images/:id/history        # ImageHistoryLayer[] — équivalent `docker history`, même vue
                                     # "composition interne". 404 si l'image n'est pas suivie, 502 si le
                                     # démon est injoignable ou l'image n'existe plus localement.

GET  /api/gitops/files
GET  /api/gitops/files/:path/diff
GET  /api/gitops/commits
POST /api/gitops/sync

GET  /api/topology                       # graphe visuel (conteneurs/volumes/networks + relations réelles),
                                          # nœuds "conteneur" enrichis de cpuPercent/memBytes/updateAvailable/drift/
                                          # vulnCritical/vulnHigh (voir « Contrats de données » ci-dessus) + nœuds
                                          # "nutanix-vm" (une VM Nutanix par nœud, GET /api/nutanix/vms ci-dessus) —
                                          # indépendants de Docker (récupérés même si Docker est injoignable, jamais
                                          # d'arête vers les nœuds Docker), absents tant que Nutanix n'a jamais été
                                          # configuré (voir « Graphe de topologie » plus bas)
POST /api/containers/:id/rename          # { name } — équivalent `docker rename`
POST /api/networks/:id/connect           # { containerId } — équivalent `docker network connect`
POST /api/networks/:id/disconnect        # { containerId } — équivalent `docker network disconnect`

GET  /api/volumes/:name/files?path=<sous-chemin>  # VolumeFileEntry[] — explorateur en LECTURE SEULE (voir
                                                   # « Explorateur de fichiers d'un volume » ci-dessus). 400 si
                                                   # `path` est invalide/tente une évasion du volume ou cible un
                                                   # fichier plutôt qu'un dossier, 404 si le volume ou le
                                                   # sous-chemin n'existe pas. Ouvert à toute session authentifiée.

GET  /api/console/:id   (WebSocket)      # terminal interactif réel dans un conteneur RUNNING (voir « Console
                                          # interactive dans un conteneur » ci-dessus) — équivalent `docker exec
                                          # -it <id> sh`. operator/admin uniquement (403 avant l'upgrade WS sinon,
                                          # jamais un viewer) ; 404 (fermeture du WS, code 4404) si le conteneur
                                          # n'existe pas ou n'est pas `running`.

POST /api/images/:id/scan                # { scanner?: "grype" | "osv-scanner" } — "grype" par défaut si absent.
                                          # Lance le scanner réel demandé (services/scan.ts), retourne le ScanResult
                                          # à l'état "running" immédiatement (suivi par polling, voir ci-dessous) —
                                          # trigger: "manual" (voir aussi le scan automatique périodique, § « Scan
                                          # automatique des images déployées », qui appelle la même fonction avec
                                          # trigger: "automatic", jamais via cette route HTTP)
GET  /api/images/:id/scans               # historique des scans d'une image, tous scanners confondus (manuels et
                                          # automatiques mélangés, voir ScanResult.trigger)
GET  /api/scans/:scanId                  # détail + statut d'un scan (à poller pendant qu'il tourne)
GET  /api/scanners/status                # ScannerStatus[] — présence/version de grype et osv-scanner sur l'hôte

GET  /api/notifications?since=<ISO 8601>  # événements détectés par le watchdog (voir « Détection
                                           # proactive » ci-dessus) et par le scan automatique (« vulnerability_detected »,
                                           # voir « Scan automatique des images déployées »), les plus récents d'abord
POST /api/notifications/read-all          # marque tous les événements connus comme lus (operator/admin)

GET    /api/reverse-proxy/routes    # liste des routes actives, ouvert à toute session authentifiée
POST   /api/reverse-proxy/routes    # { subdomain, targetContainerId? | targetHost?, targetPort } — operator/admin.
                                     # 201 même si le push vers Caddy échoue (route créée quand même, voir
                                     # « Reverse proxy interne » — réponse enrichie d'un `caddyPushError`)
DELETE /api/reverse-proxy/routes/:id  # operator/admin, mêmes garanties de persistance que POST ci-dessus
POST   /api/reverse-proxy/push      # repousse la config complète vers Caddy sans rien changer côté QUAI
                                     # (utile après un redémarrage de Caddy) — operator/admin
GET    /api/reverse-proxy/status    # ReverseProxyStatus — Caddy joignable ou non, même pattern que
                                     # GET /api/scanners/status

GET    /api/ad-dns/config           # config DNS AD courante, REDACTÉE (jamais le mot de passe) +
                                     # dernier résultat de synchronisation connu — ouvert à toute
                                     # session authentifiée.
PUT    /api/ad-dns/config           # { realm, kdcHost, zone, serviceAccount, targetIp, password? }
                                     # — admin uniquement (403 sinon, même garde que /api/secrets/*
                                     # et /api/lxc/config) — un `operator` compromis pourrait
                                     # sinon rediriger `kinit` vers un KDC Kerberos qu'il contrôle
                                     # (rogue-KDC). `targetIp` validé comme IPv4 strict. `password`
                                     # omis/vide = conserve le mot de passe déjà enregistré (même
                                     # convention que PATCH /api/registries/:id).
DELETE /api/ad-dns/config           # désactive la synchronisation automatique — admin uniquement.
POST   /api/ad-dns/test             # valide une config candidate (kinit uniquement, aucun
                                     # enregistrement DNS écrit) — operator/admin, ne mute rien.
```

Toutes les routes (sauf `/api/auth/*` et `/api/setup/*`) exigent une session valide. Les routes `POST`/`PATCH`/`DELETE` exigent le rôle `operator` ou `admin`. Les routes `/api/setup/*` ne sont ouvertes SANS session que lors d'un vrai premier démarrage (`completed=false` ET l'assistant n'a jamais été terminé une seule fois, `everCompleted=false`) ; dès que l'assistant a été terminé au moins une fois — y compris temporairement rouvert par un admin (`completed` repasse à `false` via `POST /api/setup/reset`, mais `everCompleted` reste `true`) — elles répondent `403` sauf pour un utilisateur `admin` authentifié (flux de reconfiguration). Exception plus stricte : les 3 routes mutantes de `/api/secrets/*` exigent explicitement `admin` (voir « Gestionnaire de secrets »), pas seulement `operator` — même exception pour les routes mutantes de `/api/remote-environments/*`, `/api/lxc/config`, `PUT`/`DELETE /api/ad-dns/config` et `POST`/`PATCH /api/registries*` (gestion des registries, y compris leurs identifiants — voir « Rôles » ci-dessus, « admin : + gestion des registries et des accès »). Autre exception, dans l'autre sens : `GET /api/console/:id` (upgrade WebSocket, donc une méthode `GET`) exige quand même explicitement `operator`/`admin` — ajouté par un hook `preHandler` propre à `routes/console.ts` car le hook global ne restreint par rôle que les méthodes mutantes (voir « Console interactive dans un conteneur »).

## Graphe de topologie (`apps/web/src/components/TopologyGraph.tsx`)

Le graphe visuel (React Flow, `GET /api/topology` — voir « Routes API » ci-dessus) a cinq
particularités. Les points 1, 3 et 4 sont purement côté client (aucune donnée d'infrastructure
supplémentaire nécessaire côté `apps/api`) ; le point 2 (persistance des positions) repose sur
`apps/api/src/routes/topology.ts`/`topologyPositionsStore.ts` (fichier JSON par utilisateur, pas
une ressource Docker) ; le point 5 (santé des conteneurs) nécessite un appel Docker additionnel
côté API :

1. **Connexions par capacité, ports typés.** Chaque type de nœud déclare la liste des « ports »
   qu'il expose dans une table `NODE_CAPABILITIES` (id, capacité, côté source/target, position,
   couleur reprise des variables déjà utilisées pour l'icône du même type de nœud — pas de couleur
   ajoutée) : un conteneur expose un port `network` (source, connexion réelle vers un network) et
   un port `volume-mount` (target, informatif seulement — Docker ne permet pas de modifier les
   montages sans recréer le conteneur) ; un volume expose un port `provide` ; un network expose un
   port `attach`. La compatibilité entre deux ports (et l'action déclenchée — `docker network
   connect` réel ou simple message d'info) est décrite dans une seconde table `CAPABILITY_DEFS`.
   `classifyConnection`/`isValidConnection`/`handleConnect` ne lisent que ces deux tables : ajouter
   un futur 4e type de nœud (ex : registry) ne demande que de lui déclarer ses propres ports, sans
   toucher à cette logique. Chaque port est un `<Handle>` React Flow distinct, visuellement propre
   à sa capacité (couleur idle, pas seulement au survol ; bordure en tirets pour les ports
   informatifs).
2. **Canevas libre et persistant, PAR UTILISATEUR CONNECTÉ.** La position d'un nœud déplacé à la
   main (drag React Flow standard, `onNodesChange`/`onNodeDragStop`) est persistée côté serveur
   (`GET`/`PUT /api/topology/positions`, `apps/api/src/services/topologyPositionsStore.ts` — JSON
   sur disque, permissions 0600, même dossier/pattern que `secrets.json`), PAS en `localStorage` du
   navigateur : la disposition suit l'identité (username LDAP), pas l'appareil — un même admin
   connecté depuis un autre poste, ou deux comptes partageant le même poste, ont un comportement
   cohérent. Elle survit au rafraîchissement périodique (15s) et à un rechargement de page. Un
   nœud jamais déplacé (absent de la disposition de l'utilisateur) reçoit toujours une position par
   défaut selon le placement en 4 colonnes (volumes / conteneurs / networks / VMs Nutanix)
   historique. Une `<MiniMap>` (`@xyflow/react`) est ancrée en bas à droite du canevas, stylée
   comme les autres contrôles React Flow du thème sombre.
   - **Purge silencieuse des positions fantômes.** `GET /api/topology/positions` calcule le graphe
     RÉEL actuel côté serveur (`getTopology()`) et retire, avant de répondre, toute entrée dont
     l'id de nœud n'y apparaît plus — conteneur supprimé, volume/network nettoyé... rien ne
     purgeait jamais ces entrées auparavant, elles s'accumulaient indéfiniment dans le fichier de
     chaque utilisateur (`purgeStalePositions`, `topologyPositionsStore.ts` — n'écrit sur disque que
     si au moins une entrée a effectivement été retirée). Ce n'est PAS une suppression de ressource
     Docker, seulement une préférence d'affichage désormais orpheline : nettoyée silencieusement,
     contrairement aux volumes/networks eux-mêmes (jamais retirés sans confirmation explicite).
   - **Garde-fou contre un id de nœud recyclé.** `volume:<nom>` est le seul id de nœud sans
     identité Docker immuable derrière (contrairement à un conteneur/network, dont l'id est un hash
     Docker jamais réattribué même en cas de recréation à l'identique) : supprimer un volume puis en
     recréer un portant EXACTEMENT le même nom reprend le même id de nœud. `TopologyNode` porte donc
     un `createdAt` optionnel (volumes/networks uniquement, `CreatedAt`/`Created` réel Docker,
     `services/topology.ts`) que `TopologyGraph.tsx` compare entre l'ancien et le nouveau nœud avant
     de réutiliser une position héritée de la session en cours — s'ils diffèrent, ce n'est pas la
     même ressource, la position par défaut est utilisée à la place plutôt qu'une position héritée à
     tort. Angle mort résiduel assumé : la position persistée côté serveur (`positions[n.id]`) ne
     porte pas cet horodatage, donc une recréation à l'identique ENTRE deux sessions (rechargement de
     page) reste indétectable — cas jugé suffisamment rare (il faut recréer le volume/network sous
     un nom rigoureusement identique) pour ne pas justifier de changer le format d'id ou le schéma de
     persistance des positions pour le couvrir aussi.
3. **Zoom sémantique.** Sous un seuil de zoom (`ZOOM_DETAIL_THRESHOLD = 0.6`, lu via
   `useStore((s) => s.transform[2])` à l'intérieur même du composant de nœud), un nœud se réduit à
   son icône et son point de statut — libellé, sous-titre, badges et métriques CPU/mémoire
   s'effacent en fondu (transition CSS 0.15s, désactivée sous `prefers-reduced-motion`, même
   pattern que le reste du site depuis la passe micro-interactions). Au-dessus du seuil, détail
   complet comme avant.
4. **Nœuds VM Nutanix (`kind: "nutanix-vm"`).** Une VM Nutanix par nœud (id `nutanix-vm:<uuid>`,
   label = nom de la VM, sous-titre = cluster physique, statut dérivé de `powerState` : `on` →
   `running`, `off` → `stopped`, `unknown` → `neutral`), colonne dédiée (4e colonne, couleur
   `--color-success`, icône `IconVm`), `NODE_CAPABILITIES["nutanix-vm"] = []` — pas de port, donc
   jamais d'arête (ni forcée ni glissée) vers les nœuds Docker : ce sont des nœuds isolés,
   volontairement indépendants de l'infrastructure Docker locale. Récupérés côté API que Docker
   soit joignable ou non (`getTopology()`), absents tant que Nutanix n'a jamais été configuré ou
   si configuré mais injoignable (même garde `isNutanixConfigured()` que le reste du projet) —
   jamais de VM inventée. Détail complet (vCPUs, mémoire, cluster, état) affiché dans l'Inspector
   au clic, comme pour les autres types de nœuds.
5. **Santé des conteneurs → couleur des arêtes, côté API cette fois.** Contrairement aux points
   1-4 (purement client), `healthStatus` est calculé côté `apps/api` : `docker.ts#
   readContainerHealth` fait un `inspect()` par conteneur (résumé `listContainers` n'expose que
   `Status`, une chaîne texte, pas de champ structuré) et lit `State.Health.Status` — LE signal que
   Docker calcule déjà lui-même en pingant la commande définie par l'instruction `HEALTHCHECK` de
   l'image (ex : `curl -f http://localhost/health`). `"none"` si l'image n'en définit aucune : un
   résultat honnête et attendu pour la plupart des conteneurs d'un host de dev, jamais une valeur
   fabriquée par convention de port/chemin `/health` deviné — **ce ping HTTP par convention n'est
   volontairement pas implémenté** dans ce premier lot, seul le signal Docker natif est utilisé.
   Une arête ne duplique pas cette donnée : `TopologyGraph.tsx` la lit directement sur le(s) nœud(s)
   conteneur à ses deux bouts (`edgeContainerNode`, il y en a toujours exactement un — mount =
   volume<->conteneur, network = conteneur<->network) pour dériver sa couleur :
   - conteneur `status !== "running"` (arrêté) → arête grise à tirets larges espacés, quel que soit
     `healthStatus` (un arrêt est souvent volontaire, pas une panne — pas de rouge) ;
   - sinon `healthStatus: "healthy"` → `var(--color-success)` (verte) ;
   - `"unhealthy"` → `var(--color-critical)` (rouge), avec une pulsation d'opacité légère
     (`@keyframes topology-pulse`, même principe que `.overview-refresh-dot`/`overview-pulse` dans
     `layout.css`) désactivée sous `prefers-reduced-motion` ;
   - `"starting"` → `var(--color-warning)` ;
   - `"none"` (pas de healthcheck défini) → `var(--color-text-faint)`, inchangé par rapport à avant
     cette passe — jamais de fausse alerte pour un conteneur qui n'a simplement pas de healthcheck.
   Un badge `Unhealthy`/`Healthcheck…` (même pulsation que l'arête pour "unhealthy") apparaît sur le
   nœud conteneur lui-même, utile même sans arête visible (nœud isolé). Les arêtes "mount" (données/
   fichiers qui transitent) se distinguent visuellement des arêtes "network" : trait plein plus
   épais avec des particules qui voyagent réellement le long du tracé (`MountFlowEdge`, propriété
   CSS `offset-path`/`offset-distance` — animation native du navigateur, aucun recalcul JS par
   frame) plutôt que le tiret défilant générique conservé côté "network" (plus subtil, `animated:
   true` + `strokeDasharray`, comportement inchangé). Les particules ne sont pas rendues si le
   conteneur est arrêté (rien ne transite réellement) ou sous `prefers-reduced-motion`.
6. **Modal de détail complet et panneau de sous-graphe.** Les éléments de rendu du graphe
   (`GraphNode`, `edgeTypes`/`nodeTypes`, `NODE_CAPABILITIES`/`CAPABILITY_DEFS`, `buildTopologyEdges`,
   `idWithoutPrefix`, `formatMem`, `radialPositions`, `ProcessNode`/`interiorNodeTypes`...) ont été
   extraits de `TopologyGraph.tsx` vers `apps/web/src/components/topologyGraphShared.tsx`, pour être
   réutilisés à l'identique par deux composants :
   - `TopologyNodeDetailModal.tsx` — ouverte par "Voir le détail" (menu contextuel d'un nœud). Le
     résumé déjà présent sur `TopologyNode` (ex : `vulnCritical`) ne suffit pas pour cette vue : la
     modal va chercher le VRAI détail selon le kind — `GET /api/containers/:id` (ports, montages,
     labels, commande, politique de redémarrage) pour un conteneur, avec ses variables
     d'environnement masquées par défaut si leur clé ressemble à un secret (heuristique
     `/PASSWORD|SECRET|TOKEN|KEY/i`, bouton "afficher" par ligne — ce composant n'a aucune idée de ce
     qui est un vrai secret géré par `secretsStore.ts`, donc prudence par défaut) ; la vraie liste de
     vulnérabilités du DERNIER SCAN RÉUSSI de l'image du conteneur (`GET /api/images/:id/scans`,
     rapprochée par nom "name:tag" comme `services/topology.ts#vulnSummaryForImage`), triée par
     sévérité, avec un message explicite ("Aucun scan effectué" + bouton pour en lancer un si
     operator/admin) si aucun scan n'a jamais réussi — jamais de liste vide silencieuse ; réutilise
     le pattern visuel `.scan-summary`/`.scan-vuln-table-wrap` déjà utilisé par `ImagesPage.tsx`,
     pas un design ad hoc. Pour un volume/network : objets complets `DockerVolume`/`DockerNetwork`
     déjà exposés par `GET /api/volumes`/`GET /api/networks` (aucune nouvelle route). Pour une VM
     Nutanix : ce qui est déjà dans `TopologyNode`, présenté proprement. Toujours un enfant de
     `<Modal>` (`Modal.tsx`, INCHANGÉ — aucune nouvelle variante de taille n'y a été ajoutée), mais
     volontairement TRÈS large (`.topology-detail-modal`, jusqu'à 1180px) et organisée en grille 2
     colonnes (identité/métriques à gauche, réseau/volumes/labels/env à droite, `.topology-detail-
     modal__grid`/`__col`) plutôt qu'une seule colonne verticale : un écran de bureau normal affiche
     tout sans faire défiler la modal entière. Seule la section vulnérabilités (pleine largeur, en
     bas, potentiellement longue) garde un scroll INTERNE cantonné à sa table
     (`.topology-detail-modal__vuln-table-wrap`, `max-height` + `overflow-y: auto`) — le seul scroll
     restant, jamais celui de toute la modal.
   - `TopologySubGraphPanel.tsx` (`TopologySubGraphModal.tsx` avant cette passe) — ouvert au
     double-clic sur un nœud (ou "Visualiser les dépendances" du menu contextuel). Différence majeure
     de PRÉSENTATION par rapport à avant : ce n'est plus un enfant de `<Modal>` (calque flottant par
     portail `document.body`) mais un panneau `position: absolute; inset: 0` À L'INTÉRIEUR de
     `.topology-graph` (devenu `position: relative`) — il occupe exactement la même zone que le
     graphe principal, jamais un calque par-dessus toute la page. `TopologyGraph.tsx` orchestre une
     transition "on rentre dans le nœud" : au double-clic/clic menu, `openSubGraph(nodeId, clientX,
     clientY)` calcule l'origine en % relatifs à `.topology-graph` (position à l'écran du clic),
     monte le panneau (`opacity: 0; transform: scale(0.42)` posé avec ce `transform-origin`) puis
     bascule une frame plus tard vers `.topology-subgraph-panel--visible` (`opacity: 1; scale(1)`)
     pendant que `.topology-graph__main` (enveloppe du `<ReactFlow>` principal) s'efface légèrement
     en retrait (`opacity: 0; scale(1.06)`, `pointer-events: none`). Remonter ("↑ Remonter au graphe
     complet") joue la même transition en sens inverse ; le panneau reste monté jusqu'à la fin de
     l'animation de sortie (`onTransitionEnd` sur `opacity` → `onExited`) pour ne pas disparaître
     brutalement. Sous `prefers-reduced-motion`, ni transition ni double `requestAnimationFrame` :
     montage/démontage direct. Contenu du panneau, deux vues choisies par bascule (`viewMode`,
     `.topology-subgraph-panel__mode-toggle`, proposée UNIQUEMENT pour un nœud "container") :
     - **"Dépendances"** (par défaut, tous les kinds) — comportement de sous-graphe INCHANGÉ par
       rapport à avant cette passe : UNIQUEMENT ce nœud + tous les nœuds reliés à lui par au moins
       une arête du graphe complet déjà chargé côté client (`state.topology.data`, pur calcul dérivé,
       aucun nouvel appel réseau), disposition radiale (racine au centre, voisins en cercle,
       `radialPositions`). Double-cliquer sur un nœud DANS le sous-graphe re-centre la vue dessus
       (drill-down récursif, fil d'Ariane + bouton "← Retour"), continue de fonctionner à l'identique
       dans ce nouveau panneau plein écran. Un nœud isolé affiche un message explicite plutôt qu'un
       canevas vide. "Voir le détail" délègue à l'unique instance de `TopologyNodeDetailModal` montée
       par `TopologyGraph.tsx` (pas de doublon).
     - **"Composition interne"** (conteneurs uniquement — les autres kinds n'ont pas cette notion) —
       QUAI ne peut PAS connaître la vraie architecture applicative interne d'un conteneur (il
       faudrait du tracing applicatif, hors périmètre de ce projet) : cette vue n'invente RIEN à ce
       sujet, elle affiche UNIQUEMENT ce que Docker expose réellement, avec un sous-titre explicite
       dans l'UI elle-même (`.topology-interior__caption`) précisant quelles données et leur
       provenance exacte, pour ne jamais être prise pour une carte d'architecture applicative :
       - **Processus réels en cours d'exécution** — `GET /api/containers/:id/processes`
         (`docker.ts#getContainerProcesses`, équivalent `docker top <id>`), rendus comme des nœuds
         "processus" (`ProcessNode`, `.topology-process-node` — PID/utilisateur/commande, colonnes
         identifiées avec confiance dans `titles` par regex ; repli honnête sur la dernière colonne
         réelle si "CMD"/"COMMAND" n'est pas reconnu, jamais une valeur inventée) reliés par de
         simples arêtes au nœud conteneur, même disposition radiale que la vue "Dépendances"
         (`radialPositions`, rayon plus serré). Conteneur arrêté → message explicite AVANT même
         d'appeler l'API (`docker top` l'exige) ; échec réel (404/409/502) → message honnête
         (`processesError`), jamais une liste vide qui prétendrait "aucun process".
       - **Historique des couches de l'image** — `GET /api/images/:id/history`
         (`docker.ts#getImageHistory`, équivalent `docker history`), présenté en liste compacte
         empilée (`.topology-interior__layers`, taille + commande Dockerfile tronquée par couche)
         avec son propre scroll interne si l'image a beaucoup de couches — secondaire par rapport aux
         processus réels, image rapprochée par nom "name:tag" comme la section vulnérabilités de
         `TopologyNodeDetailModal.tsx`.
   L'Inspector latéral permanent n'est PAS réintroduit sur la Vue d'ensemble (retiré
   intentionnellement, voir `OverviewPage.tsx`) : la modal de détail et le panneau de sous-graphe ne
   s'affichent qu'à la demande (clic droit / double-clic), jamais affichés en permanence.

## Volumes/networks orphelins (détection + nettoyage)

`GET /api/topology` exclut délibérément du graphe tout volume/network non rattaché à au moins un
conteneur (voir en-tête de `services/topology.ts`) — un hôte de dev peut avoir des dizaines de
volumes de cache d'autres projets, tous les montrer noierait le graphe façon Railway. Ça ne les
rend pas invisibles pour autant : `GET /api/volumes`/`GET /api/networks` (déjà existantes)
renvoient TOUS les volumes/networks réels de l'hôte, chacun avec un champ `inUseBy`/
`containerCount` déjà calculé côté serveur à partir des mêmes conteneurs (`docker.ts#listVolumes`/
`listNetworks`) — exactement la même définition que celle utilisée par `getTopology()` pour son
filtre, jamais recalculée une seconde fois.

- **Orphelin** = `inUseBy === 0` pour un volume, ou `containerCount === 0` ET nom hors
  `["bridge", "host", "none"]` pour un network — les 3 networks internes par défaut de Docker ne
  sont jamais des ressources à nettoyer (même exclusion par nom que `TopologyGraph.tsx#
  nodeMenuItems` côté suppression individuelle d'un network).
- **Exposition, choix délibéré.** Pas de route `GET /api/orphans` dédiée : `VolumesPage.tsx`/
  `NetworksPage.tsx` (déjà existantes, déjà alimentées par ces mêmes champs) portent un badge
  "Orphelin" par ligne, un filtre "Orphelins uniquement" (case à cocher au-dessus du tableau,
  compte affiché entre parenthèses) et une action groupée "Nettoyer les orphelins" dans l'en-tête
  de page — une vue séparée aurait été une pure redite de deux pages déjà existantes et déjà
  correctement alimentées.
- **Nettoyage réel, jamais automatique.** L'action groupée déclenche UNE seule confirmation
  explicite (`useConfirm()`, variante `danger`, décrit le nombre exact de ressources concernées et
  la perte de données pour un volume) puis des suppressions réelles séquentielles via les MÊMES
  routes/thunks que la suppression individuelle déjà existante (`DELETE /api/volumes/:name`/
  `DELETE /api/networks/:id`, `removeVolume`/`removeNetwork` de `docker.ts`) — pas une simulation,
  jamais de purge en tâche de fond, jamais sans ce clic explicite.

## CI/CD

- `.github/workflows/build.yml` : sur push vers `main` et sur tag, build multi-stage de `deploy/docker/Dockerfile.api` et `Dockerfile.web`, push vers `ghcr.io/<org>/quai-api` et `ghcr.io/<org>/quai-web`, tag `latest` + SHA court + tag Git le cas échéant.
- `deploy/compose/docker-compose.dev.yml` sert au développement local (api + web + LDAP de test type `osixia/openldap` + registry factice).
- Les manifestes `deploy/k8s/` et `deploy/swarm/` référencent les images GHCR publiées — c'est le mécanisme GitOps que QUAI pilote lui-même.
- `deploy/docker/Dockerfile.api.dev` installe les VRAIS binaires pilotés en sous-processus par l'API dev (aucun n'est réimplémenté) : OpenTofu/Ansible/Packer (infra-as-code), Grype ET OSV-Scanner (scan de vulnérabilités — binaire statique de release `osv-scanner_linux_${ARCH}`, téléchargé directement depuis `github.com/google/osv-scanner/releases`, pas de script d'installation officiel contrairement à Grype/OpenTofu), ainsi qu'un client Docker CLI (binaire statique officiel, socket déjà monté par docker-compose.dev.yml) requis par `osv-scanner scan image` pour résoudre une image locale — contrairement à Grype qui parle directement à l'API du démon. Reconstruire après modif : `docker compose -f deploy/compose/docker-compose.dev.yml build api && docker compose -f deploy/compose/docker-compose.dev.yml up -d api`.

## Conventions UI (`apps/web`) — pas de fenêtres natives du navigateur

Aucune boîte de dialogue native (`window.confirm`, `window.alert`, `window.prompt`) nulle part dans l'app. Tout passe par un composant `<Modal>` réutilisable (`apps/web/src/components/Modal.tsx`) cohérent avec l'identité visuelle sombre définie plus haut : overlay avec backdrop, fermeture au clic sur le backdrop et à `Échap` (sauf variante destructrice qui exige un clic explicite sur un bouton), focus trap, animation d'apparition respectant `prefers-reduced-motion`.

Variante `ConfirmDialog` (titre, description, bouton principal libellé selon l'action réelle — « Mettre à jour », « Déconnecter », « Resynchroniser », jamais « OK » générique — bouton secondaire « Annuler », variante `danger` avec bouton rouge pour les actions destructrices comme la suppression d'un registry). Utilisée pour : mise à jour d'image, déconnexion, suppression d'un registry, sortie de l'assistant de configuration avant la fin, fermeture d'un formulaire (LDAP, registry) avec changements non enregistrés.

Cas particulier : la boîte native « Leave site? » du navigateur (déclenchée par l'évènement `beforeunload`) est imposée par le navigateur lui-même et ne peut pas être stylisée — donc la règle est de **ne jamais déclencher `beforeunload`**. À la place, chaque étape de l'assistant de configuration est sauvegardée localement au fur et à mesure, et toute navigation interne à risque (changer de vue, fermer un formulaire) passe par le `ConfirmDialog` ci-dessus plutôt que par un mécanisme navigateur.

## Convention de code partagée

- TypeScript strict partout (`strict: true`), pas de `any` implicite.
- Noms de domaine en français dans l'UI (labels, messages), identifiants de code en anglais.
- Aucune valeur secrète en dur — tout passe par variables d'environnement, documentées dans un `.env.example` à la racine de chaque app.
