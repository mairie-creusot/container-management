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

- **apps/web** — TypeScript, React, Redux Toolkit, Vite.
- **apps/api** — TypeScript, Node.js (Fastify), pilote Docker Engine/Swarm (dockerode), Kubernetes (@kubernetes/client-node) et Nutanix (API REST v3 de Prism Central, `node:https`), clients registries, moteur GitOps, auth LDAP (ldapjs) + session JWT.
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

interface Session {
  username: string;
  displayName: string;
  roles: ("admin" | "operator" | "viewer")[];
}

type SystemNotificationKind = "image_update_available" | "integration_unreachable" | "integration_reachable";

interface SystemNotificationEvent {
  id: string;
  timestamp: string;            // ISO 8601
  kind: SystemNotificationKind;
  level: "error" | "success" | "info";
  message: string;              // concret et actionnable, ex: "Nouvelle version disponible pour nginx:1.25 -> 1.27"
  read: boolean;
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
- `notifications-log.jsonl` — un événement par ligne (`SystemNotificationEvent`, voir « Contrats de données »), jamais réécrit, exposé par `GET /api/notifications`.
- `notifications-read-state.json` — un curseur temporel (`readAllBeforeIso`) plutôt qu'un ensemble d'ids lus : `POST /api/notifications/read-all` le positionne à l'instant présent, un événement est considéré lu s'il est antérieur ou égal à ce curseur.

Chaque message est concret et actionnable (jamais de texte générique) : ex. `"Nouvelle version disponible pour nginx:1.25 -> 1.27"`, `"Kubernetes injoignable depuis 11:42"`, `"Kubernetes de nouveau joignable"`.

Côté `apps/web`, `notificationsSlice.ts` récupère ces événements au chargement puis les repolle (`App.tsx`, indépendant de la vue affichée) et les fusionne par id dans le même état que les notifications purement client existantes (`pushNotification`/`errorNotificationMiddleware.ts`, inchangées) — un événement système apparaît donc à la fois en toast (`ToastStack.tsx`) et dans l'historique (`NotificationsPage.tsx`) sans code supplémentaire dans ces deux composants.

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

GET  /api/containers
POST /api/containers   # { image, name?, ports? } — équivalent `docker run -d`, flux minimal
                        # (pas de volumes/env/réseau/restart policy). L'image doit déjà être
                        # locale : faire POST /api/images/pull avant si besoin. Volontairement
                        # minimal — la gestion déclarative passe par GitOps (voir plus bas) ;
                        # ceci ne sert qu'à tester vite en local.

GET  /api/gitops/files
GET  /api/gitops/files/:path/diff
GET  /api/gitops/commits
POST /api/gitops/sync

GET  /api/topology                       # graphe visuel (conteneurs/volumes/networks + relations réelles),
                                          # nœuds "conteneur" enrichis de cpuPercent/memBytes/updateAvailable/drift
POST /api/containers/:id/rename          # { name } — équivalent `docker rename`
POST /api/networks/:id/connect           # { containerId } — équivalent `docker network connect`
POST /api/networks/:id/disconnect        # { containerId } — équivalent `docker network disconnect`

GET  /api/notifications?since=<ISO 8601>  # événements détectés par le watchdog (voir « Détection
                                           # proactive » ci-dessus), les plus récents d'abord
POST /api/notifications/read-all          # marque tous les événements connus comme lus (operator/admin)
```

Toutes les routes (sauf `/api/auth/*` et `/api/setup/*`) exigent une session valide. Les routes `POST` exigent le rôle `operator` ou `admin`. Les routes `/api/setup/*` sont ouvertes tant que `completed=false` ; une fois `completed=true`, elles répondent `403` sauf pour un utilisateur `admin` authentifié (flux de reconfiguration).

## Graphe de topologie (`apps/web/src/components/TopologyGraph.tsx`)

Le graphe visuel (React Flow, `GET /api/topology` — voir « Routes API » ci-dessus) a trois
particularités, toutes côté client uniquement (aucune donnée d'infrastructure supplémentaire
n'est nécessaire côté `apps/api`) :

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
   toujours une position par défaut selon le placement en 3 colonnes (volumes / conteneurs /
   networks) historique. Une `<MiniMap>` (`@xyflow/react`) est ancrée en bas à droite du canevas,
   stylée comme les autres contrôles React Flow du thème sombre.
3. **Zoom sémantique.** Sous un seuil de zoom (`ZOOM_DETAIL_THRESHOLD = 0.6`, lu via
   `useStore((s) => s.transform[2])` à l'intérieur même du composant de nœud), un nœud se réduit à
   son icône et son point de statut — libellé, sous-titre, badges et métriques CPU/mémoire
   s'effacent en fondu (transition CSS 0.15s, désactivée sous `prefers-reduced-motion`, même
   pattern que le reste du site depuis la passe micro-interactions). Au-dessus du seuil, détail
   complet comme avant.

## CI/CD

- `.github/workflows/build.yml` : sur push vers `main` et sur tag, build multi-stage de `deploy/docker/Dockerfile.api` et `Dockerfile.web`, push vers `ghcr.io/<org>/quai-api` et `ghcr.io/<org>/quai-web`, tag `latest` + SHA court + tag Git le cas échéant.
- `deploy/compose/docker-compose.dev.yml` sert au développement local (api + web + LDAP de test type `osixia/openldap` + registry factice).
- Les manifestes `deploy/k8s/` et `deploy/swarm/` référencent les images GHCR publiées — c'est le mécanisme GitOps que QUAI pilote lui-même.

## Conventions UI (`apps/web`) — pas de fenêtres natives du navigateur

Aucune boîte de dialogue native (`window.confirm`, `window.alert`, `window.prompt`) nulle part dans l'app. Tout passe par un composant `<Modal>` réutilisable (`apps/web/src/components/Modal.tsx`) cohérent avec l'identité visuelle sombre définie plus haut : overlay avec backdrop, fermeture au clic sur le backdrop et à `Échap` (sauf variante destructrice qui exige un clic explicite sur un bouton), focus trap, animation d'apparition respectant `prefers-reduced-motion`.

Variante `ConfirmDialog` (titre, description, bouton principal libellé selon l'action réelle — « Mettre à jour », « Déconnecter », « Resynchroniser », jamais « OK » générique — bouton secondaire « Annuler », variante `danger` avec bouton rouge pour les actions destructrices comme la suppression d'un registry). Utilisée pour : mise à jour d'image, déconnexion, suppression d'un registry, sortie de l'assistant de configuration avant la fin, fermeture d'un formulaire (LDAP, registry) avec changements non enregistrés.

Cas particulier : la boîte native « Leave site? » du navigateur (déclenchée par l'évènement `beforeunload`) est imposée par le navigateur lui-même et ne peut pas être stylisée — donc la règle est de **ne jamais déclencher `beforeunload`**. À la place, chaque étape de l'assistant de configuration est sauvegardée localement au fur et à mesure, et toute navigation interne à risque (changer de vue, fermer un formulaire) passe par le `ConfirmDialog` ci-dessus plutôt que par un mécanisme navigateur.

## Convention de code partagée

- TypeScript strict partout (`strict: true`), pas de `any` implicite.
- Noms de domaine en français dans l'UI (labels, messages), identifiants de code en anglais.
- Aucune valeur secrète en dur — tout passe par variables d'environnement, documentées dans un `.env.example` à la racine de chaque app.
