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

GET  /api/registries
POST /api/registries
GET  /api/registries/:id
GET  /api/registries/:id/repositories                 # vrai catalogue distant (GHCR/Docker Hub), pas juste le local
GET  /api/registries/:id/repositories/:repo/tags       # tags d'un dépôt du catalogue (:repo encodé)

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
```

Toutes les routes (sauf `/api/auth/*` et `/api/setup/*`) exigent une session valide. Les routes `POST` exigent le rôle `operator` ou `admin`. Les routes `/api/setup/*` sont ouvertes tant que `completed=false` ; une fois `completed=true`, elles répondent `403` sauf pour un utilisateur `admin` authentifié (flux de reconfiguration).

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
