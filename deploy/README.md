# QUAI — déploiement

Vue d'ensemble de tout ce qui vit sous `deploy/` et `.github/workflows/`.
Contrat de référence : voir `ARCHITECTURE.md` à la racine du repo
(sections "Layout du monorepo" et "CI/CD").

```
deploy/
  docker/     Dockerfile.api, Dockerfile.web, Dockerfile.caddy, nginx.web.conf
  compose/    docker-compose.dev.yml, docker-compose.prod.yml, nginx.prod.conf,
              .env.prod.example (+ ldap/bootstrap.ldif, caddy/Caddyfile)
  k8s/        manifestes Kubernetes d'exemple
  swarm/      stack.yml Docker Swarm d'exemple
.gitlab-ci.yml                GitLab interne (dépôt principal) : contrôle + déploiement — § 6
.github/workflows/build.yml   GitHub (secours) : build + push GHCR — § 5
```

**Dépôt principal : le GitLab de la mairie** (`https://gitlab.lecreusot.priv/`, publié derrière QUAI depuis le 25/08/2026, certificat AD CS — voir § 6.3). GitHub reste en
secours, son workflow est toujours valide et n'a pas été touché.

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

## 5. CI/CD GitHub (secours) — `.github/workflows/build.yml`

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

## 6. CI/CD GitLab interne (dépôt principal) — `.gitlab-ci.yml`

C'est le chemin de déploiement réel de QUAI à la mairie. QUAI tourne **sur la machine qui héberge
GitLab** (172.16.13.2) : le runner y construit les images et démarre les conteneurs directement sur
le démon Docker de cette machine.

Le pipeline a deux étapes :

| Étape | Job | Ce qu'il fait | Quand |
| --- | --- | --- | --- |
| `controle` | `controle:api` | `tsc --noEmit` puis `vitest run` sur `@quai/api` | à chaque push / merge request |
| `controle` | `controle:web` | `tsc --noEmit` puis `vitest run` sur `@quai/web` | à chaque push / merge request |
| `deploiement` | `deploiement:production` | construit les images de prod et `docker compose up -d` sur l'hôte | branche par défaut uniquement, **automatique** si les deux contrôles sont verts |

`packages/wasm-core` (Rust) n'est pas testé dans l'étape de contrôle : ces jobs tournent dans une
image Node sans toolchain Rust. Son binding est compilé dans le stage `rust-builder` de
`Dockerfile.api` au moment du déploiement — même découpage que la CI GitHub. `@quai/api` importe
`@quai/wasm-core` dynamiquement avec un repli JS, donc `tsc` et `vitest` passent sans lui.

### 6.1 Le piège Docker-outside-of-Docker (déjà rencontré sur ce projet)

Avec un runner en exécuteur Docker et le socket de l'hôte monté, le client `docker` s'exécute
**dans le conteneur du job**, mais le démon qui exécute les ordres est celui de **l'hôte**.
Conséquence : un `volumes: ./fichier:/chemin` dans le compose est résolu **sur l'hôte**, où le dépôt
n'est pas déployé. Docker y crée alors un répertoire vide et le monte à la place du fichier attendu
— sans le moindre message d'erreur. C'est exactement ce qui avait cassé le déploiement GitHub.

Correction appliquée : **plus aucun bind mount de fichier du dépôt dans
`docker-compose.prod.yml`**. Toute configuration est intégrée aux images au build :

- `deploy/docker/Dockerfile.web` accepte `--build-arg WEB_NGINX_CONF=<chemin depuis la racine>` et
  copie ce fichier dans l'image. Défaut inchangé : `deploy/docker/nginx.web.conf` (Kubernetes et
  Swarm ne changent pas). Le compose de production passe `deploy/compose/nginx.prod.conf`.
- `deploy/docker/Dockerfile.caddy` (nouveau) copie `deploy/compose/caddy/Caddyfile` dans l'image
  Caddy, et valide le fichier au build.

Le seul montage restant est `/var/run/docker.sock` sur le service `api` : c'est une vraie ressource
de l'hôte, pas un fichier du dépôt — il est correct et nécessaire.

