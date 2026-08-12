# Audit d'optimisation — QUAI

**Date** : 2026-08-12
**Périmètre** : `apps/api` (Fastify/TypeScript) + `apps/web` (React/Redux Toolkit/Vite) — appels Docker, I/O disque, tâches de fond, réseau externe, polling frontend, re-renders React, bundle, scalabilité du graphe de topologie.
**Méthode** : lecture intégrale des fichiers cités (pas d'inférence), vérification croisée par recherche exhaustive (`grep`/`Glob`), inspection du build de production déjà présent dans le dépôt (`apps/web/dist/`), et lecture des logs réels de `quai-dev-api-1` (lecture seule, aucun conteneur redémarré/modifié). Chaque finding cite un chemin de fichier et un numéro de ligne réels.

---

## Résumé exécutif

L'application est globalement **bien construite techniquement** : la majorité des agrégations coûteuses côté backend (`services/topology.ts`, `services/docker.ts#getDockerContainers`) utilisent déjà `Promise.all` et des `Map`/`Set` précalculées plutôt que des recherches linéaires répétées, tous les stores JSON invalident correctement leur cache mémoire, le chiffrement au repos est appliqué champ par champ (jamais de re-chiffrement de fichier entier), et le scheduler de scan (`scanScheduler.ts`) est un modèle de conception (garde anti-doublon, concurrence bornée, fréquence justifiée).

Cela dit, l'audit a mis au jour un nombre significatif de problèmes réels et mesurables, dont plusieurs confirmés **en conditions réelles** via les logs de production de dev :

1. **`services/images.ts#getImages()` n'a aucun cache** et refait un aller-retour registry complet (Docker Hub/GHCR/...) par image suivie à chacun de ses 8 points d'appel — confirmé par les logs : une requête `GET /api/topology` a mesuré **3831 ms** de temps de réponse à cause d'un re-fetch redondant survenu 4 secondes après un cycle watchdog qui venait de faire le même travail.
2. **`GET /api/topology` est pollée toutes les 9 secondes** (`OverviewPage.tsx`) alors que la route recalcule à chaque fois un résumé de vulnérabilités en O(conteneurs × historique de scans) sans Map précalculée, et déclenche le fan-out registry ci-dessus.
3. **Aucun timeout** sur les opérations Git (`fetch`/`pull`) du réconciliateur GitOps, qui tourne toutes les 90 secondes — à l'inverse de tous les autres modules réseau du projet (Nutanix, LXC, registries, GitHub, Kubernetes, Docker, qui ont tous un timeout explicite).
4. **Le fichier `notifications-log.jsonl` est relu et reparsé en entier à chaque poll de 20 s, par onglet/session** — alors que la route expose déjà un paramètre `since` que le frontend n'utilise jamais.
5. **Zéro code-splitting côté frontend** : un unique bundle JS (mesuré dans `apps/web/dist/` : ~1,02 Mo minifié, ~70 Ko gzip) embarque les 17 pages de l'application ainsi que `@xterm/xterm` (terminal interactif), chargé par tout utilisateur quel que soit l'écran visité.
6. **Les nœuds custom du graphe de topologie (`GraphNode`) ne sont pas mémoïsés** (`React.memo` absent) : avec 100+ conteneurs/volumes/networks, chaque clic de sélection ou chaque poll (9-15 s) re-render l'intégralité des nœuds du graphe au lieu des 1-2 réellement concernés.
7. **Trois schedulers de fond (watchdog 75s, scan 45min, réconciliateur GitOps 90s) n'ont aucune garde anti-chevauchement** ("déjà en cours") — un cycle plus long que son intervalle démarre un second cycle concurrent, avec risque de "lost update" sur les fichiers d'état JSON.

Aucun de ces points n'est bloquant en usage actuel (faible nombre de conteneurs/utilisateurs sur l'hôte de dev observé), mais plusieurs se dégraderont significativement avec la montée en charge (plus de conteneurs, plus d'utilisateurs connectés simultanément, historique de scans qui grossit).

---

## Findings — Impact Élevé

### É1. `getImages()` sans cache — fan-out registry complet à 8 points d'appel, confirmé en production

**Fichiers** : `apps/api/src/services/images.ts:82-123` ; sites d'appel : `apps/api/src/services/topology.ts:213`, `apps/api/src/services/watchdog.ts:133`, `apps/api/src/routes/images.ts:31,48,83`, `apps/api/src/routes/scan.ts:41,50`

`getImages()` (`images.ts:82-87`) fait `Promise.all(base.map(withRefreshedLatestTag))` — un appel réseau registry **par image locale suivie**, sans aucun cache ni limite de concurrence. Cette fonction est appelée à 8 endroits indépendants, dont deux tâches de fond périodiques (`watchdog.ts` toutes les 75s, et indirectement `topology.ts` à chaque `GET /api/topology`, pollée toutes les 9s par `OverviewPage.tsx`).

**Mesure réelle** (`docker logs quai-dev-api-1 -t`, lecture seule) : les 12 images locales de l'hôte de dev (`quai-dev-api`, `ferrite-server`, `pawchat-*`, etc., toutes buildées localement, jamais publiées) génèrent systématiquement 12 requêtes HTTP vers `hub.docker.com`, répétées à l'identique toutes les ~75 secondes (rythme du watchdog). À `15:14:00`, une requête `GET /api/topology` a redéclenché la même salve de 12 lookups **4 secondes seulement** après celle du cycle watchdog précédent — et cette requête a mesuré **`responseTime: 3831.37ms`**, directement imputable à ce re-fetch réseau non caché (le reste de `getTopology()` est déjà bien parallélisé, voir section « Déjà optimisé »).

`routes/scan.ts:41,50` aggrave le problème : `POST /api/images/:id/scan` et `GET /api/images/:id/scans` appellent `getImages()` en entier — donc refont le fan-out registry sur **toutes** les images suivies — juste pour résoudre le nom/tag d'**une seule** image par son id.

**Correctif recommandé** :
- Ajouter un cache TTL court (30-60s) partagé en mémoire process dans `images.ts` (`let cachedImages: { at: number; data: ImageRef[] } | null`), invalidé après ce délai — le watchdog et les 7 autres sites d'appel bénéficieraient du même résultat frais sans le recalculer 8 fois.
- Dans `routes/scan.ts`, résoudre l'image ciblée directement via `getLocalDockerImages()` + filtre par id (sans rafraîchir le tag distant de toutes les autres images) : le tag "dernière version disponible" n'est pas nécessaire pour démarrer un scan sur le tag courant.
- Borner la concurrence du fan-out avec le même utilitaire `runWithConcurrencyLimit` déjà écrit dans `scanScheduler.ts:137-151` (à extraire en helper partagé), pour éviter un fan-out non borné si le nombre d'images suivies grandit (12 aujourd'hui, aucune limite si demain 200).

