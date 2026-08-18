import SearchPicker from "@/components/SearchPicker";
import { searchPackages, type PackageSearchDistro, type PackageSearchItem } from "@/features/templates/packagesApi";

/** Recherche de vrais paquets de la distro (SearchPicker + GET /api/packages/search) — partagée
 * entre l'étape "paquets" du studio et le popover d'étape du sous-graphe. */
export default function PackageSearch({
  id = "studio-pkg-search",
  distro,
  added,
  busy,
  onPick,
}: {
  id?: string;
  distro: PackageSearchDistro;
  added: string[];
  busy: boolean;
  onPick: (item: PackageSearchItem) => void;
}) {
  return (
    <SearchPicker<PackageSearchItem>
      id={id}
      label={`Rechercher un paquet (${distro})`}
      placeholder="ex : nginx (2 caractères minimum)"
      busy={busy}
      searchKey={distro}
      search={(q) => searchPackages(distro, q)}
      keyOf={(item) => item.name}
      isItemDisabled={(item) => added.includes(item.name)}
      onPick={onPick}
      renderItem={(item) => (
        <>
          <span className="search-picker__name">{item.name}</span>
          {item.version && <span className="search-picker__badge">{item.version}</span>}
          {added.includes(item.name) && <span className="search-picker__added">ajouté ✓</span>}
          {item.summary && <span className="search-picker__summary">{item.summary}</span>}
        </>
      )}
      emptyMessage={(q) => `Aucun paquet ${distro} trouvé pour « ${q} ».`}
      unavailableMessage="Recherche indisponible — saisie libre ci-dessous."
      listAriaLabel="Paquets trouvés"
    />
  );
}