Le contexte de build, lui, fonctionne sans rien de particulier : il est envoyé depuis le conteneur
du job vers le démon de l'hôte, donc les fichiers du dépôt sont bien lus au bon endroit.

Vérification après un déploiement, sur l'hôte :

```bash
docker exec quai-web-1 head -1 /etc/nginx/conf.d/default.conf
# doit afficher la première ligne de nginx.prod.conf ("Config nginx de PRODUCTION (compose) ...")
docker exec quai-web-1 grep -c 'proxy_pass http://api:3000' /etc/nginx/conf.d/default.conf   # -> 1
```

### 6.2 Créer le projet et pousser le dépôt

1. Sur `https://172.16.13.2:4443/`, **New project > Create blank project**, nom `quai`, visibilité
   *Private*, et **décocher « Initialize repository with a README »** (le dépôt existe déjà).
2. Sur le poste, faire de GitLab le dépôt principal et garder GitHub en secours :

```bash
cd /chemin/vers/container-management
git remote rename origin github
git remote add origin https://172.16.13.2:4443/<groupe>/quai.git
git remote -v            # origin = GitLab, github = secours
```

3. Certificat auto-signé : voir 6.3 avant de pousser, sinon `git push` échoue sur
   `SSL certificate problem: self-signed certificate`.
4. Pousser :

```bash
git push -u origin main
```

Par la suite, pousser sur les deux quand c'est utile : `git push origin main && git push github main`.

### 6.3 GitLab publié derrière QUAI, certificat émis par l'AD CS

Depuis le 25/08/2026, GitLab n'expose plus son propre TLS : il est publié comme n'importe quel
autre service, derrière le reverse proxy de QUAI, qui présente un certificat émis et **renouvelé
automatiquement** par l'autorité de la collectivité. Plus aucun certificat auto-signé à approuver,
ni côté poste de développement, ni côté runner.

Deux routes existent dans la page Publication :

| Sous-domaine | Cible | Rôle |
|---|---|---|
| `gitlab.lecreusot.priv` | `172.16.13.2:8090` | interface web et API |
| `registry.lecreusot.priv` | `172.16.13.2:5050` | registre d'images |

Côté GitLab (`docker-compose.yml` de la pile GitLab), la configuration correspondante :

```ruby
external_url 'https://gitlab.lecreusot.priv'
nginx['listen_port'] = 80
nginx['listen_https'] = false
nginx['proxy_set_headers'] = { 'X-Forwarded-Proto' => 'https', 'X-Forwarded-Ssl' => 'on' }
gitlab_rails['trusted_proxies'] = ['172.16.13.2']
registry_external_url 'https://registry.lecreusot.priv'
registry_nginx['listen_port'] = 5050
registry_nginx['listen_https'] = false
```

**Cibler l'hôte, pas le conteneur.** Caddy et GitLab vivent sur deux réseaux Docker distincts,
entre lesquels Docker bloque le trafic : une route visant l'IP du conteneur GitLab répondrait 502.
D'où les cibles `172.16.13.2:<port publié>`.

**Le runner a besoin de la racine AD CS**, car il tourne sous Linux et ne connaît que les autorités
publiques. Trois pièges rencontrés lors de la bascule, dans l'ordre où ils se présentent :

1. Le service GitLab déclare `hostname: 'gitlab.lecreusot.priv'` (et parfois un alias réseau du
   même nom) : à l'intérieur du réseau Docker, ce nom résout vers le **conteneur**, où plus rien
   n'écoute en 443. Forcer le passage par le proxy avec `extra_hosts: ["gitlab.lecreusot.priv:172.16.13.2"]`
   sur le service `gitlab-runner`.
2. L'image du runner n'installe dans le magasin système que le fichier nommé exactement
   `certs/ca.crt` — un certificat nommé d'après l'hôte n'y est pas repris.