### É2. `vulnSummaryForImage` recalculée en O(conteneurs × scans) à chaque `GET /api/topology`

**Fichier** : `apps/api/src/services/topology.ts:93-108,256`

`vulnSummaryForImage(image, allScans)` (lignes 93-108) parcourt l'intégralité de `allScans` (tout l'historique de scans jamais purgé, voir É6) à chaque invocation. Elle est appelée une fois par conteneur dans `containers.forEach` (ligne 256) — soit une complexité O(C × S) recalculée intégralement à **chaque** requête `GET /api/topology`, elle-même pollée toutes les 9 secondes (voir É3). L'historique de scans ne fait que croître dans le temps (aucune purge documentée), donc ce coût augmente avec l'âge du déploiement.

**Correctif recommandé** : construire une seule fois, avant la boucle `containers.forEach`, une `Map<string, {vulnCritical, vulnHigh}>` indexée par `image` (une seule passe O(S) sur `allScans`), puis simplement `.get(c.Image)` en O(1) par conteneur — exactement le pattern Map déjà utilisé (et bien fait) ailleurs dans le même fichier pour le rapprochement volumes/networks partagés (lignes 244-336).

### É3. `GET /api/topology` pollée toutes les 9 s côté frontend sans cache serveur partagé

**Fichiers** : `apps/web/src/features/overview/OverviewPage.tsx:9` (constante `REFRESH_INTERVAL_MS = 9_000`, passée à `TopologyGraph`) ; route : `apps/api/src/routes/topology.ts:29-31`

`getTopology()` déclenche à chaque appel : `listContainers`, `listVolumes`, `listNetworks`, `getImages("update")` (voir É1), `listGitOpsFiles`, `listAllScans`, plus N `stats()` et N `inspect()` par conteneur (readContainerUsage/readContainerHealth). Il n'existe **aucun cache côté serveur** partagé entre requêtes : si 3 admins ont l'app ouverte simultanément, ce sont 3 exécutions indépendantes et concurrentes de tout ce travail toutes les 9 secondes, sans mutualisation possible. `GET /api/topology/positions` (`routes/topology.ts:34-40`) en rajoute une couche : elle recalcule **tout le graphe une seconde fois** juste pour connaître les ids de nœuds vivants (purge des positions fantômes) — et `TopologyGraph.tsx` appelle `fetchTopology()` **et** `fetchTopologyPositions()` dans deux `useEffect` distincts au montage (lignes 468-481), déclenchant deux exécutions complètes de `getTopology()` quasi simultanément à chaque ouverture de la Vue d'ensemble.

**Correctif recommandé** : allonger l'intervalle de poll (au minimum aligner sur les 15s déjà définis comme défaut du composant, `TopologyGraph.tsx:57` — voir F6), et/ou introduire un cache serveur très court (2-3s) sur `getTopology()` pour mutualiser les requêtes concurrentes de plusieurs onglets/utilisateurs. Pour `/positions`, ne recalculer les ids "vivants" qu'à partir d'une liste légère (`listContainers`+`listVolumes`+`listNetworks`, sans l'enrichissement complet scans/gitops/images).

### É4. Aucun timeout sur les opérations Git du réconciliateur GitOps (cycle 90s)

**Fichiers** : `apps/api/src/services/gitops.ts:156,188,207-212` (appelées par `gitopsReconciler.ts:91` toutes les 90s)

Contrairement à **tous** les autres modules d'intégration réseau du projet (Nutanix `requestTimeoutMs=8000`, LXC idem, registries `5000`, GitHub `8000`/`cloneTimeoutMs`, Kubernetes `withTimeout(...,3000)`, Docker `withTimeout(...,2000)`), aucun appel `simpleGit()` (`fetch`, `checkout`, `pull`) dans `gitops.ts` n'est enveloppé par `withTimeout` ni configuré avec une option de timeout. `simple-git`/`git` n'a pas de timeout par défaut : si le dépôt Git distant ne répond jamais (pare-feu qui droppe les paquets, proxy muet), l'opération peut **pendre indéfiniment**. Combiné à l'absence de garde anti-chevauchement (vois É7 ci-dessous), chaque cycle suivant (toutes les 90s) relance un nouveau process `git` qui pend lui aussi → accumulation de process bloqués, fuite de descripteurs, écritures concurrentes sur `gitops-reconciler-state.json`.

`services/github.ts:339-343` montre déjà le correctif exact dans le même dépôt : `withTimeout(simpleGit().clone(...), config.github.cloneTimeoutMs, "git clone")`.

**Correctif recommandé** : envelopper `ensureRepoReady()` (`gitops.ts`) avec `withTimeout(..., config.gitops.requestTimeoutMs ?? 15000, "gitops fetch/pull")`, exactement comme `github.ts` le fait déjà pour son propre clone.

### É5. `notifications-log.jsonl` relu et reparsé en entier à chaque poll de 20s, par session

**Fichiers** : `apps/api/src/services/notificationsStore.ts:66-84` ; route `apps/api/src/routes/notifications.ts:15` ; frontend `apps/web/src/features/notifications/notificationsSlice.ts:32-35`, `apps/web/src/App.tsx:32,92-99`

`listNotificationEvents()` relit et reparse tout le fichier `notifications-log.jsonl` (plus `notifications-read-state.json`) à chaque appel — aucun cache mémoire en lecture. `GET /api/notifications` est pollée **toutes les 20 secondes par chaque onglet navigateur avec une session active** (`App.tsx:32,92-99`, tant que `document.visibilityState === "visible"`). La route accepte un paramètre `since` (`routes/notifications.ts:15`) mais le frontend ne l'envoie **jamais** (`notificationsSlice.ts:32-35` : `apiGet<SystemNotificationEvent[]>("/notifications")`, sans query string). Le fichier est alimenté en continu par le watchdog (75s) et le réconciliateur GitOps (90s), et n'est jamais purgé/tourné : avec 3 admins connectés, c'est déjà ≥3 lectures + parsing intégral toutes les 20s, qui ne fera que s'alourdir avec le temps.

