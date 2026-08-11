/** Petit wrapper fetch avec timeout, partagé par les clients registries. */

import { config } from "../../config.js";

export class RegistryHttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "RegistryHttpError";
  }
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.registries.requestTimeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new RegistryHttpError(`Request to ${url} failed with status ${response.status}`, response.status);
    }
    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof RegistryHttpError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new RegistryHttpError(`Request to ${url} timed out after ${config.registries.requestTimeoutMs}ms`);
    }
    throw new RegistryHttpError(`Request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}
