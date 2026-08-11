# QUAI — container-management

Alternative moderne et ciblée à [Portainer](https://github.com/portainer/portainer) : gestion des images avec différents registries (Docker Hub, GHCR, GitLab, Harbor), consultation des images locales, détection des mises à jour disponibles, GitOps (le dépôt Git est la seule source de vérité), orchestration Docker Swarm et Kubernetes (les deux, pour la migration en cours), vue des environnements et des nœuds de cluster, authentification LDAP.

Concept validé — voir [ARCHITECTURE.md](ARCHITECTURE.md) pour le contrat technique complet (stack, contrats de données, routes API, auth LDAP, interface WASM, pipeline CI/CD).

## Stack

TypeScript · React + Redux Toolkit · Node.js/Fastify · WebAssembly (Rust) · Docker Swarm · Kubernetes · LDAP · GitHub Actions → GHCR

## Structure du monorepo

```
apps/api/            serveur Fastify — Docker/Swarm, Kubernetes, registries, GitOps, auth LDAP
apps/web/             UI React/Redux
packages/wasm-core/    diff de manifestes (Rust → WASM)
deploy/                Dockerfiles, docker-compose de dev, manifestes k8s/swarm, pipeline GHCR
```

## Cahier des charges d'origine

Il faudrait pouvoir gérer les images avec différents registries (DockerHub, GHCR, Gitlab ...), consulter les images locales, mettre à jour les images de conteneurs (voir les nouvelles versions disponibles), pouvoir mettre en place le GitOps (le code source est la seule source de vérité), gérer les conteneurs avec Docker Swarm ou Kubernetes (ou les deux pour une éventuelle migration), voir les différents environnements et noeuds de cluster.
