# Analyse concurrentielle QUAI — 12/08/2026

Comparaison de QUAI (console Docker/Swarm/Kubernetes/Nutanix/LXC pour la Mairie du Creusot) face à Railway (référence UX du projet), Portainer (concurrent direct visé), et aux PaaS self-hosted Coolify, CapRover, Dokploy, ainsi qu'à Rancher pour le volet Kubernetes multi-cluster.

Méthode : lecture complète de `ARCHITECTURE.md` + des routes API (`apps/api/src/routes/`) et des pages `apps/web/src/features/` pour établir l'inventaire réel de QUAI (section 1), puis recherche documentaire réelle (doc officielle, blog produit) sur chaque concurrent (section 2), confrontée systématiquement à l'inventaire pour ne jamais recommander une fonctionnalité déjà livrée.

---

## Résumé exécutif

QUAI est déjà un produit dense : topologie graphique interactive type Railway, gestionnaire de secrets façon Vault, scan de vulnérabilités réel (Grype + OSV-Scanner) en tâche de fond, reverse proxy Caddy piloté par API, cinq types d'environnements (Swarm/K8s/Nutanix/Docker distant/LXC), watchdog proactif, réconciliateur GitOps, intégration GitHub avec détection de manifestes, DNS Active Directory automatique (RFC2136/GSS-TSIG), ateliers infra-as-code (OpenTofu/Ansible/Packer) et audit log complet. C'est nettement plus large que ce que Portainer Community Edition ou les PaaS self-hosted comparables proposent nativement sur plusieurs de ces axes.

Le trou le plus net et le plus surprenant : **QUAI n'a aucun visualiseur de logs de conteneur**. La console interactive (`docker exec` via WebSocket + xterm.js) existe, mais pas l'équivalent de `docker logs -f`. C'est une fonctionnalité de base présente chez les six concurrents étudiés — à traiter en priorité, avec un effort faible puisqu'elle réutilise exactement le pattern WebSocket déjà en place pour la console.

Les autres manques réels et pertinents pour une infra on-prem de mairie, par ordre de priorité : limites CPU/mémoire configurables par conteneur depuis l'UI (absentes du formulaire de création de QUAI, présentes chez Coolify — un conteneur mal dimensionné peut aujourd'hui affamer les autres services d'un hôte mutualisé sans aucun garde-fou), sauvegardes automatiques de bases de données/volumes (absentes de QUAI, présentes chez Coolify et Dokploy), notifications sortantes vers des canaux externes (Slack/Discord/Telegram/email — QUAI notifie uniquement en interne), métriques temps réel et historiques avec graphiques dans le temps (QUAI n'a que des instantanés CPU/mémoire, pas d'historique — Coolify pousse ceci via un petit agent dédié, "Sentinel"), un type de service "Cron Job" natif (utile pour les sauvegardes/rapports périodiques), le déploiement automatique sur push Git, et un scoping géographique/organisationnel des accès (Environment Groups façon Portainer) pertinent pour une mairie multi-sites (écoles, annexes, services techniques).

À l'inverse, plusieurs fonctionnalités vedettes de Railway et Rancher n'ont explicitement aucun sens pour ce cas d'usage on-prem à échelle mairie : facturation à l'usage, autoscaling élastique multi-région, marketplace de templates payant, gestion de flottes de dizaines de clusters Kubernetes. Elles sont détaillées et écartées en section 4.

---

## 1. Inventaire réel de QUAI (vérifié dans le code, pas de suppositions)

