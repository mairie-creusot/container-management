# @quai/api

Serveur Fastify de QUAI : intégrations Docker Engine/Swarm et Kubernetes, clients registries
(Docker Hub, GHCR, GitLab), moteur GitOps (diff via `@quai/wasm-core`), authentification LDAP
avec session JWT en cookie. Voir [ARCHITECTURE.md](../../ARCHITECTURE.md) à la racine du
monorepo pour le contrat technique complet (contrats de données, routes, auth LDAP, interface
WASM).

## Démarrage rapide (dev)

```bash
# depuis la racine du monorepo
pnpm install
cp apps/api/.env.example apps/api/.env   # puis ajuster si besoin
pnpm dev:api
# ou directement :
pnpm --filter @quai/api dev
```

Le serveur démarre sur `http://localhost:3000` (variable `PORT`). Un endpoint `GET /healthz`
est exposé pour les sondes de liveness (hors périmètre `/api/*`, non protégé).

## Fonctionnement en l'absence d'intégrations réelles (fallback de développement)

**Aucune de ces intégrations n'est requise pour lancer le serveur en dev.** Si le démon
Docker n'est pas joignable, si aucun kubeconfig valide n'est trouvé, ou si les appels réseau
vers les registries publics échouent, l'API retombe automatiquement sur un jeu de données de
démonstration en mémoire (`src/services/demoData.ts`) : trois environnements (Prod/Swarm à 3
nœuds, Staging/Kubernetes à 5 nœuds dont un en "crit", Dev local/Compose à 1 nœud), six images
suivies (nginx, ghcr.io/ville-lecreusot/portail-citoyen, postgres,
registry.gitlab.com/mairie/api-etat-civil, redis, ghcr.io/ville-lecreusot/keycloak-theme), des
registries, conteneurs, manifestes GitOps et un historique de commits.

**Ce n'est pas un mock permanent** : chaque service d'intégration (`docker.ts`,
`kubernetes.ts`, `registries/*.ts`, `gitops.ts`) tente d'abord la vraie intégration et ne
bascule sur la démo qu'en cas d'échec (non configuré, timeout, erreur réseau).

## Variables d'environnement

Voir [.env.example](./.env.example) pour la liste complète et documentée. Points clés :

- **Session/JWT** : `JWT_SECRET` (à changer en production), `JWT_EXPIRES_IN`,
  `JWT_REFRESH_EXPIRES_IN`, `COOKIE_NAME`, `COOKIE_SECURE`.