**Correctif recommandé** : faire passer `since` (le dernier timestamp connu côté client) dans l'appel frontend (`notificationsSlice.ts`), et filtrer côté serveur avant de renvoyer — le mécanisme existe déjà, il suffit de le brancher. À plus long terme, ajouter un cache mémoire des N derniers événements côté `notificationsStore.ts` pour éviter la relecture disque à chaque poll.

### É6. `scans.jsonl` relu/reparsé en entier à chaque lecture, sans pagination ni purge

**Fichier** : `apps/api/src/services/scan.ts:60-77,421,427-428,434`

`readAllScans()` relit et reparse **tout** `scans.jsonl` à chaque `getScan()` (pollé par le frontend pendant qu'un scan tourne, `ImagesPage.tsx`/`TopologyNodeDetailPanel.tsx`, voir M9), `listScansForImage()` et `listAllScans()` (aussi appelée à chaque cycle de 45 min par `scanScheduler.ts` et à chaque `GET /api/topology`, voir É2/É3). Aucune pagination, aucun cap sur ce qui est **lu** depuis le disque (contrairement à `auditLog.ts`/`notificationsStore.ts` qui au moins cappent le résultat *renvoyé*). Le fichier grossit sans limite : chaque scan produit plusieurs lignes (running → success/failed), et chaque ligne "success" peut embarquer des centaines/milliers de `Vulnerability` (`maxBuffer: 64 Mo`, `scan.ts:386`).

**Correctif recommandé** : indexer `scans.jsonl` par un fichier d'index léger (id → offset de la dernière ligne du scan) pour permettre à `getScan(id)` de ne pas reparser tout le fichier ; ou, plus simplement, maintenir un cache mémoire process (invalidé à chaque `appendScanEvent`) des scans récents/actifs, qui couvre l'essentiel des lectures réelles (polling d'un scan en cours, dashboard récent).

### É7. Zéro code-splitting — bundle JS unique de ~1 Mo pour toute l'application

**Fichiers** : `apps/web/src/App.tsx:6-25,34-69` ; build mesuré : `apps/web/dist/assets/index-Csy8Tz5x.js`

Les 17 pages de l'application (`OverviewPage`, `ImagesPage`, `RegistriesPage`, `RegistryExplorerPage`, `SecretsPage`, `ContainersPage`, `VolumesPage`, `NetworksPage`, `ReverseProxyPage`, `AdDnsPage`, `GitOpsPage`, `EnvironmentsPage`, `NotificationsPage`, `AuditPage`, `IacPage`, plus `LoginScreen`/`SetupWizard`) sont **toutes importées statiquement** en haut de `App.tsx`, puis rendues par un simple `switch` (`renderView()`, lignes 34-69). Aucun `React.lazy()`/`import()` dynamique n'existe nulle part dans `apps/web/src` (vérifié par recherche exhaustive).

**Mesure réelle** : le build de production déjà présent dans le dépôt (`apps/web/dist/assets/index-Csy8Tz5x.js`) fait **1 049 089 octets** (~1,02 Mo) en un seul fichier JS, soit **71 338 octets compressés gzip** (~70 Ko) — aucun chunk séparé par page. Ce fichier unique embarque, entre autres, `@xyflow/react` (graphe React Flow, utilisé uniquement par la Vue d'ensemble) et `@xterm/xterm` (voir É8) alors que la majorité des utilisateurs ne visite qu'un sous-ensemble des 17 pages.

**Correctif recommandé** : convertir chaque `import XPage from "..."` en `React.lazy(() => import("..."))` dans `App.tsx`, entourer `renderView(currentView)` d'un `<Suspense fallback={<Skeleton/>}>` (le composant `Skeleton` existe déjà, `apps/web/src/components/Skeleton.tsx`). Prioriser les pages les moins visitées : `IacPage`, `GitOpsPage`, `EnvironmentsPage` (Kubernetes/Nutanix), `AdDnsPage`, `AuditPage`, `RegistryExplorerPage`, `GitHubDeployPage`.

### É8. `@xterm/xterm` (terminal interactif) chargé par tous les utilisateurs, utilisé seulement à la demande

**Fichiers** : `apps/web/src/components/ContainerConsole.tsx:2-4` (import statique de `@xterm/xterm`/`@xterm/addon-fit`) ; importé statiquement par `apps/web/src/features/containers/ContainersPage.tsx:22,558`

`ContainerConsole` (la console interactive `docker exec`, voir ARCHITECTURE.md § « Console interactive dans un conteneur ») importe `@xterm/xterm` de façon statique. Cette librairie complète (rendu canvas, parsing ANSI, addons) est chargée pour **tous** les utilisateurs dès le premier écran, alors qu'elle ne sert que lorsqu'un utilisateur ouvre explicitement une console sur un conteneur — action volontaire et rare, réservée aux rôles `operator`/`admin`.

**Correctif recommandé** : `const ContainerConsole = React.lazy(() => import("@/components/ContainerConsole"))` dans `ContainersPage.tsx`, avec `<Suspense>` autour du point de montage de la modal, pour ne charger `@xterm/xterm` qu'au premier clic sur « Console ».

### É9. `GraphNode`/`ProcessNode` non mémoïsés — tout le graphe re-render à chaque interaction/poll

**Fichiers** : `apps/web/src/components/topologyGraphShared.tsx:362` (`GraphNode`), `:530` (`nodeTypes`), `:555` (`interiorNodeTypes`) ; `apps/web/src/components/TopologyGraph.tsx:532-535`

Vérification faite directement dans les sources de `@xyflow/react` (`node_modules/@xyflow/react/dist/esm/index.mjs`) : chaque nœud est déjà enveloppé côté librairie par `memo(NodeWrapper)`, qui se re-render dès que la référence du nœud change dans le store interne. Mais **le composant custom `GraphNode` n'est PAS mémoïsé** (`topologyGraphShared.tsx:362`, pas de `React.memo`) — donc dès que `NodeWrapper` se re-render, `GraphNode` se re-render aussi, sans filtre supplémentaire.

Deux déclencheurs concrets :
- **Chaque clic de sélection** : `TopologyGraph.tsx:532-535` — `nodes = useMemo(() => flowNodes.map((n) => ({...n, selected: n.id === selectedId})), [flowNodes, selectedId])` recrée un nouvel objet top-level pour **tous** les nœuds à chaque changement de `selectedId`, alors que `n.data` lui-même n'est pas recréé. Un simple `React.memo(GraphNode)` (comparaison par défaut) suffirait déjà à éliminer le re-render pour tous les nœuds sauf les 2 réellement concernés (ancien + nouveau sélectionné).
- **Chaque poll (9-15s)** : `TopologyGraph.tsx:486-530`, la ligne `data: {...n, ...callbacks}` recrée un objet `data` neuf pour CHAQUE nœud à chaque `fetchTopology()` réussi, même si son contenu (statut, cpuPercent, memBytes…) est identique au poll précédent — ici un `React.memo` par défaut ne suffit pas, il faut une comparaison structurelle des champs affichés (`status`, `healthStatus`, `cpuPercent`, `memBytes`, `updateAvailable`, `drift`, `vulnCritical`, `vulnHigh`, `attachments`) pour réutiliser l'ancienne référence quand rien n'a changé.

**Impact quantifié** : avec 100+ conteneurs/volumes/networks, chaque clic sur un nœud déclenche aujourd'hui N re-renders de composants DOM complexes (icônes, badges, barres de progression CPU/mémoire) au lieu de 2 — l'écart se creuse linéairement avec la taille du graphe, perceptible comme du jank au clic et à chaque poll.

**Correctif recommandé** : envelopper `GraphNode` avec `React.memo` (export nommé, assigné dans `nodeTypes`/`interiorNodeTypes`) pour le cas « sélection » ; pour le cas « poll », comparer chaque nouveau `TopologyNode` à l'ancien (`prevById.get(n.id)` déjà disponible dans l'effet ligne 493) et réutiliser la référence `data` existante si les champs affichés n'ont pas changé.

---

## Findings — Impact Moyen

### M1. `resolveUpstream` séquentiel dans `pushConfigToCaddy()` — N conteneurs résolus un par un

**Fichier** : `apps/api/src/services/reverseProxy.ts:275-289` (boucle), `apps/api/src/services/docker.ts:507-521` (`getContainerNetworkAddress`, appelée par route)

Pour chaque route dont la cible est un conteneur, `pushConfigToCaddy()` (déclenché à chaque `createRoute`/`deleteRoute`) résout son IP réseau en appelant `getContainerNetworkAddress(id)` **en série** (`for (const route of routes) { const upstream = await resolveUpstream(route); ... }`, lignes 281-289) plutôt qu'en `Promise.all`. Chaque résolution fait elle-même **deux** appels Docker séquentiels : `isDockerReachable()` (un `docker.ping()`, `docker.ts:508-509`) puis `container.inspect()` (`docker.ts:514`) — soit jusqu'à **2×N appels Docker séquentiels** pour N routes ciblant des conteneurs, à chaque mutation de route. Ce choix de résolution "en direct, jamais mise en cache" est un compromis assumé et documenté (ne jamais figer une IP), mais la sérialisation elle-même n'a aucune justification : chaque route cible un conteneur indépendant.

**Correctif recommandé** : `const upstreams = await Promise.all(routes.map(resolveUpstream))`.

### M2. `listVolumes()` — O(volumes × conteneurs × montages) au lieu d'une Map précalculée

**Fichier** : `apps/api/src/services/docker.ts:677-685`

```
return (Volumes ?? []).map((v) => ({
  ...
  inUseBy: containers.filter((c) => c.Mounts?.some((m) => m.Name === v.Name)).length,
}));
```

Pour chaque volume `v`, un `.filter()` complet sur tous les conteneurs, et pour chacun un `.some()` sur tous ses montages — O(V·C·M). `services/topology.ts:244-336` construit la Map équivalente correctement en une seule passe (`volumeContainerIds`) : l'incohérence entre les deux fichiers du même projet est le signal le plus net de ce problème.

**Correctif recommandé** : construire une `Map<string, number>` (nom de volume → nombre de conteneurs) en une seule passe sur `containers`, puis `.map()` les volumes en O(1) chacun — même pattern que `topology.ts`.

### M3. `getDockerEnvironments()` — `docker.info()` appelé deux fois, client reconstruit inutilement

**Fichier** : `apps/api/src/services/docker.ts:1034-1037`

`getDockerHostInfo()` (appelée ligne 1037) refait `getClient()`, `isDockerReachable()` (un `ping()` de plus) puis `docker.info()`+`docker.version()`+`listVolumes()`, alors que `docker.info()` vient déjà d'être appelé à la ligne 1034.

**Correctif recommandé** : passer le client déjà résolu et/ou l'`info` déjà récupérée à une variante de `getDockerHostInfo` acceptant ces valeurs en paramètre.

### M4. `usages`/`healthStatuses` en deux `Promise.all` séquentiels au lieu d'un seul

**Fichier** : `apps/api/src/services/topology.ts:224-227`

Les deux opérations (`stats()` vs `inspect()`) sont indépendantes par conteneur mais attendues l'une après l'autre : le temps total = max(latence stats) + max(latence inspect), au lieu de max(les deux) si combinées.

**Correctif recommandé** :
```ts
const [usages, healthStatuses] = await Promise.all([
  Promise.all(containers.map((c) => readContainerUsage(docker, c.Id))),
  Promise.all(containers.map((c) => readContainerHealth(docker, c.Id))),
]);
```

### M5. `updateImage()` refait `getImages()` en entier deux fois pour mettre à jour une seule image

**Fichier** : `apps/api/src/services/images.ts:110-123`

`current = (await getImages()).find(...)` puis, après le pull, `refreshed = (await getImages()).find(...)` — chaque appel déclenche le fan-out registry complet sur **toutes** les images suivies (voir É1), pour ne finalement utiliser que l'entrée d'une seule image.

**Correctif recommandé** : récupérer l'image ciblée directement via `getLocalDockerImages()` + filtre par id/nom, sans rafraîchir le tag distant des autres images.

### M6. Watchdog — `checkReachability` teste Docker/Kubernetes/Nutanix/N registries en série

**Fichier** : `apps/api/src/services/watchdog.ts:147-169`

```
for (const check of checks) {
  const reachable = await check.reachable().catch(() => false);
  ...
}
```

`buildReachabilityChecks()` (lignes 100-126) peut inclure Docker + Kubernetes + Nutanix + un registry par entrée configurée avec identifiants. Chaque `testRegistryConnection` a un timeout de 5000ms (voir F1) : avec 5 registries injoignables, jusqu'à ~25s de latence purement séquentielle sont ajoutés à un cycle de 75s, sans aucune raison — chaque check écrit sa propre clé indépendante dans `next.reachability`. `images.ts#getImages` fait déjà ce fan-out correctement en `Promise.all` dans le même projet.

**Correctif recommandé** :
```ts
const results = await Promise.all(checks.map(async (check) => ({ check, reachable: await check.reachable().catch(() => false) })));
```

### M7. Aucune garde anti-chevauchement sur les 3 schedulers de fond

**Fichiers** : `apps/api/src/services/watchdog.ts:195-199`, `apps/api/src/services/gitopsReconciler.ts:129-133`, `apps/api/src/services/scanScheduler.ts:195-199`

Les trois `startXxx()` font `void runXxxCycle()` immédiatement puis `setInterval(() => void runXxxCycle(), intervalMs)`, sans aucun flag `isRunning`/mutex. Si un cycle dépasse son intervalle (watchdog 75s combiné à É1/M6 ; réconciliateur GitOps 90s combiné à É4 ; scanScheduler 45min avec `MAX_WAIT_MS=10min` par scan × jusqu'à 20 scans dus / 2 en concurrence = jusqu'à ~100 min possibles dans un scénario chargé), le cycle suivant démarre en parallèle : deux `loadState()`/`saveState()` concurrents sur le même fichier JSON d'état peuvent se marcher dessus (dernière écriture gagne, une transition détectée par le premier cycle écrasée silencieusement par le second qui a chargé un état obsolète). Pour `scanScheduler.ts`, l'impact réel est atténué par `isScanDue()` qui vérifie déjà qu'aucun scan n'est `"running"` avant d'en relancer un (garde fonctionnelle équivalente à un mutex pour ce cas précis) — mais `watchdog.ts`/`gitopsReconciler.ts` n'ont pas d'équivalent.

**Correctif recommandé** : ajouter un flag module-level `let cycleInFlight = false` dans les trois schedulers, vérifié en tête de `runXxxCycle()` (skip + log si déjà en cours).

### M8. Aucun verrou sur les mutations des stores JSON en liste

**Fichiers** : `apps/api/src/services/secretsStore.ts:102-108,171,237,247,326,348,373,406`, `apps/api/src/services/setupStore.ts:177-183,215,225,240,281,349,361`, `apps/api/src/services/reverseProxy.ts:96-102,188-189,209-210`, `apps/api/src/services/remoteDockerStore.ts:116-120,257-258,333-334,347-348`

Aucun mutex/queue ne sérialise le cycle `getAll()` → mutation → `writeToDisk()` → `cache = next`. Deux mutations concurrentes (deux requêtes HTTP quasi simultanées) qui lisent le même `cache` avant que la première n'ait écrit peuvent s'écraser mutuellement : la seconde écriture, basée sur un état qu'elle a lu avant la première écriture, écrase la première mutation ("lost update" silencieux). Risque plus élevé sur `setupStore.ts`, dont l'objet racine unique est touché par plusieurs fonctionnalités indépendantes (registries, LDAP, Kubernetes, Nutanix, AD DNS).

**Correctif recommandé** : introduire une file d'attente simple par store (ex. une Promise chaînée servant de mutex léger : `writeQueue = writeQueue.then(() => doWrite())`), pattern déjà commun en Node pour ce genre de store fichier.

### M9. Réécriture complète du fichier à chaque mutation d'un seul élément

**Fichiers** : `apps/api/src/services/secretsStore.ts:102-108` et équivalents `setupStore.ts`, `reverseProxy.ts`, `remoteDockerStore.ts`

Un `PATCH` sur 1 secret parmi 50 relit et réécrit les 50 (avec leur historique de version, jusqu'à 5 versions chiffrées par secret, `MAX_HISTORY_VERSIONS`) — jusqu'à 300 blobs chiffrés réécrits pour 1 changement. De même, `updateRegistryAt` sur 1 registry parmi N réécrit toute `config.json` (LDAP, Kubernetes, Nutanix, AD DNS, tous les registries compris).

**Correctif recommandé** : acceptable tant que N reste petit (dizaines d'éléments, pas une base de données) — pas une urgence, mais à surveiller si le nombre de secrets/registries/routes croît significativement. Une migration vers un stockage par-élément (un fichier par secret, ou SQLite) serait la solution à long terme si le volume grossit.

### M10. `listAuditEvents()` relit tout `audit-log.jsonl` à chaque `GET /api/audit`

**Fichier** : `apps/api/src/services/auditLog.ts:51-67`

Le cap `MAX_EVENTS_RETURNED = 500` (ligne 31) ne s'applique qu'au résultat **renvoyé** (`.reverse().slice(0, 500)`), pas à la quantité lue/parsée depuis le disque. Sur un historique de plusieurs années (chaque requête HTTP authentifiée en génère potentiellement une), ce fichier grossit indéfiniment. Impact moindre que É5 (pas de polling automatique détecté côté frontend pour l'audit), mais même défaut structurel.

**Correctif recommandé** : lire le fichier depuis la fin (streaming inverse) et s'arrêter dès 500 lignes collectées, plutôt que tout charger en mémoire puis trier/tronquer.

### M11. `kubernetes.ts` — filtre de pods par nœud en O(nœuds × pods)

**Fichier** : `apps/api/src/services/kubernetes.ts:153`

```
const podsOnNode = podItems.filter((p) => p.spec?.nodeName === nodeName);
```

Exécuté à l'intérieur du `.map()` sur `nodeItems` (ligne 147) — pour N nœuds et P pods, c'est O(N·P) au lieu d'une Map `nodeName -> pods[]` construite une seule fois en O(P) puis consultée en O(1) par nœud. Impact réel faible pour un cluster de dev (peu de nœuds), mais se dégraderait sur un cluster de taille réelle. Notez que `getKubernetesEnvironment()` parallélise déjà bien `listNode()`/`listPodForAllNamespaces()` via `Promise.all` (ligne 137) — seul ce filtre en aval est concerné.

**Correctif recommandé** : `const podsByNode = new Map<string, Pod[]>(); for (const p of podItems) { (podsByNode.get(p.spec?.nodeName) ?? podsByNode.set(...).get(...)).push(p); }` puis `.get(nodeName) ?? []` dans la boucle.

### M12. `findPort` — recherche O(n) répétée pendant le glisser d'une connexion

**Fichier** : `apps/web/src/components/TopologyGraph.tsx:567` (et `547`, `597`, `743` en moindre mesure)

`data?.nodes.find((n) => n.id === nodeId)` dans `findPort`, appelée via `classifyConnection`/`isValidConnection` — branchée sur `<ReactFlow isValidConnection={...}>` (ligne 904), qui côté `@xyflow/react` est invoquée en continu pendant qu'un utilisateur glisse une connexion depuis un port (survol de chaque cible potentielle). Avec 100+ nœuds, chaque évaluation est un scan O(n) répété à haute fréquence pendant le geste — la Map `nodesById` existe déjà dans le même composant (ligne 539) mais n'est pas utilisée ici.

**Correctif recommandé** : remplacer les 4 occurrences par `nodesById.get(id)` — la Map est déjà en scope, zéro changement de comportement, passage de O(n) à O(1).

### M13. 4 implémentations dupliquées de « poll pendant qu'un job tourne » sans garde onglet-en-arrière-plan

**Fichiers** : `apps/web/src/components/TopologyNodeDetailPanel.tsx:215-218`, `apps/web/src/features/github/GitHubDeployPage.tsx:99-102`, `apps/web/src/features/iac/IacPage.tsx:64-67`, `apps/web/src/features/images/ImagesPage.tsx:167-170`

Ces 4 sites pollent toutes les 2 secondes (scan d'image, run IaC, déploiement GitHub, panneau de détail topologie) tant qu'un job est `"running"`, **sans** la garde `document.visibilityState === "visible"` déjà présente et correcte ailleurs dans le même projet (`TopologyGraph.tsx:471`, `GitOpsPage.tsx:57`). Si l'utilisateur change d'onglet pendant qu'un job tourne, le polling à 2s continue en tâche de fond jusqu'à `MAX_WAIT_MS` (10 min côté scan automatique) — jusqu'à ~300 requêtes inutiles par job avec onglet en arrière-plan, répété à l'identique sur 4 fonctionnalités indépendantes.

**Correctif recommandé** : extraire un hook partagé `usePolling(callback, intervalMs, { enabled, respectVisibility })` dans `apps/web/src/hooks/`, utilisé par les 7 sites de polling du projet au lieu de 7 copies de la même logique `setInterval`/`clearInterval` — élimine à la fois le manque de garde et la duplication de code.

### M14. `ReverseProxyPage.tsx` — Map et filtre reconstruits à chaque render, y compris à chaque frappe clavier

**Fichier** : `apps/web/src/features/reverseProxy/ReverseProxyPage.tsx:55-56`

```
const runningContainers = containers.filter((c) => c.state === "running");
const containerNameById = new Map(containers.map((c) => [c.id, c.name]));
```

Ces deux calculs sont dans le corps du composant, non mémoïsés — recalculés à chaque render, y compris ceux déclenchés par la frappe dans les champs du formulaire de création de route (`form.subdomain`, `form.targetHost`, etc., state local du même composant). Impact réel faible avec un nombre de conteneurs modeste, mais facilement corrigible.

**Correctif recommandé** : `useMemo(() => containers.filter(...), [containers])` et `useMemo(() => new Map(...), [containers])`.

---

## Findings — Impact Faible

### F1. `testRegistryConnection` — timeout codé en dur, ignore la config

**Fichier** : `apps/api/src/services/registries/index.ts:119`

`setTimeout(() => controller.abort(), 5000)` en dur, alors que `registries/http.ts` utilise déjà `config.registries.requestTimeoutMs` (défaut 5000 également, mais non ajustable ici). Cette fonction est utilisée par le watchdog (voir M6) : un opérateur qui augmente `requestTimeoutMs` via variable d'environnement verrait son changement ignoré pour cette vérification précise.

**Correctif** : remplacer `5000` par `config.registries.requestTimeoutMs`.

### F2. `withTimeout` n'annule pas la promesse sous-jacente

**Fichier** : `apps/api/src/utils/async.ts:3-10`

`Promise.race` ne stoppe pas l'appel Docker/Kubernetes sous-jacent une fois le "timeout" côté appelant écoulé — l'appel continue de tourner en arrière-plan (travail gaspillé, pas de fuite bloquante).

**Correctif** : propager un `AbortController` jusqu'au client sous-jacent quand l'API le permet (dockerode le supporte partiellement, `@kubernetes/client-node` aussi).

### F3. `gitOpsBaseName` recalculée par paire (conteneur × fichier) au lieu d'une fois par fichier

**Fichier** : `apps/api/src/services/topology.ts:134-139,266`

`containerMatchesGitOpsFile` recalcule `gitOpsBaseName(filePath)` à chaque combinaison conteneur×fichier — recalculée C fois par fichier au lieu d'une fois. Le matching flou (`includes` dans les deux sens) empêche une Map exacte, mais le calcul du "base name" par fichier peut être précalculé une fois en O(D) avant la boucle des conteneurs.

**Correctif** : précalculer `driftFilePaths.map(gitOpsBaseName)` une fois avant `containers.forEach`.

### F4. `inspectDockerContainer` — 3 appels indépendants en série

**Fichier** : `apps/api/src/services/docker.ts:568-573`

`container.inspect()`, `readContainerUsage()`, `docker.info()` enchaînés séquentiellement alors qu'indépendants — un seul conteneur à la fois, impact latence uniquement.

**Correctif** : `Promise.all([container.inspect(), readContainerUsage(docker, id), docker.info()])`.

### F5. `githubStore.ts#setToken` écrase tout l'objet plutôt qu'un patch partiel

**Fichier** : `apps/api/src/services/githubStore.ts:76-78`

Sans conséquence aujourd'hui (un seul champ `token`), mais fragiliserait une future extension (ex. ajout d'un `webhookSecret`) si elle n'y prend pas garde.

### F6. `TopologyGraph.tsx` — valeur par défaut morte (`REFRESH_INTERVAL_MS = 15_000`)

**Fichier** : `apps/web/src/components/TopologyGraph.tsx:57` vs `apps/web/src/features/overview/OverviewPage.tsx:9`

Le seul appelant du composant (`OverviewPage`) surcharge systématiquement cette constante à `9_000` — la valeur par défaut du composant n'est jamais utilisée, ce qui peut induire en erreur un futur lecteur/appelant.

**Correctif** : soit supprimer la valeur par défaut et rendre `refreshIntervalMs` obligatoire, soit aligner les deux valeurs si 9s est vraiment l'intention partout.

### F7. `.find()` non mémoïsés dans les panneaux de détail du graphe

**Fichiers** : `apps/web/src/components/TopologyNodeDetailPanel.tsx:198,249,250`, `apps/web/src/components/TopologySubGraphPanel.tsx:186`

Trois `.find()` (`images.find`, `volumes.find`, `networks.find`) s'exécutent à chaque render du panneau sans `useMemo`, alors que `networkAttachments` juste à côté (`TopologyNodeDetailPanel.tsx:225-243`) est correctement mémoïsé — incohérence de pattern. Impact faible (listes généralement petites).

### F8. Handlers non `useCallback` dans `TopologyGraph.tsx`

**Fichier** : `apps/web/src/components/TopologyGraph.tsx:545-841` (`selectNode`, `handleNodesChange`, `handleNodeDragStop`, `handleConnect`, `isValidConnection`, `handleNodeClick`, etc.), branchés directement sur `<ReactFlow>` lignes 890-914

Recréés à chaque render, ce qui provoque un re-render du composant racine `<ReactFlow>` et de ses éléments de premier niveau à chaque ouverture/fermeture de menu contextuel — n'affecte pas directement le re-render des nœuds individuels (qui lisent leur état via le store interne de React Flow), donc impact réel limité, mais évitable.

**Correctif** : `useCallback` avec dépendances correctes, en priorité sur `handleNodeClick`/`handleConnect`/`isValidConnection` (chemin d'interaction le plus chaud).

### F9. `vite.config.ts` — aucun `manualChunks`

**Fichier** : `apps/web/vite.config.ts`

Aucune configuration `build.rollupOptions.output.manualChunks`. Secondaire tant que É7 (lazy loading par page) n'est pas fait — une fois le split par page en place avec `React.lazy`, un `manualChunks` séparant `@xyflow/react` et `@xterm/xterm` dans leurs propres chunks vendor serait un complément utile.

### F10. Absence de `reselect`/`createSelector` dans tout le projet

Vérifié par recherche exhaustive (`grep -rn "createSelector" apps/web/src` → 0 résultat, dépendance absente de `package.json`). Ce n'est **pas un bug aujourd'hui** : aucun sélecteur dérivé coûteux (`state => ({...})` ou `state => state.x.map(...)`) n'a été trouvé retournant un nouvel objet/tableau à chaque appel — la quasi-totalité des `useAppSelector` du projet renvoient soit une valeur primitive, soit une référence directe de sous-état de slice. Signalé à titre préventif : si une future feature introduit un sélecteur dérivant une liste/objet (agrégations croisées containers/environnements par exemple), `createSelector` évitera de reproduire ce problème.

---

## Déjà optimisé, vérifié

Les points suivants ont été activement recherchés et confirmés **absents** (pas de bug) ou confirmés **bien implémentés** — listés pour ne pas laisser croire qu'ils ont été ignorés.

### Backend — appels Docker et topologie
- **`docker.ts:436-450` `getDockerContainers()`** — `Promise.all` sur les N `stats()` par conteneur : N+2 appels en parallèle au lieu de N en série.
- **`docker.ts:341-357` `readContainerUsage`** — un seul appel `stats({stream:false})` par invocation, pas de répétition inutile.
- **`docker.ts:988` `getDockerHostInfo()`** — `info()`/`version()`/`listVolumes()` bien parallélisés via `Promise.all`.
- **`docker.ts:912-935` `listNetworks()`** — le compte de conteneurs par network vient directement de `n.Containers` (déjà fourni par l'API Docker), pas de recalcul O(n²).
- **`topology.ts:209-216` `getTopology()`** — le premier lot de 6 opérations indépendantes (`listContainers`, `listVolumes`, `listNetworks`, `getImages`, `listGitOpsFiles`, `listAllScans`) est correctement groupé en un seul `Promise.all`, chacune avec `.catch(() => [])` pour ne jamais faire échouer tout le graphe à cause d'une source annexe.
- **`topology.ts:244-336` Maps/Sets précalculés** — `containerMounts`, `containerNets`, `volumeContainerIds`, `networkContainerIds`, `networkNameById`, `volumeByName`, `networkById` sont TOUS construits en une seule passe (`containers.forEach`) puis consultés en O(1) — exemplaire, à l'opposé du problème trouvé en M2 dans `docker.ts`.
- **`images.ts:85` `getImages()`** — le fan-out registry lui-même EST déjà parallélisé via `Promise.all` (le problème identifié en É1 est l'absence de cache, pas l'absence de parallélisme).
- **`routes/containers.ts:88-91`** — `getDockerContainers`/`getKubernetesContainers` bien parallélisés via `Promise.all` au niveau route.
- **`kubernetes.ts:137-140` `getKubernetesEnvironment()`** — `listNode()`/`listPodForAllNamespaces()` bien parallélisés (seul le filtre en aval, M11, reste O(n·m)).

### Backend — I/O disque
- **Cache mémoire invalidé correctement à chaque écriture**, sans jamais de relecture disque redondante après une écriture qu'on vient de faire — vérifié dans `secretsStore.ts`, `setupStore.ts`, `reverseProxy.ts`, `remoteDockerStore.ts`, `githubStore.ts`, `lxcStore.ts`.
- **`remoteDockerStore.ts:338,350`** — invalidation de cache à deux niveaux : après update/delete, invalide aussi le pool de connexions SSH (`invalidateSshConnection`), pas seulement le cache JSON — gestion soignée.
- **`lxcStore.ts:43`** — sentinel `undefined`/`null` distinct pour "pas encore chargé" vs "chargé et absent", plus propre que le simple `null` utilisé ailleurs.
- **Chiffrement AES-256-GCM champ par champ**, jamais de re-chiffrement de fichier entier — vérifié dans `secretsStore.ts:224`, `setupStore.ts:129-154,274-276`, `remoteDockerStore.ts:143-169,316-319`, `githubStore.ts:76-78`, `lxcStore.ts:101-102` : un `PATCH` qui ne fournit pas un champ sensible conserve le blob chiffré existant sans le retoucher.
- **Écriture append-only pure** (jamais de réécriture du fichier entier pour ajouter une ligne) — vérifié dans `scan.ts:48-57`, `auditLog.ts:43`, `notificationsStore.ts:43-53`.
- **100% des stores utilisent `node:fs/promises`** (async) — `grep writeFileSync/readFileSync` sur tout `apps/api/src` → 0 résultat, aucune écriture synchrone ne bloque l'event loop.
- **Déploiement mono-process** (`docker-compose.dev.yml`, pas de cluster/replicas) — le cache mémoire module-level ne présente donc pas de risque de divergence inter-process dans l'architecture actuelle.

### Backend — tâches de fond
- **`scanScheduler.ts`** — modèle exemplaire : fréquence (45 min) justifiée et documentée, garde anti-doublon fonctionnelle via `isScanDue()` (vérifie qu'aucun scan `"running"` n'existe déjà), concurrence bornée à `MAX_CONCURRENT_SCANS = 2` plutôt que tout séquentiel ou tout parallèle.
- **`watchdog.ts:77-91` / `gitopsReconciler.ts:72-82`** — logique edge-triggered pure et testable (`detectNewlyUpdatedImages`, `detectReachabilityTransition`, `detectDriftTransitions`), bien séparée des effets de bord ; baseline sans bruit au premier cycle vérifiée.
- **`sshTunnel.ts:61-75`** — sweep périodique (60s) léger, 100% en mémoire (pas d'I/O), `sweepTimer.unref()` explicite pour ne jamais bloquer l'arrêt du process.

### Backend — réseau externe
- **`nutanix.ts:61-62,82,226-241`** — timeout HTTPS explicite (`requestTimeoutMs`, défaut 8000ms) avec gestion `req.on("timeout")` qui détruit proprement la requête ; appels clusters+VMs déjà en `Promise.all`.
- **`lxc.ts`** — même pattern de timeout explicite que Nutanix.
- **`registries/http.ts:24-42`** — `fetchJson` avec `AbortController` + timeout configurable partagé par tous les clients registry (Docker Hub, GHCR, GitLab).
- **`github.ts:41-68,339-343`** — timeout sur `fetch` (8000ms) ET sur `simpleGit().clone()` via `withTimeout` — la référence exacte du correctif recommandé pour É4 existe déjà dans ce même fichier du projet.
- **`docker.ts:143-150`** — `isDockerReachable` avec `withTimeout(docker.ping(), 2000ms, ...)`.

### Frontend — polling
- **Fréquences cohérentes et documentées** : 2s (jobs actifs, bornés dans le temps, feedback quasi temps réel légitime) / 9s (vue d'ensemble) / 20s (notifications) / 90s (dérive GitOps) — chaque valeur est justifiée en commentaire dans le code et alignée sur le cycle serveur correspondant ; aucune fréquence `<3s` appliquée à une donnée lente.
- **Aucun double-polling actif trouvé** : `ContainersPage.tsx` fait un fetch unique au montage (pas de `setInterval`) ; `NotificationsPage.tsx` ne fait aucun fetch propre, lit uniquement le state Redux alimenté par `App.tsx` ; les deux pollers `fetchScanDetail` (topologie et Images) ne peuvent jamais tourner en parallèle car leurs vues ne sont jamais montées simultanément.
- **`App.tsx:92-99`, `TopologyGraph.tsx:468-474`, `GitOpsPage.tsx:50-60`** — garde `document.visibilityState === "visible"` et `clearInterval` au unmount correctement implémentés (les 3 seuls sites de polling "continu", par opposition aux 4 sites "job en cours" signalés en M13).

### Frontend — re-renders et graphe
- **`TopologyGraph.tsx:539` `nodesById`, `:493` `prevById`** — Maps construites une fois par changement de données, consultées en O(1) — sauf aux 4 sites signalés en M12/F du même fichier qui ne les réutilisent pas encore partout.
- **`TopologyGraph.tsx:543` `edges`** — mémoïsé via `useMemo` avec les bonnes dépendances.
- **`topologyGraphShared.tsx` `edgeContainerNode`/`buildTopologyEdges`** — recherche en O(1) via Map, pas de boucle imbriquée.
- **`TopologySubGraphPanel.tsx`** — extensivement et correctement mémoïsé : `nodesById`, `neighborIds`, `subEdges`, `flowEdges`, `interiorNodes`, `interiorEdges` sont TOUS des `useMemo` avec dépendances correctes (seul `imageRef`, ligne 186, y échappe — F7).
- **`TopologyNodeDetailPanel.tsx:225-243` `networkAttachments`** — mémoïsé.
- **`@xyflow/react` (librairie)** — vérifié dans ses sources (`node_modules`) : mémoïse déjà `NodeWrapper` en interne et souscrit chaque nœud individuellement au store Zustand — la base est saine, il ne manque que la memoization du composant custom côté QUAI (voir É9) pour en tirer pleinement parti.
- **Sélecteurs Redux** — recherche exhaustive sur ~90 usages de `useAppSelector` : aucun pattern fautif (`state => ({...})`/`state => state.x.map(...)`) trouvé hors du cas mineur `Topbar.tsx:31` (retour primitif, donc sans impact de re-render malgré le recalcul).

---

## Tableau récapitulatif par impact

| Impact | Nombre de findings | Domaines concernés |
|---|---|---|
| Élevé | 9 | Cache registry absent (backend), coût + fréquence de `/api/topology`, timeout Git manquant, relecture JSONL non bornée (notifications + scans), absence totale de code-splitting, xterm.js non lazy, nœuds de graphe non mémoïsés |
| Moyen | 14 | N+1/sérialisation Docker ponctuels, verrouillage des stores JSON, gardes anti-chevauchement des schedulers, polling sans garde de visibilité, recherches O(n) évitables côté frontend |
| Faible | 10 | Incohérences mineures de configuration, calculs non mémoïsés à faible volume, valeurs mortes, absence préventive de `reselect` |

---

*Rapport produit par audit statique du code source réel (aucun fichier applicatif modifié) et lecture de logs de production de dev en lecture seule. Toutes les lignes citées correspondent à l'état du dépôt au 2026-08-12.*
