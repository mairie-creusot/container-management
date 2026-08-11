# QUAI — déploiement

Vue d'ensemble de tout ce qui vit sous `deploy/` et `.github/workflows/`.
Contrat de référence : voir `ARCHITECTURE.md` à la racine du repo
(sections "Layout du monorepo" et "CI/CD").

```
deploy/
  docker/     Dockerfile.api, Dockerfile.web, nginx.web.conf
  compose/    docker-compose.dev.yml (+ ldap/bootstrap.ldif)
  k8s/        manifestes Kubernetes d'exemple
  swarm/      stack.yml Docker Swarm d'exemple
.github/workflows/build.yml   CI : build + push GHCR
```

## 0. Piloter Docker : socket local vs Docker distant (TLS)

`apps/api` a besoin d'accéder à un démon Docker pour la partie Swarm/conteneurs. Deux façons de le brancher, à choisir selon où QUAI tourne par rapport à l'infrastructure à piloter :

- **QUAI tourne sur la même machine que le démon à piloter** (poste de dev avec Docker Desktop, ou un nœud manager Swarm à la mairie qui héberge aussi QUAI) : monter le socket Unix dans le conteneur `api` — `/var/run/docker.sock:/var/run/docker.sock`. C'est ce que font `docker-compose.dev.yml` et `swarm/stack.yml`. Fonctionne aussi sous Docker Desktop Windows/Mac (le socket est exposé par la VM Linux interne).
- **QUAI tourne ailleurs et pilote un ou plusieurs démons Docker distants** (ex : une instance QUAI unique sur un VPS qui administre les serveurs de la mairie) : exposer l'API Docker en TCP+TLS côté serveur cible (`dockerd -H tcp://0.0.0.0:2376 --tlsverify --tlscacert=... --tlscert=... --tlskey=...`), puis pointer `DOCKER_HOST=tcp://<hôte>:2376` côté `apps/api` avec les certificats client montés dans le conteneur. La variable `DOCKER_HOST` est déjà lue par `apps/api` (voir `.env.example`) ; **pas encore** de champ dédié dans l'assistant de configuration web pour saisir un hôte + des certificats — actuellement il ne teste que le socket/hôte par défaut de la machine où `apps/api` tourne. À ajouter avant un déploiement multi-hôtes en production.

Ne jamais exposer le socket Docker (ni l'API TCP sans TLS) sur un réseau non maîtrisé : un accès au socket Docker équivaut à un accès root sur l'hôte.

## 1. Builder les images en local

Le contexte de build est **toujours la racine du monorepo** (pas
`deploy/docker/`), car les Dockerfiles doivent voir tout le workspace pnpm
(`apps/*`, `packages/*`) pour résoudre les dépendances internes
(`@quai/wasm-core`).

```bash
# Depuis la racine du repo :
docker build -f deploy/docker/Dockerfile.api -t quai-api .
docker build -f deploy/docker/Dockerfile.web -t quai-web .

docker run --rm -p 3000:3000 \
  -e LDAP_URL=ldap://host.docker.internal:389 \
  quai-api

docker run --rm -p 8080:8080 quai-web
```

`Dockerfile.api` compile d'abord `packages/wasm-core` (stage `rust-builder`,
`rust:1-slim` + `wasm-pack`), puis construit `@quai/api` avec ce binding
(stage `build`, `node:22-slim` + pnpm), puis assemble une image finale
minimale via `pnpm --filter @quai/api deploy --prod`.

`Dockerfile.web` construit `@quai/web` (Vite) puis sert `apps/web/dist`
avec nginx (`nginx.web.conf`), en écoute sur le port **8080** en
utilisateur non-root (voir commentaires dans le Dockerfile pour le
raisonnement).

## 2. Développement local complet (api + web + LDAP de test)

```bash
docker compose -f deploy/compose/docker-compose.dev.yml up
```

- `api` : `http://localhost:3000` (mode dev, bind-mount + `pnpm dev`,
  hot-reload)
