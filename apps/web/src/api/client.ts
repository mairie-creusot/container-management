// Client HTTP minimal pour l'API QUAI (apps/api).
// Base URL configurable via VITE_API_BASE_URL — sinon RELATIVE ("/api", jamais une URL absolue
// "http://localhost:3000" en dur) : le serveur de dev Vite proxy déjà "/api" vers le conteneur
// API (voir vite.config.ts), et une URL relative reste valide quel que soit l'hôte/schéma depuis
// lequel la page est chargée. Une URL absolue figée cassait l'accès via le reverse proxy interne
// en HTTPS (ex: https://quai.lecreusot.priv, services/reverseProxy.ts) : le navigateur bloque en
// contenu mixte tout appel http:// actif depuis une page https:// — constaté en conditions
// réelles le 13/08/2026, la connexion LDAP échouait silencieusement, aucune requête n'atteignait
// jamais l'API. La sortie de la construction de production (Dockerfile.web, fichiers statiques
// sans serveur de dev/proxy) continue de fournir VITE_API_BASE_URL explicitement, inchangé.
// La session est portée par un cookie httpOnly côté serveur (auth LDAP) :
// toutes les requêtes doivent donc inclure les credentials.

const BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, "") ?? "/api";

/**
 * Base URL WebSocket dérivée de BASE_URL (même hôte/port que l'API HTTP, schéma ws(s)://
 * à la place de http(s)://) — utilisée par la console conteneur (ContainerConsole.tsx) et le
 * flux de logs temps réel (ContainerLogs.tsx). BASE_URL absolue (VITE_API_BASE_URL positionné) :
 * simple substitution de schéma. BASE_URL relative (cas par défaut, voir ci-dessus) : reconstruite
 * depuis `window.location` — le schéma ws(s) suit le schéma de la page (wss:// sur une page
 * https://, jamais un mélange de contenu qui serait bloqué comme pour l'appel HTTP ci-dessus).
 * Le cookie de session est envoyé automatiquement par le navigateur avec la requête d'upgrade
 * WebSocket (même domaine, `credentials: "include"` n'existe pas pour l'API WebSocket — le
 * cookie httpOnly part de toute façon avec toute requête vers ce host).
 */
export function wsUrl(path: string): string {
  if (/^https?:/.test(BASE_URL)) return `${BASE_URL.replace(/^http/, "ws")}${path}`;
  const wsScheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsScheme}//${window.location.host}${BASE_URL}${path}`;
}

/** URL absolue vers une route de l'API — pour un lien de téléchargement direct (ex: le certificat
 * racine du reverse proxy, PublicationPage.tsx) plutôt qu'un fetch : le cookie de session part
 * quand même (même hôte que l'app, sameSite=strict autorise une navigation directe). */
export function apiUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

export class ApiError extends Error {
  status: number;
  /** Corps JSON complet de la réponse d'erreur, au-delà du seul champ `error` déjà extrait dans
   * `message` — certaines routes ajoutent des indicateurs structurés (ex: `useContainerStopInstead`
   * sur POST .../processes/:pid/kill, voir containersSlice.ts#killContainerProcess) qu'un
   * appelant peut avoir besoin d'inspecter. `undefined` si le corps n'était pas du JSON exploitable. */
  details?: Record<string, unknown>;

  constructor(status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    // `exactOptionalPropertyTypes` interdit d'assigner `undefined` explicitement à un champ
    // optionnel — omis plutôt qu'assigné quand absent, jamais { details: undefined } en pratique.
    if (details !== undefined) this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    ...init,
  });

  if (!response.ok) {
    let message = `Erreur ${response.status} sur ${path}`;
    let details: Record<string, unknown> | undefined;
    try {
      // Les routes de l'API renvoient toujours { error: "..." } (jamais { message }) —
      // voir n'importe quelle route de apps/api/src/routes/*.ts.
      const body = (await response.json()) as { error?: string; message?: string } & Record<string, unknown>;
      if (body?.error || body?.message) message = body.error ?? body.message ?? message;
      details = body;
    } catch {
      // corps non-JSON, on garde le message par défaut
    }
    throw new ApiError(response.status, message, details);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = body !== undefined ? { method: "POST", body: JSON.stringify(body) } : { method: "POST" };
  return request<T>(path, init);
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = body !== undefined ? { method: "PUT", body: JSON.stringify(body) } : { method: "PUT" };
  return request<T>(path, init);
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = body !== undefined ? { method: "PATCH", body: JSON.stringify(body) } : { method: "PATCH" };
  return request<T>(path, init);
}
