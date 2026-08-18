import { useEffect, useState } from "react";
import SearchPicker from "@/components/SearchPicker";
import { fetchDockerHubTags, searchDockerHubImages, type DockerHubImage } from "@/features/templates/dockerhubApi";

/** Sélecteur d'image Docker Hub en deux temps : recherche (SearchPicker) puis choix du tag —
 * remplit "name:tag" via onPick, la saisie libre du parent reste toujours disponible. */
export default function DockerImageSearch({ busy, onPick }: { busy: boolean; onPick: (image: string) => void }) {
  const [selected, setSelected] = useState<DockerHubImage | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [tagsStatus, setTagsStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setTagsStatus("loading");
    setTags([]);
    void fetchDockerHubTags(selected.name).then((result) => {
      if (cancelled) return;
      if (result.state === "unavailable") {
        setTagsStatus("unavailable");
        return;
      }
      setTags(result.tags);
      setTagsStatus("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  function pick(image: string) {
    onPick(image);
    setSelected(null);
  }

  if (selected) {
    return (
      <div className="field">
        <label>
          Tag pour <span className="cell-mono">{selected.name}</span>
        </label>
        <div className="docker-tags">
          <div className="docker-tags__head">
            <span className="search-picker__name">{selected.name}</span>
            {selected.official && <span className="search-picker__official">Officiel</span>}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(null)} disabled={busy}>
              ← autre image
            </button>
          </div>
          {tagsStatus === "loading" && <p className="template-modal__hint">Chargement des tags…</p>}
          {tagsStatus === "unavailable" && (
            <>
              <p className="template-modal__hint">Tags indisponibles — le tag peut être ajouté à la main après.</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => pick(selected.name)} disabled={busy}>
                Utiliser « {selected.name} »
              </button>
            </>
          )}
          {tagsStatus === "ready" && tags.length === 0 && (
            <>
              <p className="template-modal__hint">Aucun tag rapporté pour ce dépôt.</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => pick(selected.name)} disabled={busy}>
                Utiliser « {selected.name} »
              </button>
            </>
          )}
          {tagsStatus === "ready" && tags.length > 0 && (
            <div className="docker-tags__list">
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="docker-tags__tag"
                  onClick={() => pick(`${selected.name}:${tag}`)}
                  disabled={busy}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <SearchPicker<DockerHubImage>
      id="studio-dockerhub-search"
      label="Rechercher une image publique (Docker Hub)"
      placeholder="ex : debian, nginx (2 caractères minimum)"
      busy={busy}
      search={searchDockerHubImages}
      keyOf={(item) => item.name}
      onPick={setSelected}
      renderItem={(item) => (
        <>
          <span className="search-picker__name">{item.name}</span>
          {item.official && <span className="search-picker__official">Officiel</span>}
          <span className="search-picker__stars">⭐ {item.stars}</span>
          {item.description && <span className="search-picker__summary">{item.description}</span>}
        </>
      )}
      emptyMessage={(q) => `Aucune image trouvée pour « ${q} ».`}
      unavailableMessage="Recherche indisponible — saisie libre ci-dessous."
      listAriaLabel="Images Docker Hub trouvées"
    />
  );
}
