import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  markDockerSkipped,
  markKubernetesSkipped,
  markNutanixSkipped,
  testDocker,
  testKubernetes,
  testNutanix,
  updateKubeconfig,
  updateNutanixForm,
} from "@/features/setup/setupSlice";
import StatusPill from "@/components/StatusPill";

export default function OrchestratorsStep() {
  const dispatch = useAppDispatch();
  const docker = useAppSelector((s) => s.setup.docker);
  const kubernetes = useAppSelector((s) => s.setup.kubernetes);
  const nutanix = useAppSelector((s) => s.setup.nutanix);

  return (
    <div>
      <div className="setup-step-title">Orchestrateurs</div>
      <p className="setup-step-subtitle">
        Étape facultative — chaque orchestrateur peut être configuré maintenant ou plus tard.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
        <div className="setup-block">
          <div className="setup-block__head">
            <span className="setup-block__title">Docker / Swarm</span>
            {docker.test === "ok" && <StatusPill status="connected" label="Connecté" />}
            {docker.test === "error" && <StatusPill status="error" />}
            {docker.test === "skipped" && <StatusPill status="unconfigured" label="Configuré plus tard" />}
            {docker.test === "idle" && <StatusPill status="unconfigured" label="Non testé" />}
          </div>
          <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
            Détection automatique du socket Docker de l'hôte.
          </p>
          <div className="setup-block__actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={docker.test === "testing"}
              onClick={() => dispatch(testDocker())}
            >
              {docker.test === "testing" ? "Test en cours…" : "Tester"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => dispatch(markDockerSkipped())}>
              Configurer plus tard
            </button>
          </div>
          {docker.test === "error" && docker.message && <div className="error-banner">{docker.message}</div>}
          {docker.test === "ok" && (
            <div className="setup-success-banner">{docker.message ?? "Socket Docker joignable."}</div>
          )}
        </div>

        <div className="setup-block">
          <div className="setup-block__head">
            <span className="setup-block__title">Kubernetes</span>
            {kubernetes.test === "ok" && <StatusPill status="connected" label="Connecté" />}
            {kubernetes.test === "error" && <StatusPill status="error" />}
            {kubernetes.test === "skipped" && (
              <StatusPill status="unconfigured" label="Configuré plus tard" />
            )}
            {kubernetes.test === "idle" && <StatusPill status="unconfigured" label="Non testé" />}
          </div>
          <div className="field">
            <label htmlFor="kubeconfig">Kubeconfig</label>
            <textarea
              id="kubeconfig"
              className="kubeconfig-input"
              value={kubernetes.kubeconfig}
              onChange={(e) => dispatch(updateKubeconfig(e.target.value))}
              placeholder="apiVersion: v1&#10;kind: Config&#10;..."
              spellCheck={false}
            />
          </div>
          <div className="setup-block__actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={kubernetes.kubeconfig.trim() === "" || kubernetes.test === "testing"}
              onClick={() => dispatch(testKubernetes())}
            >
              {kubernetes.test === "testing" ? "Test en cours…" : "Tester"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => dispatch(markKubernetesSkipped())}
            >
              Configurer plus tard
            </button>
          </div>
          {kubernetes.test === "error" && kubernetes.message && (
            <div className="error-banner">{kubernetes.message}</div>
          )}
          {kubernetes.test === "ok" && (
            <div className="setup-success-banner">
              {kubernetes.message ?? "Cluster Kubernetes joignable."}
              {kubernetes.context && ` — contexte ${kubernetes.context}`}
              {kubernetes.nodeCount !== null && ` — ${kubernetes.nodeCount} nœud(s)`}
            </div>
          )}
        </div>

        <div className="setup-block">
          <div className="setup-block__head">
            <span className="setup-block__title">Nutanix</span>
            {nutanix.test === "ok" && <StatusPill status="connected" label="Connecté" />}
            {nutanix.test === "error" && <StatusPill status="error" />}
            {nutanix.test === "skipped" && <StatusPill status="unconfigured" label="Configuré plus tard" />}
            {nutanix.test === "idle" && <StatusPill status="unconfigured" label="Non testé" />}
          </div>
          <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
            Connexion à Prism Central (API REST v3) pour lister et gérer les VMs du cluster.
          </p>
          <div className="setup-form-grid" style={{ marginTop: 8 }}>
            <div className="field">
              <label htmlFor="nutanix-url">URL de Prism Central</label>
              <input
                id="nutanix-url"
                value={nutanix.prismCentralUrl}
                onChange={(e) => dispatch(updateNutanixForm({ prismCentralUrl: e.target.value }))}
                placeholder="https://prism.lecreusot.fr:9440"
              />
            </div>
            <div className="field">
              <label htmlFor="nutanix-username">Utilisateur</label>
              <input
                id="nutanix-username"
                value={nutanix.username}
                onChange={(e) => dispatch(updateNutanixForm({ username: e.target.value }))}
                placeholder="admin"
              />
            </div>
            <div className="field">
              <label htmlFor="nutanix-password">Mot de passe</label>
              <input
                id="nutanix-password"
                type="password"
                value={nutanix.password}
                onChange={(e) => dispatch(updateNutanixForm({ password: e.target.value }))}
              />
            </div>
          </div>
          <div className="setup-block__actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={
                nutanix.prismCentralUrl.trim() === "" ||
                nutanix.username.trim() === "" ||
                nutanix.password.trim() === "" ||
                nutanix.test === "testing"
              }
              onClick={() => dispatch(testNutanix())}
            >
              {nutanix.test === "testing" ? "Test en cours…" : "Tester"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => dispatch(markNutanixSkipped())}>
              Configurer plus tard
            </button>
          </div>
          {nutanix.test === "error" && nutanix.message && <div className="error-banner">{nutanix.message}</div>}
          {nutanix.test === "ok" && (
            <div className="setup-success-banner">
              {nutanix.message ?? "Prism Central joignable."}
              {nutanix.vmCount !== null && ` — ${nutanix.vmCount} VM(s)`}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
