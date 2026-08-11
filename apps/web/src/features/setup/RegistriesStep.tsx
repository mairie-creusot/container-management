import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  addRegistryDraft,
  markRegistrySkipped,
  removeRegistryDraft,
  testRegistry,
  updateRegistryDraft,
} from "@/features/setup/setupSlice";
import StatusPill from "@/components/StatusPill";
import { IconPlus } from "@/components/icons";
import type { RegistryKind } from "@/types";

const KINDS: { id: RegistryKind; label: string }[] = [
  { id: "dockerhub", label: "Docker Hub" },
  { id: "ghcr", label: "GHCR" },
  { id: "gitlab", label: "GitLab Registry" },
  { id: "harbor", label: "Harbor" },
];

export default function RegistriesStep() {
  const dispatch = useAppDispatch();
  const registries = useAppSelector((s) => s.setup.registries);

  return (
    <div>
      <div className="setup-step-title">Registries</div>
      <p className="setup-step-subtitle">
        Étape facultative — ajoutez un ou plusieurs registries maintenant, ou laissez cette étape
        vide pour les configurer plus tard depuis l'écran Registries.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
        {registries.map((draft) => (
          <div className="registry-draft" key={draft.tempId}>
            <div className="registry-draft__grid">
              <div className="field field--sm">
                <label htmlFor={`reg-kind-${draft.tempId}`}>Registry</label>
                <select
                  id={`reg-kind-${draft.tempId}`}
                  value={draft.kind}
                  onChange={(e) =>
                    dispatch(updateRegistryDraft({ tempId: draft.tempId, kind: e.target.value as RegistryKind }))
                  }
                >
                  {KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field field--sm">
                <label htmlFor={`reg-name-${draft.tempId}`}>Nom</label>
                <input
                  id={`reg-name-${draft.tempId}`}
                  value={draft.name}
                  placeholder="ex : GHCR mairie"
                  onChange={(e) => dispatch(updateRegistryDraft({ tempId: draft.tempId, name: e.target.value }))}
                />
              </div>
              <div className="field field--sm">
                <label htmlFor={`reg-url-${draft.tempId}`}>URL</label>
                <input
                  id={`reg-url-${draft.tempId}`}
                  value={draft.url}
                  placeholder="https://registry.example.org"
                  onChange={(e) => dispatch(updateRegistryDraft({ tempId: draft.tempId, url: e.target.value }))}
                />
              </div>
            </div>

            <div className="registry-draft__credentials">
              <div className="field field--sm">
                <label htmlFor={`reg-user-${draft.tempId}`}>Identifiant (optionnel)</label>
                <input
                  id={`reg-user-${draft.tempId}`}
                  value={draft.username}
                  onChange={(e) =>
                    dispatch(updateRegistryDraft({ tempId: draft.tempId, username: e.target.value }))
                  }
                />
              </div>
              <div className="field field--sm">
                <label htmlFor={`reg-pass-${draft.tempId}`}>Mot de passe (optionnel)</label>
                <input
                  id={`reg-pass-${draft.tempId}`}
                  value={draft.password}
                  type="password"
                  onChange={(e) =>
                    dispatch(updateRegistryDraft({ tempId: draft.tempId, password: e.target.value }))
                  }
                />
              </div>
              <div className="field field--sm">
                <label htmlFor={`reg-token-${draft.tempId}`}>Jeton (optionnel)</label>
                <input
                  id={`reg-token-${draft.tempId}`}
                  value={draft.token}
                  type="password"
                  onChange={(e) => dispatch(updateRegistryDraft({ tempId: draft.tempId, token: e.target.value }))}
                />
              </div>
            </div>

            <div className="registry-draft__foot">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={draft.name.trim() === "" || draft.url.trim() === "" || draft.test === "testing"}
                onClick={() => dispatch(testRegistry(draft.tempId))}
              >
                {draft.test === "testing" ? "Test en cours…" : "Tester"}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => dispatch(markRegistrySkipped(draft.tempId))}
              >
                Configurer plus tard
              </button>
              <span className="setup-footer__spacer" />
              {draft.test === "ok" && <StatusPill status="connected" label="Validé" />}
              {draft.test === "error" && <StatusPill status="error" />}
              {draft.test === "skipped" && <StatusPill status="unconfigured" label="Configuré plus tard" />}
              {draft.test === "idle" && <StatusPill status="unconfigured" label="Non testé" />}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => dispatch(removeRegistryDraft(draft.tempId))}
              >
                Retirer
              </button>
            </div>

            {draft.test === "error" && draft.message && <div className="error-banner">{draft.message}</div>}
          </div>
        ))}

        {registries.length === 0 && (
          <div className="empty-state">Aucun registry ajouté pour l'instant.</div>
        )}

        <button
          type="button"
          className="btn btn-ghost"
          style={{ alignSelf: "flex-start" }}
          onClick={() => dispatch(addRegistryDraft())}
        >
          <IconPlus /> Ajouter un registry
        </button>
      </div>
    </div>
  );
}