3. Le runner lit **aussi** `certs/<hôte>.crt` de lui-même, et un PEM exporté depuis Windows peut
   être refusé par son analyseur là où OpenSSL l'accepte (`Failed to parse PEM`). Le normaliser :
   `openssl x509 -in fichier -outform PEM -out fichier.clean`.

Récupérer la racine depuis n'importe quelle machine du domaine :

```powershell
$c = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -like "*HDVAD1-CA-ROOT*" }
"-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($c.RawData,'InsertLineBreaks') + "`n-----END CERTIFICATE-----" | Set-Content adcs-root.pem -Encoding ascii
```

Vérifier qu'elle valide bien le certificat servi (sujet et émetteur identiques = c'est une racine) :

```bash
echo | openssl s_client -connect gitlab.lecreusot.priv:443 2>/dev/null | openssl x509 > /tmp/leaf.pem
openssl verify -CAfile adcs-root.pem /tmp/leaf.pem   # doit répondre OK
```

### 6.4 Variables CI/CD à créer

**Settings > CI/CD > Variables > Add variable.** Type *Variable* sauf mention contraire.

*Protected* = la variable n'est fournie qu'aux jobs des branches et tags protégés. `main` étant
protégée par défaut, et le déploiement ne tournant que sur la branche par défaut, cochez-la partout.
*Masked* = la valeur est remplacée par `[MASKED]` dans les journaux ; GitLab ne l'accepte que si la
valeur fait au moins 8 caractères, tient sur une ligne et ne contient ni espace ni caractère exotique
— d'où les « non » ci-dessous, qui ne concernent que des valeurs non secrètes.

Obligatoires — le job de déploiement s'arrête net, avant toute modification de l'hôte, si l'une
manque :

| Variable | Contenu attendu | Protected | Masked |
| --- | --- | --- | --- |
| `QUAI_PUBLIC_URL` | URL par laquelle les navigateurs joignent QUAI, ex. `https://quai.lecreusot.priv` (sert aussi d'origine CORS et de lien de retour dans les tickets GLPI) | oui | non (contient `://`) |
| `JWT_SECRET` | secret de signature des sessions — `openssl rand -hex 32` | oui | oui |
| `CONFIG_ENCRYPTION_KEY` | clé de chiffrement de `config.json` — `openssl rand -hex 32`. **À sauvegarder hors de la machine** : sans elle, les configurations Nutanix/HYCU/GLPI/3CX sont irrécupérables | oui | oui |
| `LDAP_URL` | annuaire réel, ex. `ldaps://dc01.lecreusot.priv:636` | oui | non (contient `://`) |
| `LDAP_BIND_DN` | compte de service **en lecture seule**, ex. `CN=svc-quai,OU=Services,OU=ville-du-Creusot,DC=lecreusot,DC=priv` | oui | non (contient `=` et `,`) |
| `LDAP_BIND_PASSWORD` | mot de passe de ce compte | oui | oui |
| `LDAP_SEARCH_BASE` | racine de recherche couvrant **toutes** les OU d'utilisateurs autorisés, ex. `OU=ville-du-Creusot,DC=lecreusot,DC=priv` — une OU oubliée donne « identifiants invalides » sans autre explication | oui | non |

Optionnelles — une valeur par défaut raisonnable est appliquée si vous ne les créez pas :

| Variable | Défaut | Quand la créer |
| --- | --- | --- |
| `LDAP_SEARCH_FILTER` | `(&(objectClass=user)(\|(sAMAccountName={{username}})(userPrincipalName={{username}})))` | annuaire non standard |
| `LDAP_GROUP_ROLE_MAP` | `{}` | pour donner les rôles `admin`/`operator`, ex. `{"CN=QUAI-Admins,OU=Groupes,DC=lecreusot,DC=priv":"admin"}` |
| `LDAP_DEFAULT_ROLE` | `viewer` | rôle des utilisateurs ne correspondant à aucun groupe |
| `COOKIE_SECURE` | `true` | `false` **uniquement** si QUAI est servi en HTTP simple, sinon le navigateur refuse le cookie de session et la connexion échoue silencieusement |
| `QUAI_HTTP_PORT` | `8080` | si 8080 est déjà pris sur l'hôte |
| `QUAI_PROXY_HTTP_PORT` | `80` | **à prévoir** : GitLab occupe généralement déjà 80 sur cette machine — mettre par exemple `8081`, sinon le démarrage échoue sur « port is already allocated » |
| `QUAI_PROXY_HTTPS_PORT` | `443` | idem, par exemple `8443` |
| `QUAI_GITLAB_CA_PEM` | — | type **File**, certificat du GitLab interne (voir 6.3, solution A) |
| `NODE_IMAGE` / `DOCKER_CLI_IMAGE` | `node:22-slim` / `docker:29-cli` | pour pointer vers un miroir interne d'images |

