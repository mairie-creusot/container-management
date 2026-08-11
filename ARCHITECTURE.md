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
  orchestrator: "swarm" | "kubernetes" | "compose" | "nutanix";
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

type SystemNotificationKind = "image_update_available" | "integration_unreachable" | "integration_reachable" | "gitops_drift_detected";

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

interface ScanResult {
  id: string;
  scanner: ScannerId;           // scanner à l'origine de ce résultat
  image: string;                // référence Docker passée au scanner, ex: "nginx:1.27"
  status: "running" | "success" | "failed";
  startedAt: string;            // ISO 8601
  finishedAt: string | null;
  vulnerabilities: Vulnerability[];
  summary: Record<VulnSeverity, number>;
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

Un utilisateur `admin` déjà authentifié peut rouvrir cet assistant depuis Paramètres (`POST /api/setup/reset` puis re-parcours des étapes) pour changer la configuration plus tard — dans ce cas l'app reste accessible en lecture pendant la reconfiguration, contrairement au tout premier lancement.

**Nouvelles routes** (voir liste complète ci-dessous) : chacune des routes `test/*` prend la config candidate dans le corps de la requête (pas la config déjà persistée) pour permettre de tester avant de sauvegarder, et ne modifie jamais l'état persisté.

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

GET  /api/environments
GET  /api/environments/:id/nodes
GET  /api/nutanix/vms                       # détail par VM (nom, powerState, vCPUs, mémoire, cluster physique) —
                                             # distinct de GET /api/environments (un nœud PAR CLUSTER PHYSIQUE,
                                             # compteur de VMs agrégé). Enfin branché sur services/nutanix.ts#
                                             # getNutanixVms(), jusque-là du code mort (appelé par aucune route) —
                                             # [] si Nutanix n'a jamais été configuré ou injoignable, jamais de VM
                                             # inventée. Consommé par EnvironmentsPage.tsx (section "VMs" de
                                             # l'environnement Nutanix) et par GET /api/topology ci-dessous.

GET    /api/images?status=update|uptodate   # images Docker réelles de l'hôte (docker.ts), démo en repli
POST   /api/images/:id/update               # pull réel du dernier tag connu (image locale) ou màj démo
DELETE /api/images/:id?force=true           # équivalent `docker rmi`, image locale uniquement
POST   /api/images/pull                     # { reference } — équivalent `docker pull`, retourne la liste rafraîchie

GET   /api/registries
POST  /api/registries
GET   /api/registries/:id
PATCH /api/registries/:id                              # { name?, url?, username?, password?, token? } — password/token
                                                         # omis ou vides = identifiant déjà enregistré conservé (voir
                                                         # setupStore.ts#updateRegistryAt). Icône engrenage sur chaque
                                                         # carte de RegistriesPage.tsx (admin uniquement).
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

GET  /api/containers
POST /api/containers   # { image, name?, ports?, env?, secretEnv?, volumes?, network? } — équivalent
                        # `docker run -d`. L'image doit déjà être locale : faire POST /api/images/pull
                        # avant si besoin. `env` : texte brut ("CLE=valeur"). `secretEnv` :
                        # { key, secretName }[], résolu côté serveur via le gestionnaire de secrets
                        # ci-dessus et fusionné dans l'Env final — secretName introuvable = 400 avant
                        # toute création. La gestion déclarative complète passe par GitOps (voir plus
                        # bas) ; ceci reste pensé pour tester vite en local.

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
                                          # à l'état "running" immédiatement (suivi par polling, voir ci-dessous)
GET  /api/images/:id/scans               # historique des scans d'une image, tous scanners confondus
GET  /api/scans/:scanId                  # détail + statut d'un scan (à poller pendant qu'il tourne)
GET  /api/scanners/status                # ScannerStatus[] — présence/version de grype et osv-scanner sur l'hôte

GET  /api/notifications?since=<ISO 8601>  # événements détectés par le watchdog (voir « Détection
                                           # proactive » ci-dessus), les plus récents d'abord
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
```

Toutes les routes (sauf `/api/auth/*` et `/api/setup/*`) exigent une session valide. Les routes `POST`/`PATCH`/`DELETE` exigent le rôle `operator` ou `admin`. Les routes `/api/setup/*` sont ouvertes tant que `completed=false` ; une fois `completed=true`, elles répondent `403` sauf pour un utilisateur `admin` authentifié (flux de reconfiguration). Exception plus stricte : les 3 routes mutantes de `/api/secrets/*` exigent explicitement `admin` (voir « Gestionnaire de secrets »), pas seulement `operator`. Autre exception, dans l'autre sens : `GET /api/console/:id` (upgrade WebSocket, donc une méthode `GET`) exige quand même explicitement `operator`/`admin` — ajouté par un hook `preHandler` propre à `routes/console.ts` car le hook global ne restreint par rôle que les méthodes mutantes (voir « Console interactive dans un conteneur »).

## Graphe de topologie (`apps/web/src/components/TopologyGraph.tsx`)

Le graphe visuel (React Flow, `GET /api/topology` — voir « Routes API » ci-dessus) a cinq
particularités, les quatre premières purement côté client (aucune donnée d'infrastructure
supplémentaire nécessaire côté `apps/api`), la cinquième (santé des conteneurs) nécessitant un
appel Docker additionnel côté API :

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
2. **Canevas libre et persistant.** La position d'un nœud déplacé à la main (drag React Flow
   standard, `onNodesChange`/`onNodeDragStop`) est conservée par id de nœud dans `localStorage`
   (clé `quai:topology:positions`) — elle survit au rafraîchissement périodique (15s) et à un
   rechargement de page. C'est une préférence d'affichage locale à l'utilisateur, pas une donnée
   d'infrastructure : aucune route API dédiée. Un nœud jamais vu (absent du localStorage) reçoit
   toujours une position par défaut selon le placement en 4 colonnes (volumes / conteneurs /
   networks / VMs Nutanix) historique. Une `<MiniMap>` (`@xyflow/react`) est ancrée en bas à droite
   du canevas, stylée comme les autres contrôles React Flow du thème sombre.
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