- `web` : `http://localhost:5173` (Vite dev server)
- `ldap` : `ldap://localhost:389`, base `dc=lecreusot,dc=fr`, peuplé au
  premier démarrage avec `deploy/compose/ldap/bootstrap.ldif` (utilisateurs
  `admin.test` / `operator.test` / `viewer.test`, groupes `dsi-admins` /
  `dsi-operators` — cohérent avec l'exemple de `LDAP_GROUP_ROLE_MAP` dans
  `ARCHITECTURE.md`)

Pour repartir d'un annuaire vierge : `docker compose ... down -v`.

Voir les commentaires en tête de
`deploy/compose/docker-compose.dev.yml` pour le détail des variables
d'environnement et l'option `env_file` commentée vers un éventuel
`apps/api/.env.example`.

## 3. Déployer sur Docker Swarm

```bash
docker swarm init   # si nécessaire

echo "un-mot-de-passe-fort" | docker secret create quai_ldap_bind_password -
echo "un-secret-jwt-fort"   | docker secret create quai_jwt_secret -

docker stack deploy -c deploy/swarm/stack.yml quai
```

Éditer `deploy/swarm/stack.yml` pour remplacer `ghcr.io/OWNER/quai-api` et
`ghcr.io/OWNER/quai-web` par le chemin réel des images publiées par la CI
(`ghcr.io/<owner GitHub>/quai-api` et `quai-web`). Les identifiants LDAP
sont injectés via des secrets Swarm montés dans `/run/secrets/` — voir la
note dans le fichier sur la convention `*_FILE` supposée côté API.

## 4. Déployer sur Kubernetes

```bash
kubectl apply -k deploy/k8s/
# ou, manifeste par manifeste :
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/secret.yaml       # après avoir remplacé les CHANGE_ME
kubectl apply -f deploy/k8s/api-deployment.yaml -f deploy/k8s/api-service.yaml
kubectl apply -f deploy/k8s/web-deployment.yaml -f deploy/k8s/web-service.yaml
kubectl apply -f deploy/k8s/ingress.yaml
```

Avant application : remplacer `ghcr.io/OWNER/quai-api` /
`ghcr.io/OWNER/quai-web` dans les `Deployment`, et le `host` dans
`ingress.yaml`. `secret.yaml` est un **template** — en production,
préférer le créer hors dépôt (`kubectl create secret ...`) ou via un
gestionnaire externe (Sealed Secrets, External Secrets Operator, Vault…).

## 5. CI/CD — `.github/workflows/build.yml`

- Déclenché sur push vers `main` et sur tags `v*`.
- Job matriciel `build` (api / web), permissions `contents: read` +
  `packages: write`.
- `docker/setup-buildx-action`, `docker/login-action` vers `ghcr.io`
  (`${{ github.actor }}` / `${{ secrets.GITHUB_TOKEN }}` — aucun secret
  supplémentaire à configurer pour GHCR tant que le repo est autorisé à
  publier des packages).
- `docker/metadata-action` calcule les tags : `latest` (uniquement sur
  `main`), SHA court (toujours), tag Git (uniquement si déclenché par un
  tag).
- `docker/build-push-action` avec `context: .` et `file:
  deploy/docker/Dockerfile.{api,web}`, cache GHA (`cache-from`/`cache-to
  type=gha`).
- Images publiées : `ghcr.io/<repository_owner>/quai-api` et
  `ghcr.io/<repository_owner>/quai-web`.

Aucun secret à configurer manuellement pour la CI (le `GITHUB_TOKEN`
suffit pour pousser vers GHCR sur ce même repo). Les secrets LDAP/JWT ne
sont nécessaires qu'au déploiement (Swarm : `docker secret create...` ;
Kubernetes : `deploy/k8s/secret.yaml` ou équivalent).

## Portée de ce dossier

Ce dossier ne définit que l'infrastructure de build/déploiement. Il ne
contient ni le code de `@quai/api` (dont la route `GET /health` supposée
par les healthchecks Docker/K8s), ni celui de `@quai/web`, ni le crate
`packages/wasm-core` — ces briques sont développées indépendamment (voir
`ARCHITECTURE.md`).
