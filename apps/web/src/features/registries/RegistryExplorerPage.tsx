import { useEffect, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchRepoTags, fetchRepositories, stopExploring } from "@/features/registries/registriesSlice";
import { pullImage } from "@/features/images/imagesSlice";
import { canOperate } from "@/features/auth/authSlice";
import { setCurrentView } from "@/features/ui/uiSlice";
import { registryMeta } from "@/components/RegistryBadge";
import { IconChevron } from "@/components/icons";

export default function RegistryExplorerPage() {
  const dispatch = useAppDispatch();
  const { items, exploringId, repositories, reposStatus, reposError, tagsByRepo, tagsLoadingRepo } = useAppSelector(
    (s) => s.registries,
  );
  const pullStatus = useAppSelector((s) => s.images.pullStatus);
  const session = useAppSelector((s) => s.auth.session);
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null);
  const [pullingRef, setPullingRef] = useState<string | null>(null);

  const registry = items.find((r) => r.id === exploringId) ?? null;

  useEffect(() => {
    if (exploringId) dispatch(fetchRepositories(exploringId));
  }, [dispatch, exploringId]);

  function handleExpand(repo: string) {
    const next = expandedRepo === repo ? null : repo;
    setExpandedRepo(next);
    if (next && !tagsByRepo[repo] && exploringId) {
      dispatch(fetchRepoTags({ registryId: exploringId, repo }));
    }
  }

  function handlePull(reference: string) {
    setPullingRef(reference);
    dispatch(pullImage(reference)).finally(() => setPullingRef(null));
  }

  function handleBack() {
    dispatch(stopExploring());
    dispatch(setCurrentView("registries"));
  }

  if (!registry) {
    return (
      <div className="page-content">
        <div className="empty-state">
          Aucun registry sélectionné.{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={handleBack}>
            Retour aux registries
          </button>
        </div>
      </div>
    );
  }

  const meta = registryMeta(registry.kind);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <button type="button" className="btn btn-ghost btn-sm explorer-back" onClick={handleBack}>
            <IconChevron className="explorer-back__icon" /> Registries
          </button>
          <h2>Explorer {registry.name}</h2>
          <p>Catalogue distant réel de {meta.label} — {registry.url}</p>
        </div>
      </div>

      {reposStatus === "loading" && <div className="empty-state">Chargement du catalogue…</div>}
      {reposStatus === "error" && <div className="error-banner">{reposError}</div>}
      {reposStatus === "ready" && repositories.length === 0 && (
        <div className="empty-state">
          Aucun dépôt trouvé. GitLab/Harbor ne sont pas encore parcourables ici, ou les
          identifiants configurés n'ont pas accès au catalogue.
        </div>
      )}

      {repositories.length > 0 && (
        <div className="explorer-repo-list">
          {repositories.map((repo) => {
            const tags = tagsByRepo[repo];
            const isOpen = expandedRepo === repo;
            return (
              <div key={repo} className="explorer-repo">
                <button type="button" className="explorer-repo__head" onClick={() => handleExpand(repo)}>
                  <span className={`explorer-repo__caret${isOpen ? " is-open" : ""}`}>
                    <IconChevron />
                  </span>
                  <span className="explorer-repo__name cell-mono">{repo}</span>
                </button>
                {isOpen && (
                  <div className="explorer-tag-list">
                    {tagsLoadingRepo === repo && <div className="empty-state">Chargement des tags…</div>}
                    {tags && tags.length === 0 && <div className="empty-state">Aucun tag trouvé.</div>}
                    {tags?.map((tag) => {
                      const reference = `${repo}:${tag}`;
                      return (
                        <div key={tag} className="explorer-tag-row">
                          <span className="cell-mono">{tag}</span>
                          {canOperate(session) && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={pullStatus === "pulling" && pullingRef === reference}
                              onClick={() => handlePull(reference)}
                            >
                              {pullStatus === "pulling" && pullingRef === reference ? "Pull en cours…" : "Pull"}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