- **LDAP** : `LDAP_URL`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`, `LDAP_SEARCH_BASE`,
  `LDAP_SEARCH_FILTER` (`{{username}}` substitué), `LDAP_GROUP_ROLE_MAP` (JSON, DN de groupe
  -> rôle), `LDAP_DEFAULT_ROLE`.
- **Docker** : `DOCKER_HOST` (optionnel — sinon socket par défaut de l'OS).
- **Kubernetes** : `KUBECONFIG` (optionnel — sinon repli sur la démo).
- **Registries** : `REGISTRY_REQUEST_TIMEOUT_MS`, identifiants optionnels par registry.
- **GitOps** : `GITOPS_REPO_PATH`, `GITOPS_REPO_URL` (optionnel, clone/pull automatique),
  `GITOPS_BRANCH`, identifiants Git optionnels.
- **Assistant de configuration** : `CONFIG_PATH` (fichier JSON persistant l'état de
  l'assistant premier lancement, cf. section dédiée ci-dessous).

## Assistant de configuration au premier lancement

Au tout premier démarrage (aucun `CONFIG_PATH` persisté), `GET /api/setup/status` répond
`completed: false` et l'ensemble des routes `/api/setup/*` est ouvert sans authentification
(l'app n'est pas encore utilisable). L'assistant : bind LDAP obligatoire (testable via
`POST /api/setup/test/ldap` avant validation), Docker/Kubernetes optionnels (`test/docker`,
`test/kubernetes`), registries optionnels (`test/registry`), puis `POST /api/setup/complete`
persiste la config dans `CONFIG_PATH` et bascule `completed` à `true`. Un admin authentifié
peut rouvrir l'assistant via `POST /api/setup/reset`. Une fois `completed=true`, toutes les
routes `/api/setup/*` exigent une session avec le rôle `admin` (401 sans session, 403 sinon).
Voir [ARCHITECTURE.md](../../ARCHITECTURE.md) pour le détail du flux côté `apps/web`.

## Authentification

- `POST /api/auth/login` — `{ username, password }` → bind LDAP (config de l'assistant si
  persistée, sinon `LDAP_*`), mapping groupes → rôles, pose un cookie de session `httpOnly`
  + `secure` (selon `COOKIE_SECURE`) + `sameSite=strict`.
- `POST /api/auth/logout` — efface le cookie.
- `GET /api/session` — retourne la session courante (401 si non authentifié).
- Toutes les routes `/api/*` (sauf `/api/auth/*` et `/api/setup/*` tant que non terminé)
  exigent une session valide (401 sinon).
- Les routes `POST` (mutation) exigent le rôle `operator` ou `admin` (403 sinon).

## Endpoints

```
GET  /healthz                          — sonde de liveness, non protégée

GET  /api/setup/status
POST /api/setup/test/ldap
POST /api/setup/test/docker
POST /api/setup/test/kubernetes
POST /api/setup/test/registry
POST /api/setup/complete
POST /api/setup/reset                  — admin authentifié uniquement

GET  /api/session
POST /api/auth/login
POST /api/auth/logout

GET  /api/environments
GET  /api/environments/:id/nodes

GET  /api/images?status=update|uptodate
POST /api/images/:id/update

GET  /api/registries
POST /api/registries
GET  /api/registries/:id

GET  /api/containers

GET  /api/gitops/files
GET  /api/gitops/files/:path/diff       — :path URL-encodé (ex: prod%2Fnginx.yaml)
GET  /api/gitops/commits
POST /api/gitops/sync
```

## Tests

```bash
pnpm --filter @quai/api test
```

Les tests couvrent notamment le mapping des groupes LDAP vers les rôles applicatifs
(`test/ldap.test.ts`) et le comportement des routes en mode "données de démo"
(`test/environments.test.ts`) : 401 sans session, 200 avec une session valide, 403 sur une
route `POST` avec le rôle `viewer`, 201 avec le rôle `operator`.

## Build / production

```bash
pnpm --filter @quai/api build
pnpm --filter @quai/api start
```

## Limites connues de ce premier lot

- Pas de persistance disque/DB pour les registries ajoutés via `POST /api/registries` (en
  mémoire, réinitialisé au redémarrage).
- `POST /api/images/:id/update` met à jour le suivi en mémoire ; le déclenchement réel du
  redéploiement (`docker service update` / `kubectl set image`) n'est pas encore implémenté.
- La reconstruction de l'état "réel" GitOps à partir du cluster est une correspondance de
  noms best-effort (voir commentaires dans `src/services/gitops.ts`), pas une lecture fidèle
  et exhaustive des ressources du cluster.
- `@quai/wasm-core` étant développé en parallèle, `src/services/gitops.ts` utilise un repli
  JS (diff par LCS ligne à ligne) tant que le package n'est pas buildable ; le vrai module
  wasm est utilisé automatiquement dès qu'il est disponible dans le workspace.
- La config LDAP effective (`src/services/setupStore.ts#getEffectiveLdapConfig`) est bien
  branchée sur l'assistant de configuration (persistée > variables d'environnement). En
  revanche `src/services/docker.ts` et `src/services/kubernetes.ts` ne lisent pour l'instant
  la config candidate de l'assistant que dans leurs fonctions `test*Connection` (utilisées
  par `POST /api/setup/test/docker|kubernetes`) ; le reste de l'app (listing des
  environnements/conteneurs) continue de lire `DOCKER_HOST`/`KUBECONFIG` directement — brancher
  ces deux services sur la config persistée de l'assistant est un prolongement naturel mais
  non fait dans ce premier lot.
