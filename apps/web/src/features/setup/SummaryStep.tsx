import { useAppDispatch, useAppSelector } from "@/hooks";
import { completeSetup, type TestStatus } from "@/features/setup/setupSlice";
import StatusPill from "@/components/StatusPill";

function TestStatusPill({ test }: { test: TestStatus }) {
  switch (test) {
    case "ok":
      return <StatusPill status="connected" label="Validé" />;
    case "error":
      return <StatusPill status="error" />;
    case "skipped":
      return <StatusPill status="unconfigured" label="Configuré plus tard" />;
    case "testing":
      return <StatusPill status="update" label="Test en cours…" />;
    default:
      return <StatusPill status="unconfigured" label="Non configuré" />;
  }
}

export default function SummaryStep() {
  const dispatch = useAppDispatch();
  const { ldap, docker, kubernetes, registries, completeStatus, completeError } = useAppSelector(
    (s) => s.setup,
  );

  return (
    <div>
      <div className="setup-step-title">Récapitulatif</div>
      <p className="setup-step-subtitle">
        Vérifiez les intégrations avant de finaliser. Les blocs facultatifs non configurés
        pourront l'être plus tard depuis l'application.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
        <div className="summary-row">
          <div>
            <div className="summary-row__label">Annuaire LDAP</div>
            <div className="summary-row__hint">{ldap.url || "—"}</div>
          </div>
          <TestStatusPill test={ldap.test} />
        </div>

        <div className="summary-row">
          <div>
            <div className="summary-row__label">Docker / Swarm</div>
            <div className="summary-row__hint">{docker.version ?? "Socket local"}</div>
          </div>
          <TestStatusPill test={docker.test} />
        </div>

        <div className="summary-row">
          <div>
            <div className="summary-row__label">Kubernetes</div>
            <div className="summary-row__hint">{kubernetes.context ?? "Kubeconfig"}</div>
          </div>
          <TestStatusPill test={kubernetes.test} />
        </div>

        {registries.length === 0 && (
          <div className="summary-row">
            <div>
              <div className="summary-row__label">Registries</div>
              <div className="summary-row__hint">Aucun registry ajouté</div>
            </div>
            <StatusPill status="unconfigured" label="Non configuré" />
          </div>
        )}

        {registries.map((draft) => (
          <div className="summary-row" key={draft.tempId}>
            <div>
              <div className="summary-row__label">{draft.name || draft.url || "Registry"}</div>
              <div className="summary-row__hint">{draft.kind}</div>
            </div>
            <TestStatusPill test={draft.test} />
          </div>
        ))}
      </div>

      {completeError && <div className="error-banner" style={{ marginTop: 16 }}>{completeError}</div>}

      <button
        type="button"
        className="btn btn-primary"
        style={{ marginTop: 18 }}
        disabled={ldap.test !== "ok" || completeStatus === "submitting"}
        onClick={() => dispatch(completeSetup())}
      >
        {completeStatus === "submitting" ? "Finalisation…" : "Terminer la configuration"}
      </button>
    </div>
  );
}
