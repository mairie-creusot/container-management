// Catalogue d'images cloud vérifiées côté serveur (GET /api/cloud-images) — module autonome
// comme packagesApi/dockerhubApi : types locaux, rien dans templatesSlice/types.ts.
import { apiGet } from "@/api/client";

export interface CloudImageVersion {
  version: string;
  label: string;
  url: string;
}

export interface CloudImageDistro {
  distro: string;
  label: string;
  versions: CloudImageVersion[];
}

export type CloudImageCatalogOutcome = { state: "ok"; distros: CloudImageDistro[] } | { state: "unavailable" };

export async function fetchCloudImageCatalog(): Promise<CloudImageCatalogOutcome> {
  try {
    const res = await apiGet<{ distros: CloudImageDistro[] }>("/cloud-images");
    return { state: "ok", distros: res.distros ?? [] };
  } catch {
    return { state: "unavailable" };
  }
}

export type CloudImageCheckOutcome =
  | { state: "checked"; ok: boolean; status: number; sizeBytes?: number }
  | { state: "failed"; message: string };

/** HEAD réel côté serveur — un échec d'appel reste "failed" (jamais d'affirmation sans preuve). */
export async function checkCloudImageUrl(url: string): Promise<CloudImageCheckOutcome> {
  try {
    const res = await apiGet<{ ok: boolean; status: number; sizeBytes?: number }>(
      `/cloud-images/check?url=${encodeURIComponent(url)}`,
    );
    return {
      state: "checked",
      ok: res.ok,
      status: res.status,
      ...(res.sizeBytes !== undefined ? { sizeBytes: res.sizeBytes } : {}),
    };
  } catch (err) {
    return { state: "failed", message: err instanceof Error ? err.message : "Vérification impossible." };
  }
}

/** Taille humaine en unités binaires ("2,4 Gio", "512 Mio"). */
export function formatImageSize(bytes: number): string {
  const gib = bytes / 2 ** 30;
  if (gib >= 1) return `${gib.toFixed(1).replace(".", ",")} Gio`;
  return `${Math.round(bytes / 2 ** 20)} Mio`;
}

/** Version proposée par défaut : la LTS la plus récente si le catalogue en étiquette, sinon la
 * version numériquement la plus récente. */
export function defaultCatalogVersion(versions: CloudImageVersion[]): CloudImageVersion | null {
  if (versions.length === 0) return null;
  const lts = versions.filter((v) => /\bLTS\b/i.test(v.label));
  const pool = lts.length > 0 ? lts : versions;
  const num = (s: string) => {
    const n = parseFloat(s);
    return Number.isNaN(n) ? -1 : n;
  };
  return [...pool].sort((a, b) => num(b.version) - num(a.version))[0] ?? null;
}