Deux remarques :

- Le job **écrit** ces variables dans un fichier `.env` temporaire, dans son propre répertoire de
  travail, avec `umask 077`, sans jamais l'afficher, et le supprime en fin de job (y compris en
  cas d'échec). Rien n'est écrit dans le dépôt.
- Évitez le caractère `$` dans les mots de passe : Docker Compose l'interprète dans un fichier
  `.env`. Si c'est inévitable, doublez-le (`$$`).

### 6.4.1 Faire confiance aux autorités internes (`INTERNAL_CA_BUNDLE_B64`, facultatif)

L'API appelle des services internes en HTTPS (GLPI, registry GitLab, futurs sous-domaines publiés).
Le conteneur ne connaît que les autorités publiques : un certificat émis par l'AD CS de la
collectivité, ou auto-signé, fait échouer l'appel **avant toute authentification** — `fetch failed`
côté GLPI, `DEPTH_ZERO_SELF_SIGNED_CERT` côté registry GitLab (constaté le 25/08/2026).

Rassemblez les certificats concernés dans un seul fichier PEM (racine AD CS, et le certificat
auto-signé de chaque service qui n'en a pas encore reçu un), puis créez la variable CI/CD
`INTERNAL_CA_BUNDLE_B64` avec son contenu encodé :

```
base64 -w0 internal-ca.pem
```

Le prochain déploiement intègre ce bundle à l'image de l'API (`NODE_EXTRA_CA_CERTS`), **en plus**
des autorités publiques. Variable absente = comportement inchangé. Un contenu qui n'est pas un PEM
fait échouer le build plutôt que de livrer une image qui ne ferait confiance à rien.

Récupérer la racine de l'AD CS : `https://hdvad1.lecreusot.priv/certsrv` → « Télécharger un
certificat d'autorité de certification » → format Base 64. Récupérer un certificat auto-signé
présenté par un service : `echo | openssl s_client -connect hote:port 2>/dev/null | openssl x509`.

### 6.5 Configuration du runner

Le runner doit tourner **sur la machine 172.16.13.2**, en exécuteur Docker, avec le socket Docker de
l'hôte monté dans les conteneurs de job. Sans ce montage, le job de déploiement s'arrête
immédiatement avec un message expliquant exactement quoi ajouter — rien n'est déployé à moitié.

Récupérer le jeton dans **Settings > CI/CD > Runners > New project runner** (cocher « Run untagged
jobs », étiquette `quai-hote`), puis :

```bash
sudo gitlab-runner register \
  --non-interactive \
  --url https://172.16.13.2:4443/ \
  --token <jeton affiché par GitLab> \
  --executor docker \
  --docker-image docker:29-cli \
  --docker-volumes /var/run/docker.sock:/var/run/docker.sock \
  --docker-volumes /cache \
  --tag-list quai-hote \
  --run-untagged=true \
  --tls-ca-file /etc/gitlab-runner/certs/gitlab-mairie.crt
```

Résultat attendu dans `/etc/gitlab-runner/config.toml` :

```toml
concurrent = 2

[[runners]]
  name = "quai-hote"
  url = "https://172.16.13.2:4443/"
  executor = "docker"
  tls_ca_file = "/etc/gitlab-runner/certs/gitlab-mairie.crt"
  [runners.docker]
    image = "docker:29-cli"
    privileged = false
    volumes = ["/var/run/docker.sock:/var/run/docker.sock", "/cache"]
```

Après toute modification manuelle du fichier : `sudo systemctl restart gitlab-runner`.

Points à ne pas manquer :

- `privileged = false` et **aucun service `dind`** : on utilise le démon de l'hôte, pas un Docker
  imbriqué. C'est voulu — c'est ce qui permet aux conteneurs QUAI de survivre à la fin du job.
- L'étiquette `quai-hote` est exigée par le job de déploiement (`tags:` dans `.gitlab-ci.yml`).
  Si vous préférez un runner sans étiquette, supprimez les deux lignes `tags:` du fichier.
- « Run untagged jobs » doit rester coché, sinon les jobs de contrôle (sans étiquette) restent en
  attente indéfiniment.
- Monter le socket Docker revient à donner un accès root sur l'hôte à tout job de ce runner :
  réservez ce runner au projet QUAI, ne le partagez pas à l'instance entière.

### 6.6 Déployer et vérifier

1. Pousser sur `main`. Le pipeline démarre : `controle:api` et `controle:web` doivent passer au vert.
2. Ouvrir **Build > Pipelines**, cliquer sur le pipeline, puis sur le bouton ▶ du job
   `deploiement:production`. Rien ne part sans cette action.
3. Suivre le journal, il annonce ses cinq étapes : accès au démon Docker, variables obligatoires,
   génération du fichier d'environnement, construction des images, démarrage et attente de l'état
   « healthy » (3 minutes maximum, sinon le job échoue).

Vérifier ensuite, **sur l'hôte 172.16.13.2** :

```bash
docker compose -p quai ps          # api, web et caddy en "running (healthy)"
curl -I http://127.0.0.1:8080/healthz
docker compose -p quai logs --tail=50 api
```

`docker compose -p quai <commande>` fonctionne sans `-f` : Compose retrouve le projet grâce aux
libellés des conteneurs. Puis ouvrir `QUAI_PUBLIC_URL` dans un navigateur et se connecter avec un
compte de l'annuaire.

Les données persistent dans le volume Docker `quai_quai_data` (config chiffrée, secrets, journal
d'audit, catalogue de templates, positions du graphe) — un redéploiement ne les efface pas.
`docker compose -p quai down -v` les détruirait : à ne jamais taper sur cette machine.

### 6.7 Si ça ne marche pas

| Symptôme | Cause probable |
| --- | --- |
| Le job reste « pending » | Aucun runner ne porte l'étiquette `quai-hote`, ou « Run untagged jobs » est décoché pour les jobs de contrôle |
| `ÉCHEC : /var/run/docker.sock est absent` | `volumes = [...]` manquant dans `config.toml` (voir 6.5), ou runner non redémarré |
| `ÉCHEC : variables CI/CD absentes ou vides` | Variable non créée, ou cochée *Protected* alors que la branche ne l'est pas |
| `port is already allocated` | GitLab occupe 80/443 : définir `QUAI_PROXY_HTTP_PORT` / `QUAI_PROXY_HTTPS_PORT` |
| `SSL certificate problem: self-signed certificate` au clonage | Certificat non fourni au runner (6.3, solution A) |
| Connexion LDAP qui échoue sans message | `COOKIE_SECURE=true` alors que QUAI est servi en HTTP, ou `LDAP_SEARCH_BASE` trop étroite |

Déploiement manuel de secours, directement sur l'hôte, sans passer par GitLab :

```bash
cp deploy/compose/.env.prod.example deploy/compose/.env.prod   # puis renseigner les vraies valeurs
docker compose -f deploy/compose/docker-compose.prod.yml --env-file deploy/compose/.env.prod up -d --build
```

## Portée de ce dossier

Ce dossier ne définit que l'infrastructure de build/déploiement. Il ne
contient ni le code de `@quai/api` (dont la route `GET /health` supposée
par les healthchecks Docker/K8s), ni celui de `@quai/web`, ni le crate
`packages/wasm-core` — ces briques sont développées indépendamment (voir
`ARCHITECTURE.md`).
