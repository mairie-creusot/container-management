# @quai/web

Interface web de QUAI (console de gestion de conteneurs) — React + Redux Toolkit + Vite + TypeScript.

Porte fidèlement les artifacts de cadrage validés (prototype HTML/CSS/JS clickable) en application
réelle : composants React, état géré via Redux Toolkit (slices + `createAsyncThunk`), données lues
depuis `apps/api` (aucune donnée en dur dans les composants).

## Prérequis

- Node.js ≥ 18
- `apps/api` démarré (par défaut sur `http://localhost:3000`)

## Installation

Depuis la racine du monorepo (workspace pnpm) :

```bash
pnpm install
```

Ou, en local dans `apps/web` uniquement :

```bash
npm install
```

## Configuration

Copier `.env.example` en `.env` et ajuster si besoin :

```bash
cp .env.example .env
```

- `VITE_API_BASE_URL` — base URL de l'API QUAI, préfixe `/api` inclus (défaut
  `http://localhost:3000/api`).

## Développement

```bash
pnpm --filter @quai/web dev
# ou, depuis apps/web :
npm run dev
```

L'application est servie sur `http://localhost:5173`. La session (auth LDAP) est portée par un
cookie `httpOnly` posé par l'API : `apps/api` doit tourner et autoriser l'origine du dev server en
CORS avec credentials.

## Build

```bash
npm run build
```

Type-check (`tsc -b`) puis build de production Vite dans `dist/`.

## Tests

```bash
npm run test
```

Exécute les tests avec Vitest + Testing Library.

## Structure

```
src/
  api/           client HTTP (fetch) vers apps/api
  components/    composants réutilisables (Sidebar, Topbar, Inspector, StatusPill, AreaChart, Donut, Gauge, icônes)
  features/
    auth/        session LDAP (slice + écran de connexion)
    overview/    vue d'ensemble (stats agrégées, graphique, donut, activité)
    images/      catalogue d'images + mise à jour
    registries/  registries configurés + ajout
    containers/  conteneurs en cours d'exécution
    gitops/      manifestes, diff, commits, resynchronisation
    clusters/    environnements et nœuds
    ui/          état transverse (vue active, recherche, environnement sélectionné)
  styles/        variables de thème (sombre uniquement) + feuilles de styles
  types.ts       réplique des contrats de données d'ARCHITECTURE.md
  store.ts       configureStore (un reducer par domaine)
  App.tsx        garde d'authentification + shell applicatif (sidebar/topbar/contenu)
```

## Notes de portage (écarts volontaires par rapport au prototype)

- **Pas de librairie de routing** : la navigation entre écrans se fait via un slice Redux
  (`ui.currentView`), pas d'URL — cohérent avec la liste de dépendances imposée (pas de
  `react-router` dans `package.json`).
- **Vue d'ensemble** : ARCHITECTURE.md ne définit pas d'endpoint `/api/overview`. Les cartes stats,
  le graphique d'utilisation et le donut sont donc calculés côté client à partir des endpoints
  existants (`/containers`, `/images`, `/environments` + `/environments/:id/nodes`, `/registries`,
  `/gitops/files`). Le graphique d'utilisation trace CPU/mémoire **par nœud** (donnée réelle
  instantanée) plutôt qu'une série temporelle, faute d'endpoint d'historique. Le flux « activité
  récente » réutilise `GET /api/gitops/commits` (seule source chronologique du contrat).
- **Jauge mémoire (Conteneurs)** : `ContainerRef` n'expose pas de limite mémoire. La jauge affiche
  la mémoire utilisée relativement au conteneur le plus lourd actuellement listé (calcul dynamique,
  pas de constante arbitraire), avec la valeur absolue en clair à côté.
- **Rôles** : les actions `POST` (mise à jour d'image, ajout de registry, resynchronisation GitOps)
  sont désactivées côté UI si la session n'a pas le rôle `operator`/`admin` requis, en plus de
  l'application côté serveur du même contrôle décrite dans ARCHITECTURE.md.
