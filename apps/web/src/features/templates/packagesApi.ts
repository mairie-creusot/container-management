// Recherche de paquets réels (GET /api/packages/search, proxy Repology côté serveur) — module
// autonome comme lintApi.ts : types locaux, aucun ajout dans templatesSlice/types.ts.
import { apiGet } from "@/api/client";
import { ISO_OS_FAMILY_PACKAGE_DISTRO, isUnattendedIso } from "@/features/templates/templateCatalog";
import type { TemplateBase } from "@/types";

export const PACKAGE_SEARCH_DISTROS = ["debian", "ubuntu", "alpine", "fedora", "arch"] as const;
export type PackageSearchDistro = (typeof PACKAGE_SEARCH_DISTROS)[number];

export interface PackageSearchItem {
  name: string;
  version?: string;
  summary?: string;
}

export type PackageSearchOutcome = { state: "ok"; results: PackageSearchItem[] } | { state: "unavailable" };

function asSearchDistro(raw: string): PackageSearchDistro | null {
  const name = raw.trim().toLowerCase();
  if (name === "archlinux") return "arch";
  return (PACKAGE_SEARCH_DISTROS as readonly string[]).includes(name) ? (name as PackageSearchDistro) : null;
}

/** Distro de recherche déduite de la base de la recette — null quand rien de fiable (recherche
 * masquée, saisie libre seule). ISO automatisé : déduite de osFamily (rhel → fedora, la plus
 * proche réellement supportée) ; ISO manuel : null (aucune étape possible). */
export function packageSearchDistro(base: TemplateBase): PackageSearchDistro | null {
  if (base.type === "iso") {
    if (!isUnattendedIso(base) || base.osFamily === undefined) return null;
    return ISO_OS_FAMILY_PACKAGE_DISTRO[base.osFamily];
  }
  if (base.type === "container") {
    const image = (base.image.split("/").pop() ?? "").split(":")[0] ?? "";
    return asSearchDistro(image);
  }
  return asSearchDistro(base.distro);
}

/** Toute erreur (502 Repology injoignable, backend absent…) -> "unavailable" : la saisie libre
 * reste le chemin nominal, jamais de fausse liste. */
export async function searchPackages(distro: PackageSearchDistro, q: string): Promise<PackageSearchOutcome> {
  try {
    const res = await apiGet<{ results: PackageSearchItem[] }>(
      `/packages/search?distro=${distro}&q=${encodeURIComponent(q)}`,
    );
    return { state: "ok", results: res.results ?? [] };
  } catch {
    return { state: "unavailable" };
  }
}
