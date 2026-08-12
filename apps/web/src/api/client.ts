// Client HTTP minimal pour l'API QUAI (apps/api).
// Base URL configurable via VITE_API_BASE_URL (défaut http://localhost:3000/api).
// La session est portée par un cookie httpOnly côté serveur (auth LDAP) :
// toutes les requêtes doivent donc inclure les credentials.

const BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, "") ??
  "http://localhost:3000/api";

/**
 * Base URL WebSocket dérivée de BASE_URL (même hôte/port que l'API HTTP, schéma ws(s)://
 * à la place de http(s)://) — utilisée par la console conteneur (ContainerConsole.tsx).
 * Le cookie de session est envoyé automatiquement par le navigateur avec la requête d'upgrade
 * WebSocket (même domaine, `credentials: "include"` n'existe pas pour l'API WebSocket — le
 * cookie httpOnly part de toute façon avec toute requête vers ce host).
 */
export function wsUrl(path: string): string {
  return `${BASE_URL.replace(/^http/, "ws")}${path}`;
}

/** URL absolue vers une route de l'API — pour un lien de téléchargement direct (ex: le certificat
 * racine du reverse proxy, ReverseProxyPage.tsx) plutôt qu'un fetch : le cookie de session part
 * quand même (même hôte que l'app, sameSite=strict autorise une navigation directe). */
export function apiUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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
    try {
      // Les routes de l'API renvoient toujours { error: "..." } (jamais { message }) —
      // voir n'importe quelle route de apps/api/src/routes/*.ts.
      const body = (await response.json()) as { error?: string; message?: string };
      if (body?.error || body?.message) message = body.error ?? body.message ?? message;
    } catch {
      // corps non-JSON, on garde le message par défaut
    }
    throw new ApiError(response.status, message);
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