| Domaine | État chez QUAI | Référence code |
|---|---|---|
| Topologie graphique interactive | React Flow : nœuds conteneurs/volumes/networks/VMs Nutanix, arêtes typées par capacité, couleur d'arête selon santé Docker native, zoom sémantique, canevas persistant par utilisateur, minimap, sous-graphe plein écran (dépendances + composition interne via `docker top`/`docker history`), modal de détail par type de nœud | `apps/web/src/components/TopologyGraph.tsx`, `apps/api/src/services/topology.ts` |
| Registries multi-sources | Docker Hub, GHCR, GitLab, Harbor ; comparaison tag courant/dernier tag ; explorateur de catalogue distant avec diagnostic d'erreur concret | `apps/api/src/routes/registries.ts` |
| Mises à jour d'image | Détection + action explicite uniquement (jamais automatique) | `apps/api/src/routes/images.ts` |
| GitOps | Dépôt Git = source de vérité ; diff désiré/réel (WASM Rust) ; sync déclenché par clic ; réconciliateur en tâche de fond (edge-triggered) | `apps/api/src/routes/gitops.ts`, `services/gitopsReconciler.ts` |
| Multi-orchestrateur | Swarm + Kubernetes + Nutanix (Prism Central API v3) + Docker distant (TCP+TLS) + LXC (via LXD, mTLS) | `services/nutanix.ts`, `services/lxc.ts`, `services/remoteDockerStore.ts` |
| Auth & RBAC | LDAP (bind + mapping groupes→rôles), JWT session, 3 rôles globaux (viewer/operator/admin) | `plugins/auth.ts` |
| Secrets nommés | Façon Vault/GitHub Actions secrets, write-only, AES-256-GCM au repos, résolution serveur uniquement à la création de conteneur | `services/secretsStore.ts` |
| Reverse proxy interne | Caddy réel piloté par son admin API JSON (pas de Caddyfile généré), résolution d'IP cible à chaque push | `services/reverseProxy.ts` |
| Explorateur de volume | Lecture seule, conteneur helper éphémère, sécurisé contre l'injection shell/évasion de chemin | `services/docker.ts#listVolumeFiles` |
| Console interactive | `docker exec` réel via WebSocket + xterm.js | `routes/console.ts` |
| **Logs de conteneur** | **Absent — aucune route, aucun composant** | — |
| Scan de vulnérabilités | Grype + OSV-Scanner réels en sous-processus, scan auto des images déployées (stale >24h), historique manuel/auto | `services/scan.ts`, `services/scanScheduler.ts` |
| Détection proactive | Watchdog edge-triggered (nouvelles versions d'image, joignabilité des intégrations) | `services/watchdog.ts` |
| Notifications | Uniquement in-app (toast + historique `GET /api/notifications`) — aucun canal externe | `services/notificationsStore.ts` |
| Intégration Git | GitHub : liste repos, détection Dockerfile/compose/Terraform, déploiement manuel depuis l'UI, historique + logs | `routes/github.ts` |
| Déploiement auto sur push | Absent — le déploiement GitHub est toujours déclenché manuellement depuis l'UI | `routes/github.ts` |
| Templates / catalogue d'apps | Absent — création de conteneur via formulaire brut ou GitOps, pas de catalogue pré-configuré | `routes/containers.ts` |
| Sauvegardes automatiques | Absentes — aucun mécanisme de backup DB/volume programmé | — |
| Métriques historiques | Absentes — `cpuPercent`/`memBytes` sont des instantanés à chaque requête, aucune série temporelle stockée | `services/docker.ts` |
| Infra-as-code | OpenTofu, Ansible, Packer : vrais binaires en sous-processus, ateliers de fichiers, historique de runs avec logs | `routes/iac.ts` |
| DNS Active Directory | RFC2136 + GSS-TSIG (kinit), enregistrement dynamique dans l'annuaire mairie | `routes/adDns.ts`, `services/adDns.ts` |
| Audit log | Complet, "qui a fait quoi", réservé admin | `routes/audit.ts` |
| Orphelins volumes/networks | Détection + nettoyage groupé avec confirmation | `services/topology.ts` |

---

## 2. Tableau comparatif fonctionnel

Légende : ✅ natif et vérifié dans la doc officielle · ➖ partiel/différent · ❌ absent · — non pertinent pour ce produit.

| Fonctionnalité | QUAI | Railway | Portainer | Coolify | CapRover | Dokploy | Rancher |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Topologie graphique interactive | ✅ | ➖ (pas de canvas public documenté) | ❌ | ❌ | ❌ | ❌ | ➖ (vue cluster, pas de graphe de service) |
| Logs de conteneur en direct | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Console/terminal web | ✅ | ➖ | ✅ | ➖ | ❌ | ✅ | ✅ |
| Scan de vulnérabilités automatique | ✅ (Grype+OSV) | ❌ | ➖ (Business Edition) | ❌ | ❌ | ❌ | ➖ (add-ons) |
| Secrets nommés façon Vault | ✅ | ✅ (variables + reference vars) | ➖ | ✅ | ➖ | ✅ | ✅ (K8s Secrets) |
| Reverse proxy interne intégré | ✅ (Caddy réel) | — (géré côté plateforme) | ➖ | ✅ (Traefik) | ✅ (Nginx) | ✅ (Traefik) | ➖ (Ingress) |
| GitOps avec diff désiré/réel | ✅ | ❌ | ✅ (Business) | ➖ | ❌ | ❌ | ✅ (Fleet, échelle différente) |
| Multi-orchestrateur (Docker+K8s+Nutanix+LXC) | ✅ | — | ➖ (Docker+K8s) | ❌ (Docker seul) | ❌ (Docker/Swarm seul) | ❌ (Docker seul) | ➖ (K8s uniquement) |
| Watchdog / notifications proactives | ✅ (in-app) | ✅ (webhooks/alerting) | ✅ | ✅ (Slack/Discord/Telegram/email) | ➖ | ➖ | ✅ |
| **Notifications sortantes (Slack/Discord/email)** | ❌ | ✅ | ✅ | ✅ | ➖ (webhooks bruts) | ➖ | ✅ |
| **Sauvegardes automatiques DB/volumes** | ❌ | ➖ | ➖ (Business) | ✅ (S3) | ❌ | ✅ (S3) | ➖ (via Velero, hors UI) |
| **Métriques historiques (graphiques dans le temps)** | ❌ | ✅ (30j, repères de déploiement) | ➖ | ➖ | ❌ | ➖ (self-hosted = add-on séparé) | ✅ |
| **Cron Jobs (type de service natif)** | ❌ | ✅ | ❌ | ➖ | ❌ | ➖ | ➖ (CronJob K8s natif) |
| **Déploiement auto sur push (webhook)** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ➖ (Fleet) |
| **Templates / catalogue one-click** | ❌ | ✅ (marketplace payant) | ✅ (App Templates) | ✅ (280+) | ✅ | ✅ (500+, communautaire) | ✅ (Helm charts) |
| **RBAC scopé par site/environnement** | ❌ (3 rôles globaux) | — | ✅ (Environment Groups) | ❌ | ❌ | ❌ | ✅ (Projects/Namespaces) |
| **Contrôle d'accès par ressource individuelle** | ❌ | — | ✅ (Private/Restricted/Public) | ❌ | ❌ | ❌ | ➖ (RBAC K8s natif) |
| **Edge Agent (sites déconnectés, polling sortant)** | ❌ | — | ✅ | ❌ | ❌ | ❌ | ❌ |
| Rollback en un clic | ➖ (GitOps sync manuel, pas de "1 clic retour image précédente") | ✅ | ➖ | ➖ | ❌ | ➖ | ✅ (Helm rollback) |
| **Limites CPU/mémoire par conteneur (UI)** | ❌ | ✅ | ✅ | ✅ | ➖ | ✅ | ✅ (K8s resources) |
| **Métriques temps réel par agent dédié** | ❌ (instantané à la requête) | ✅ | ➖ | ✅ (agent "Sentinel") | ❌ | ➖ (Cloud only) | ✅ |
| Infra-as-code (OpenTofu/Ansible/Packer) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ➖ (Fleet/Terraform provider séparé) |
| DNS interne automatique | ✅ (AD réel) | ✅ (DNS interne WireGuard) | ❌ | ❌ | ❌ | ➖ (Traefik + wildcard) | ➖ |
| Audit log complet | ✅ | ➖ | ✅ | ❌ | ❌ | ➖ | ✅ |

---

## 3. Recommandations priorisées (Effort × Valeur)

### Priorité 1 — Faible/Moyen effort, valeur élevée

**1. Limites CPU/mémoire configurables par conteneur depuis l'UI**
Coolify permet de définir, depuis l'onglet Advanced de chaque ressource, une limite mémoire (le conteneur est tué par Docker au dépassement) et une limite CPU (ex. `0.5` = demi-cœur), sans éditer de compose file ([coolify.io/docs/applications](https://coolify.io/docs/applications/)). Le contrat `POST /api/containers` de QUAI (voir `ARCHITECTURE.md`) n'expose aujourd'hui aucun champ de limite de ressources — un conteneur mal dimensionné peut saturer un hôte mutualisé sans aucun garde-fou.
- **Effort : Faible.** L'API Docker expose déjà `HostConfig.NanoCpus`/`HostConfig.Memory` à la création d'un conteneur (dockerode) — un champ de formulaire supplémentaire côté `apps/web` + deux propriétés côté `POST /api/containers`, aucun nouveau protocole.
- **Valeur : Élevée.** Sur un serveur on-prem mutualisé (typiquement le cas d'une mairie qui n'a pas un serveur dédié par application), éviter qu'un conteneur affame les autres services est un besoin opérationnel immédiat et concret.

**2. Logs de conteneur en direct avec recherche**
QUAI n'a aucun visualiseur de logs — seule la console interactive (`docker exec`) existe. Railway met en avant des "Live logs with full-text search" ([docs.railway.com — Features](https://railway.com/features)) ; Portainer, CapRover, Dokploy et Coolify ont tous un onglet logs natif. C'est la fonctionnalité de base la plus manquante du produit.
- **Effort : Faible.** Réutilise exactement le pattern déjà en place dans `routes/console.ts` (WebSocket + `@fastify/websocket`) : `container.logs({ follow: true, stdout: true, stderr: true, timestamps: true })` de dockerode au lieu de `container.exec(...)`. Un rôle `viewer` peut légitimement y avoir accès en lecture (contrairement à la console, qui exige operator/admin), donc pas de nouvelle logique de rôle.
- **Valeur : Élevée.** Diagnostic quotidien impossible sans repasser par `docker logs` en SSH — contredit l'objectif de remplacer Portainer/SSH au quotidien.

**3. Notifications sortantes vers canaux externes (Slack/Discord/Telegram/email/webhook générique)**
Coolify route ses notifications (succès/échec de déploiement, succès/échec de backup, tâche planifiée échouée, usage disque, serveur injoignable) vers 7 canaux — Email, Telegram, Discord, Slack, Mattermost, Pushover, webhook HTTP custom — avec un routage indépendant par canal et par type d'événement ([coolify.io/docs/knowledge-base/notifications](https://coolify.io/docs/knowledge-base/notifications)) ; Railway propose de son côté "Webhooks and alerting" ([railway.com/features](https://railway.com/features)). QUAI a un watchdog et un réconciliateur GitOps qui émettent déjà des événements edge-triggered typés (`SystemNotificationEvent`), mais uniquement consommés en interne (toast + `GET /api/notifications`).
- **Effort : Faible/Moyen.** Le typage et la détection d'événements existent déjà (`notificationsStore.ts`) ; il s'agit d'ajouter un envoi HTTP POST (webhook générique,+ templates simples pour Slack/Discord/email SMTP) déclenché sur la même émission d'événement, avec une configuration par admin (URL webhook / SMTP) suivant le pattern déjà établi pour `registries`/`secrets` (chiffrement au repos des identifiants SMTP).
- **Valeur : Élevée.** Une petite équipe IT de mairie ne garde pas QUAI ouvert en permanence ; sans canal sortant, une intégration injoignable ou une CVE Critical peut rester invisible des heures.

**4. Sauvegardes automatiques de bases de données/volumes**
Coolify configure, par ressource, une destination S3-compatible (AWS, MinIO, Cloudflare R2…), une fréquence cron (ex. `0 */6 * * *`) et un nombre de copies à conserver avec rotation automatique ([coolify.io/docs/knowledge-base/s3/aws](https://coolify.io/docs/knowledge-base/s3/aws), [coolify.io/docs/knowledge-base/s3-storages](https://www.coolify.io/docs/knowledge-base/s3-storages)). Dokploy : sauvegarde programmée (cron) avec compression et upload S3, restauration depuis l'UI avec confirmation explicite ([docs.dokploy.com/docs/core/backups](https://docs.dokploy.com/docs/core/backups)). QUAI n'a aujourd'hui aucun mécanisme de sauvegarde programmée — l'explorateur de volume est lecture seule, sans export.
- **Effort : Moyen.** Suit le pattern déjà éprouvé par `scanScheduler.ts` (cycle en tâche de fond, `startScheduler()` depuis `index.ts#main()`, jamais depuis `buildServer()`) : sous-processus `pg_dump`/`mysqldump`/`tar` réel (jamais réimplémenté, cohérent avec le principe déjà établi du projet), upload vers un stockage S3-compatible on-prem (MinIO local de la mairie, pas AWS) ou un simple volume réseau, rotation/rétention configurable, historique des sauvegardes avec statut, action de restauration avec `ConfirmDialog` destructive.
- **Valeur : Élevée.** Continuité de service et conservation réglementaire des données — exigences typiques du secteur public, aujourd'hui un angle mort complet de QUAI malgré la profondeur du reste du produit.

**5. Métriques temps réel et historiques avec graphiques dans le temps**
Railway : graphiques CPU/mémoire/disque/réseau par service avec 30 jours de rétention et repères visuels de déploiement sur le graphe ([docs.railway.com/guides/metrics](https://docs.railway.com/guides/metrics)). Coolify va plus loin avec un agent dédié léger ("Sentinel", conteneur Go déployé par défaut sur chaque serveur géré) qui *pousse* ses métriques CPU/RAM échantillonnées ~10s, disque ~60s, réseau, affichées comme barres par conteneur dans le dashboard, avec repli SSH si l'agent est absent ([coolify.io/docs/knowledge-base/server/sentinel](https://coolify.io/docs/knowledge-base/server/sentinel)). QUAI expose déjà `cpuPercent`/`memBytes` en instantané (topologie, `ClusterNode`, `ContainerRef`, calculés à chaque requête) mais ne persiste aucune série temporelle et n'a pas de collecte poussée en continu.
- **Effort : Moyen.** Un scrape périodique léger (`docker stats` déjà lu ponctuellement par `docker.ts`) écrit dans un store JSON Lines à fenêtre glissante (même pattern que `notifications-log.jsonl`), consommé par un petit graphique côté `apps/web` (pas de dépendance de charting lourde nécessaire pour un sparkline/line chart simple) — un agent poussé façon Sentinel serait plus proche de l'état de l'art mais alourdirait significativement le périmètre (nouveau composant à déployer par environnement) ; un scrape côté API reste suffisant pour un premier lot.
- **Valeur : Élevée à moyenne.** Diagnostic de dérive de charge et dimensionnement sans dépendre d'un Grafana externe — cohérent avec la philosophie "tout dans QUAI" déjà appliquée aux scans/GitOps.

**6. Cron Jobs comme type de service natif**
Railway traite un cron comme un type de service à part entière : champ crontab, exécution qui saute le cycle suivant si le précédent tourne encore, minimum 5 minutes ([docs.railway.com/cron-jobs](https://docs.railway.com/cron-jobs)). QUAI n'a aucun équivalent — un besoin périodique (purge de logs, rapport, sauvegarde ci-dessus) nécessite aujourd'hui un cron externe au système d'exploitation hôte, hors du périmètre de QUAI.
- **Effort : Faible.** Réutilise le cycle start/stop de conteneur déjà existant (`POST /api/containers`, `docker.ts`) ; ajoute un scheduler et une logique anti-chevauchement proche de celle déjà écrite pour `scanScheduler.ts`/`watchdog.ts`.
- **Valeur : Élevée.** Complète naturellement la recommandation n°3 (sauvegardes) et couvre un besoin récurrent réel d'une DSI de mairie (rapports, purges, resynchronisations).

### Priorité 2 — Effort moyen, valeur moyenne à élevée

**7. Déploiement automatique sur push Git (webhook entrant)**
CapRover génère une URL de webhook par application ; le fournisseur Git envoie un `POST` à chaque push sur la branche surveillée, déclenchant un build immédiat sans attendre de cycle de scan ([caprover.com/docs/deployment-methods.html](https://caprover.com/docs/deployment-methods.html)) ; Coolify et Dokploy ont le même mécanisme. QUAI a déjà l'intégration GitHub complète (détection Dockerfile/compose/Terraform, déploiement, historique) mais le déploiement reste toujours déclenché manuellement depuis l'UI (`POST /api/github/repos/:owner/:repo/deploy`).
- **Effort : Faible/Moyen.** Ajoute une route webhook GitHub (signature HMAC à vérifier) qui appelle `startDeployment()` déjà existant — aucune nouvelle logique de déploiement, juste un nouveau déclencheur. Pour le volet GitOps, réduirait la latence entre push et dérive visible sans automatiser la mise en prod (la synchronisation explicite par clic resterait le mécanisme de mise en prod, conformément au principe déjà établi).
- **Valeur : Moyenne à élevée.** Confort réel et gain de réactivité pour les apps internes de la mairie à cadence de mise à jour régulière ; moins critique si le rythme de déploiement reste faible.

**8. Environment Groups / scoping des accès par site**
Portainer regroupe les environnements par tags (statiques ou dynamiques) avec héritage d'accès par groupe ([docs.portainer.io/admin/environments/groups](https://docs.portainer.io/admin/environments/groups), [docs.portainer.io/user/edge/groups](https://docs.portainer.io/user/edge/groups)). QUAI a déjà un sélecteur d'environnement dans le Topbar mais aucune notion de groupement ni de restriction d'accès par site.
- **Effort : Moyen.** Ajoute une couche de tags sur `Environment` + un filtre de mapping LDAP-groupe→environnements autorisés (extension du mapping groupe→rôle déjà existant dans `LDAP_GROUP_ROLE_MAP`).
- **Valeur : Élevée si la mairie gère plusieurs sites** (écoles, médiathèque, services techniques) avec des opérateurs IT dont l'accès devrait être scopé — sinon moyenne pour une équipe IT centralisée unique.

**9. Templates / catalogue d'apps one-click**
Dokploy maintient un catalogue communautaire de 500+ configurations Docker Compose ([dokploy.com/templates](https://dokploy.com/templates), [github.com/Dokploy/templates](https://github.com/Dokploy/templates)) ; CapRover référence un dépôt communautaire de dizaines d'apps prêtes à déployer (PostgreSQL, MySQL, WordPress, Nextcloud, Ghost, Strapi…) sélectionnables en un clic ([caprover.com/docs/one-click-apps.html](https://caprover.com/docs/one-click-apps.html)) ; Coolify a un catalogue similaire (280+ services). QUAI n'a ni catalogue ni scaffold réutilisable — chaque conteneur est créé via le formulaire brut ou via GitOps.
- **Effort : Moyen.** QUAI parse déjà des fichiers compose (détection GitHub) ; ajouter une petite bibliothèque de templates locaux (pas un marketplace externe géré par un tiers, cohérent avec le principe "rien d'inventé/tiers non maîtrisé") avec résolution automatique domaine (reverse proxy)/volume/secret référencé par nom.
- **Valeur : Moyenne à élevée.** Utile pour les briques standard qu'une mairie redéploie régulièrement (Nextcloud, outils internes, bases de test) sans dépôt Git dédié à créer/maintenir à chaque fois.

**10. App Catalog Helm pour Kubernetes**
Rancher permet d'installer des charts Helm depuis un dépôt Git/HTTP/OCI avec formulaire généré depuis `values.yaml`/`questions.yaml`, upgrade/rollback via "Recent Operations" ([ranchermanager.docs.rancher.com/.../helm-charts-in-rancher](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/helm-charts-in-rancher)). QUAI pilote Kubernetes (`@kubernetes/client-node`) mais n'a pas d'équivalent catalogue Helm.
- **Effort : Moyen.** Parsing `index.yaml`/charts OCI + génération de formulaire dynamique — pas de nouveau protocole, travail principalement UI, dans la continuité du pattern déjà en place pour les registries d'images.
- **Valeur : Moyenne à élevée, conditionnée à l'usage réel de Kubernetes par la mairie** (le périmètre v1 de QUAI dit "migration Swarm→K8s en cours" — pertinence croissante avec le temps).

**11. Rollback en un clic**
Railway : "Atomic deploys with one-click rollback and full deploy history" ([railway.com/features](https://railway.com/features)). QUAI a un historique de déploiement GitHub et de runs IaC, mais pas de bouton "revenir à l'image/version précédente" pour un conteneur.
- **Effort : Moyen.** Nécessite de conserver la référence d'image précédente par conteneur et un flux "recreate avec l'ancienne image" (recycle largement `POST /api/images/:id/update` existant).
- **Valeur : Moyenne.** Utile en cas de mise à jour d'image ratée, complète la fonctionnalité "détection de mise à jour" déjà en place.

**12. Health checks configurables entièrement depuis l'UI**
Coolify permet de définir un path HTTP, un code de réponse attendu et un intervalle de vérification depuis un formulaire, sans écrire d'instruction `HEALTHCHECK` dans le Dockerfile — Traefik ne route le trafic qu'aux instances qui passent le check ([coolify.io/docs/knowledge-base/health-checks](https://coolify.io/docs/knowledge-base/health-checks)). QUAI lit déjà le healthcheck Docker natif pour colorer le graphe de topologie (`healthStatus`), mais uniquement en lecture — rien ne permet d'en *définir* un pour une image qui n'en a pas.
- **Effort : Faible/Moyen.** Ajoute un éditeur qui génère la configuration `HEALTHCHECK` à la création/mise à jour du conteneur (dockerode expose `Healthcheck` dans la config de création) — suit le même esprit que la lecture déjà en place.
- **Valeur : Moyenne.** Gain de confort plutôt que capacité nouvelle puisque QUAI affiche déjà l'état de santé natif ; utile surtout pour les images sans `HEALTHCHECK` déjà écrit (cas fréquent en pratique, d'après le constat déjà documenté dans `ARCHITECTURE.md` : "none" est le résultat honnête pour la plupart des conteneurs d'un host de dev).

### Priorité 3 — Effort plus élevé ou valeur conditionnelle

**13. Edge Agent (polling sortant pour sites déconnectés/pare-feu restrictif)**
Portainer : l'agent distant initie la connexion sortante vers le serveur central, aucun port entrant nécessaire sur le site distant, avec file d'attente d'approbation ("Waiting Room") ([docs.portainer.io/user/edge](https://docs.portainer.io/user/edge), [docs.portainer.io/advanced/edge-agent](https://docs.portainer.io/advanced/edge-agent)). Le modèle actuel de QUAI pour les environnements Docker distants suppose une connexion entrante TCP+TLS initiée par QUAI.
- **Effort : Élevé.** Architecture d'agent et de protocole de polling entièrement nouvelle, distincte du modèle actuel.
- **Valeur : Élevée pour des annexes de mairie/écoles derrière un pare-feu restrictif** où ouvrir un port entrant est indésirable — mais chantier lourd, à ne considérer qu'après les priorités 1-2.

**14. Contrôle d'accès par ressource individuelle**
Portainer applique un modèle Private/Restricted/Public à chaque ressource (conteneur, volume, network, stack) indépendamment du rôle global ([docs.portainer.io/advanced/access-control](https://docs.portainer.io/advanced/access-control)).
- **Effort : Moyen.** Extension logique du RBAC global actuel, mais touche chaque point de contrôle d'accès de l'API.
- **Valeur : Moyenne** — utile si l'IT délègue des ressources à des services précis, moins critique pour une équipe IT centralisée restreinte (cas probable d'une mairie).

**15. RBAC granulaire par Project/Namespace (Kubernetes)**
Rancher structure les accès en Cluster/Project/rôles custom, avec des Projects regroupant plusieurs namespaces ([ranchermanager.docs.rancher.com/.../cluster-and-project-roles](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/authentication-permissions-and-global-configuration/manage-role-based-access-control-rbac/cluster-and-project-roles)).
- **Effort : Élevé.** Refonte du modèle d'autorisation actuel (3 rôles globaux), pas une extension d'un pattern existant.
- **Valeur : Moyenne**, à ne considérer que si un besoin concret de séparation par service métier émerge côté mairie.

**16. Reference Variables (auto-câblage `${{Service.VAR}}` entre services)**
Railway permet à une variable d'un service de référencer directement une variable d'un autre service ou une variable partagée de projet ([docs.railway.com/variables/reference](https://docs.railway.com/variables/reference)).
- **Effort : Faible/Moyen.** Extension du pattern secrets-référencés-par-nom déjà en place (`secretEnv`).
- **Valeur : Moyenne** — confort plutôt que besoin critique vu la taille probablement restreinte des stacks d'une mairie.

**17. Preview/PR Environments**
Railway clone l'environnement complet pour chaque PR et le détruit à la fermeture ([docs.railway.com/guides/preview-deployments-with-pr-environments](https://docs.railway.com/guides/preview-deployments-with-pr-environments)) ; Dokploy fait de même avec un sous-domaine `preview-{app}-{id}` ([docs.dokploy.com/docs/core/applications/preview-deployments](https://docs.dokploy.com/docs/core/applications/preview-deployments)).
- **Effort : Élevé.** Orchestration de clonage d'environnement complet + cycle de vie éphémère + hooks GitHub, à greffer sur le réconciliateur GitOps existant.
- **Valeur : Faible pour une mairie** avec peu de développeurs internes et des apps majoritairement stables en workflow PR actif — à ne considérer que si QUAI vise aussi des équipes de dev internes actives.

**18. CLI de déploiement (bas de la liste, valeur incertaine)**
CapRover propose un client CLI (`caprover deploy`) avec un mode stateless pour intégration non interactive en pipeline CI/CD ([caprover.com/docs/cli-commands.html](https://caprover.com/docs/cli-commands.html)).
- **Effort : Faible/Moyen.** QUAI a déjà un backend de déploiement (utilisé par l'intégration GitHub) ; exposer un client CLI fin par-dessus ne demande pas de nouveau protocole.
- **Valeur : Faible à moyenne, à confirmer côté besoin réel.** QUAI cible une utilisation console web ; un CLI n'a de valeur que si la mairie a des scripts d'automatisation internes hors GitOps — non identifié comme besoin exprimé dans le périmètre actuel du projet.

**Point de vigilance (pas une recommandation ferme) — ajout de nœud à un cluster depuis l'UI.** CapRover permet de joindre un nouveau nœud à son cluster Swarm depuis l'UI (IP + clé SSH root, [caprover.com/docs/app-scaling-and-cluster.html](https://caprover.com/docs/app-scaling-and-cluster.html)). QUAI dispose déjà d'ateliers OpenTofu/Ansible/Packer potentiellement capables de couvrir ce besoin de provisioning ; avant d'envisager une UX "no-code" dédiée, il faudrait d'abord clarifier si le provisioning de nœuds fait déjà partie du périmètre réel des workshops IaC existants, pour ne pas dupliquer une capacité déjà présente sous une autre forme.

---

## 4. Écarté délibérément (fonctionnalités concurrentes hors-sujet pour ce cas d'usage)

| Fonctionnalité concurrente | Pourquoi elle est écartée pour QUAI |
|---|---|
| **Marketplace de templates payant, commission jusqu'à 25 %** (Railway, [docs.railway.com/reference/templates](https://docs.railway.com/reference/templates)) | Mécanisme de monétisation SaaS pur (mainteneurs tiers rémunérés à l'usage). Aucun sens pour une infra interne de mairie sans écosystème d'éditeurs tiers à rémunérer. |
| **Facturation à l'usage / per-second billing, autoscaling élastique multi-région** (Railway) | QUAI pilote un parc de serveurs physiques/VMs fixe (Docker/Swarm/K8s/Nutanix on-prem) — pas de capacité de calcul élastique à la demande ni de facturation interne à la seconde. |
| **Réplicas horizontaux multi-région / CDN edge global** (Railway) | Un seul site (ou un nombre très limité de datacenters) pour une mairie — pas de distribution géographique de trafic à optimiser. |
| **Fleet (GitOps à l'échelle de dizaines de clusters K8s)** (Rancher, [github.com/rancher/fleet](https://github.com/rancher/fleet)) | Conçu pour des flottes de 10+ clusters avec provisioning différencié par région. Une mairie de taille moyenne opère un cluster K8s, deux au maximum — la dimension "fleet à grande échelle" n'apporte rien ; QUAI a déjà un réconciliateur GitOps adapté à son échelle. |
| **Cluster Templates de gouvernance** (Rancher, [ranchermanager.docs.rancher.com/.../manage-cluster-templates](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/manage-clusters/manage-cluster-templates)) | Utile pour des organisations qui créent des clusters K8s en série avec des équipes multiples ; une mairie avec un nombre de clusters fixe et restreint n'a pas ce besoin de gouvernance à l'échelle. |
| **Rancher Desktop** ([rancherdesktop.io](https://docs.rancherdesktop.io/)) | Outil de bureau pour poste de développeur (K8s local via k3s) — hors périmètre d'une console de gestion d'infra serveur. |
| **Portail Edge industriel / intégrations OT, MQTT, OPC** (Portainer, [portainer.io/features](https://www.portainer.io/features)) | Ciblé IoT industriel (capteurs, automates). Une mairie n'a pas d'infrastructure OT de ce type à gérer via QUAI. |
| **Change Windows façon ITSM** (Portainer Business Edition) | Gouvernance de gates de déploiement pensée pour de grandes DSI avec processus de changement formalisés. Disproportionné pour une équipe IT de mairie réduite ; le modèle actuel de QUAI (action explicite + confirmation) offre déjà le contrôle nécessaire à cette échelle sans lourdeur processuelle. |
| **Auto-remédiation de la dérive GitOps / "policy once, enforce everywhere"** (Portainer Fleet Governance, esprit Rancher Fleet) | **Contredit un principe déjà établi de QUAI** : l'application d'un changement GitOps reste une action explicite depuis l'UI, jamais automatique (voir `ARCHITECTURE.md`, chapitre GitOps). Ce choix est déjà assumé et documenté — à ne pas remettre en cause pour "coller" à ces concurrents. |

---

## Notes méthodologiques

- Toutes les fonctionnalités listées comme déjà présentes dans QUAI ont été vérifiées directement dans le code (`ARCHITECTURE.md` intégral + lecture des fichiers de routes cités) avant toute recommandation — aucune recommandation ne duplique une fonctionnalité déjà livrée à connaissance de cette analyse.
- Chaque finding concurrent cite l'URL officielle exacte consultée (documentation produit ou dépôt GitHub officiel) — pas de citation de blog tiers non officiel comme source primaire.
- Les estimations d'effort supposent la poursuite des principes déjà établis du projet : jamais de données fabriquées, toujours de vrais outils/binaires pilotés en sous-processus plutôt que réimplémentés, chiffrement au repos systématique de tout secret persisté.
