import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  disableNutanix,
  fetchEnvironmentNodes,
  fetchEnvironments,
  fetchNutanixConfig,
  fetchNutanixVms,
  saveNutanixConfig,
  selectNode,
  selectVm,
  toggleEnvironmentExpanded,
  type NutanixConfigFormInput,
} from "@/features/clusters/clustersSlice";
import {
  createRemoteEnvironment,
  deleteRemoteEnvironment,
  fetchRemoteEnvironments,
  testRemoteEnvironment,
} from "@/features/remoteEnvironments/remoteEnvironmentsSlice";
import { canAdminister } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import Inspector from "@/components/Inspector";
import StatusPill from "@/components/StatusPill";
import Gauge from "@/components/Gauge";
import KeyValueList from "@/components/KeyValueList";
import { IconChevron, IconPlus, IconTrash, IconVm } from "@/components/icons";
import type { NutanixVm } from "@/types";

const EMPTY_NUTANIX_FORM: NutanixConfigFormInput = { prismCentralUrl: "", username: "", password: "" };

/**
 * Section "Nutanix" de la page Environnements — configure/modifie Prism Central EN DEHORS de
 * l'assistant de premier lancement (routes/nutanix.ts). Avant ce composant, la SEULE façon
 * d'ajouter Nutanix était l'étape "Orchestrateurs" de l'assistant, invisible/inaccessible une
 * fois celui-ci terminé sans repasser par POST /api/setup/reset (qui rouvre TOUT l'assistant,
 * LDAP compris) — trou constaté par un utilisateur réel qui avait déjà terminé sa configuration
 * initiale sans Nutanix. Même structure que la section "Environnements Docker distants"
 * juste au-dessus (formulaire replié par défaut, révélé par un bouton).
 */
function NutanixConfigSection() {
  const dispatch = useAppDispatch();
  const { nutanixConfigured, nutanixConfig, nutanixConfigStatus, nutanixConfigSaving, nutanixConfigError } =
    useAppSelector((s) => s.clusters);
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);
  const confirm = useConfirm();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<NutanixConfigFormInput>(EMPTY_NUTANIX_FORM);

  useEffect(() => {
    if (nutanixConfigStatus === "idle") dispatch(fetchNutanixConfig());
  }, [dispatch, nutanixConfigStatus]);

  useEffect(() => {
    if (nutanixConfig) setForm({ ...nutanixConfig, password: "" });
  }, [nutanixConfig]);

  function openForm() {
    setEditing(true);
  }

  function closeForm() {
    setEditing(false);
    setForm(nutanixConfig ? { ...nutanixConfig, password: "" } : EMPTY_NUTANIX_FORM);
  }

  function isFormValid(): boolean {
    const hasPassword = !!form.password?.trim() || nutanixConfigured;
    return !!(form.prismCentralUrl.trim() && form.username.trim() && hasPassword);
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!isFormValid()) return;
    const result = await dispatch(
      saveNutanixConfig({
        prismCentralUrl: form.prismCentralUrl.trim(),
        username: form.username.trim(),
        ...(form.password?.trim() ? { password: form.password.trim() } : {}),
      }),
    );
    if (saveNutanixConfig.fulfilled.match(result)) setEditing(false);
  }

  async function handleDisable() {
    const ok = await confirm({
      title: "Retirer la configuration Nutanix ?",
      description: "Les VMs/clusters Nutanix disparaîtront du graphe de topologie et de cette page.",
      confirmLabel: "Retirer",
      variant: "danger",
    });
    if (!ok) return;
    await dispatch(disableNutanix());
    setForm(EMPTY_NUTANIX_FORM);
  }

  const showForm = editing || !nutanixConfigured;

  return (
    <>
      <div className="page-header" style={{ marginTop: 0 }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>Nutanix</h3>
          <p>
            Prism Central (API v3) — VMs et clusters physiques réels, visibles dans cette page et dans le
            graphe de topologie une fois configuré. Jamais de VM/cluster fabriqué si injoignable ou non
            configuré.
          </p>
        </div>
        {admin && nutanixConfigured && !editing && (
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={openForm}>
              Modifier
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleDisable}>
              Retirer
            </button>
          </div>
        )}
      </div>

      {nutanixConfigError && <div className="error-banner" style={{ marginBottom: 16 }}>{nutanixConfigError}</div>}

      {nutanixConfigStatus !== "loading" && nutanixConfigured && !editing && nutanixConfig && (
        <div className="card" style={{ marginBottom: 24, display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="chip-row">
            <span className="topology-detail-panel__icon topology-detail-panel__icon--nutanix-vm" style={{ display: "inline-flex" }}>
              <IconVm />
            </span>
            <StatusPill status="ok" label="Configuré" />
          </div>
          <KeyValueList
            rows={[
              { key: "URL Prism Central", value: nutanixConfig.prismCentralUrl },
              { key: "Utilisateur", value: nutanixConfig.username },
            ]}
          />
        </div>
      )}

      {nutanixConfigStatus !== "loading" && !nutanixConfigured && !showForm && (
        <div className="empty-state" style={{ marginBottom: 16 }}>Nutanix non configuré.</div>
      )}

      {admin && showForm && (
        <form className="card" style={{ marginBottom: 24, display: "flex", flexDirection: "column", gap: 12 }} onSubmit={handleSave}>
          <div className="field">
            <label htmlFor="nutanix-url">URL Prism Central</label>
            <input
              id="nutanix-url"
              value={form.prismCentralUrl}
              onChange={(event) => setForm((f) => ({ ...f, prismCentralUrl: event.target.value }))}
              placeholder="https://prism.lecreusot.fr:9440"
              disabled={nutanixConfigSaving}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="nutanix-username">Utilisateur</label>
            <input
              id="nutanix-username"
              value={form.username}
              onChange={(event) => setForm((f) => ({ ...f, username: event.target.value }))}
              disabled={nutanixConfigSaving}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="nutanix-password">
              Mot de passe{nutanixConfigured ? " (laisser vide pour conserver l'existant)" : ""}
            </label>
            <input
              id="nutanix-password"
              type="password"
              value={form.password ?? ""}
              onChange={(event) => setForm((f) => ({ ...f, password: event.target.value }))}
              autoComplete="new-password"
              disabled={nutanixConfigSaving}
              {...(nutanixConfigured ? {} : { required: true })}
            />
          </div>
          <p style={{ margin: 0, fontSize: "0.85em", opacity: 0.75 }}>
            La connexion à Prism Central est réellement testée avant l'enregistrement — jamais persisté à
            l'aveugle.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={nutanixConfigSaving || !isFormValid()}>
              {nutanixConfigSaving ? "Test et enregistrement…" : "Enregistrer"}
            </button>
            {nutanixConfigured && (
              <button type="button" className="btn btn-ghost" onClick={closeForm}>
                Annuler
              </button>
            )}
          </div>
        </form>
      )}

      {!admin && !nutanixConfigured && (
        <div className="empty-state" style={{ marginBottom: 24 }}>
          Seul un administrateur peut configurer Nutanix.
        </div>
      )}
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 Mo";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb < 1) return `${(bytes / (1024 * 1024)).toFixed(0)} Mo`;
  return `${gb.toFixed(1)} Go`;
}

/** VM Nutanix -> props StatusPill — pas d'entrée "unknown" dans STATUS_MAP (voir StatusPill.tsx),
 * label explicite dans ce cas plutôt que d'afficher le mot anglais brut. */
function vmStatusProps(powerState: NutanixVm["powerState"]): { status: string; label?: string } {
  if (powerState === "on") return { status: "running" };
  if (powerState === "off") return { status: "stopped" };
  return { status: "neutral", label: "Indéterminé" };
}

export default function EnvironmentsPage() {
  const dispatch = useAppDispatch();
  const {
    environments,
    status,
    error,
    expandedIds,
    nodesStatusByEnv,
    selectedNodeId,
    nutanixVms,
    nutanixVmsStatus,
    selectedVmId,
  } = useAppSelector((s) => s.clusters);
  const searchQuery = useAppSelector((s) => s.ui.searchQuery);

  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);
  const confirm = useConfirm();
  const {
    items: remoteEnvironments,
    status: remoteStatus,
    creating: creatingRemote,
    error: remoteError,
    testResultById,
    testingId,
  } = useAppSelector((s) => s.remoteEnvironments);
  const [showRemoteForm, setShowRemoteForm] = useState(false);
  const [remoteForm, setRemoteForm] = useState({ name: "", host: "", port: "2376" });
  const [remoteCreateError, setRemoteCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "idle") dispatch(fetchEnvironments());
  }, [dispatch, status]);

  useEffect(() => {
    if (remoteStatus === "idle") dispatch(fetchRemoteEnvironments());
  }, [dispatch, remoteStatus]);

  function handleCreateRemote(event: FormEvent) {
    event.preventDefault();
    const name = remoteForm.name.trim();
    const host = remoteForm.host.trim();
    const port = Number(remoteForm.port);
    if (!name || !host || !Number.isInteger(port) || port < 1 || port > 65535) return;
    setRemoteCreateError(null);
    dispatch(createRemoteEnvironment({ name, host, port })).then((action) => {
      if (createRemoteEnvironment.fulfilled.match(action)) {
        setShowRemoteForm(false);
        setRemoteForm({ name: "", host: "", port: "2376" });
        // Cet environnement devient sélectionnable dans le sélecteur du Topbar dès le prochain
        // rechargement de GET /api/environments (voir services/environments.ts#getRemoteDockerEnvironments).
        dispatch(fetchEnvironments());
      } else {
        setRemoteCreateError(action.payload ?? "Impossible de créer cet environnement.");
      }
    });
  }

  async function handleDeleteRemote(id: string, name: string) {
    const ok = await confirm({
      title: "Supprimer cet environnement Docker distant",
      description: `Confirmer la suppression de "${name}" ? QUAI ne pourra plus interroger ce démon Docker distant.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    dispatch(deleteRemoteEnvironment(id)).then(() => dispatch(fetchEnvironments()));
  }

  function handleToggle(environmentId: string) {
    const willExpand = !expandedIds.includes(environmentId);
    dispatch(toggleEnvironmentExpanded(environmentId));
    if (!willExpand) return;
    if (nodesStatusByEnv[environmentId] !== "ready") {
      dispatch(fetchEnvironmentNodes(environmentId));
    }
    // Détail par VM (GET /api/nutanix/vms) : uniquement pour l'environnement Nutanix, chargé une
    // seule fois (comme les nœuds ci-dessus) — voir clustersSlice.ts#fetchNutanixVms.
    const env = environments.find((e) => e.id === environmentId);
    if (env?.orchestrator === "nutanix" && nutanixVmsStatus !== "ready") {
      dispatch(fetchNutanixVms());
    }
  }

  const visible = environments.filter(
    (env) => !searchQuery || env.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const selectedNode = environments
    .flatMap((env) => env.nodes)
    .find((node) => node.id === selectedNodeId) ?? null;
  const selectedNodeEnv = selectedNode
    ? environments.find((env) => env.id === selectedNode.environmentId)
    : null;
  const selectedVm = nutanixVms.find((vm) => vm.id === selectedVmId) ?? null;

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Environnements</h2>
            <p>Environnements Swarm, Kubernetes, Compose, Nutanix et LXC (LXD), et leurs nœuds (VMs pour Nutanix).</p>
          </div>
        </div>

        <NutanixConfigSection />

        <div className="page-header" style={{ marginTop: 0 }}>
          <div>
            <h3 style={{ marginBottom: 4 }}>Environnements Docker distants</h3>
            <p>
              Démons Docker distants (TCP+TLS) interrogeables séparément du démon local — sélectionnables
              depuis le menu d'environnement du Topbar. Câblé bout-en-bout pour les conteneurs, volumes et
              networks (voir ARCHITECTURE.md) ; les actions d'écriture restent réservées au démon local.
            </p>
          </div>
          {admin && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setShowRemoteForm((open) => !open)}
            >
              <IconPlus /> {showRemoteForm ? "Annuler" : "Nouvel environnement"}
            </button>
          )}
        </div>

        {showRemoteForm && admin && (
          <form
            className="card"
            style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 12 }}
            onSubmit={handleCreateRemote}
          >
            <div className="field">
              <label htmlFor="remote-env-name">Nom</label>
              <input
                id="remote-env-name"
                value={remoteForm.name}
                onChange={(event) => setRemoteForm((f) => ({ ...f, name: event.target.value }))}
                placeholder="ex : Datacenter secours"
                disabled={creatingRemote}
                autoFocus
                required
              />
            </div>
            <div className="field">
              <label htmlFor="remote-env-host">Hôte</label>
              <input
                id="remote-env-host"
                value={remoteForm.host}
                onChange={(event) => setRemoteForm((f) => ({ ...f, host: event.target.value }))}
                placeholder="ex : docker-secours.lecreusot.priv"
                disabled={creatingRemote}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="remote-env-port">Port</label>
              <input
                id="remote-env-port"
                type="number"
                min={1}
                max={65535}
                value={remoteForm.port}
                onChange={(event) => setRemoteForm((f) => ({ ...f, port: event.target.value }))}
                disabled={creatingRemote}
                required
              />
            </div>
            <p style={{ margin: 0, fontSize: "0.85em", opacity: 0.75 }}>
              Le certificat TLS (ca/cert/key) se configure via l'API (PATCH /api/remote-environments/:id) —
              non exposé dans ce formulaire minimal.
            </p>
            {remoteCreateError && <p className="graph-popover__error">{remoteCreateError}</p>}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={creatingRemote || !remoteForm.name.trim() || !remoteForm.host.trim()}
              >
                {creatingRemote ? "Création…" : "Créer"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setShowRemoteForm(false)}>
                Annuler
              </button>
            </div>
          </form>
        )}

        {remoteError && <div className="error-banner">{remoteError}</div>}
        {remoteStatus !== "loading" && remoteEnvironments.length === 0 && (
          <div className="empty-state" style={{ marginBottom: 16 }}>
            Aucun environnement Docker distant configuré.
          </div>
        )}
        {remoteEnvironments.length > 0 && (
          <div className="data-table-wrap" style={{ marginBottom: 24 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th>Hôte</th>
                  <th>Port</th>
                  <th>TLS</th>
                  <th>Test</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {remoteEnvironments.map((env) => {
                  const testResult = testResultById[env.id];
                  return (
                    <tr key={env.id}>
                      <td className="cell-primary">{env.name}</td>
                      <td className="cell-mono">{env.host}</td>
                      <td className="cell-mono">{env.port}</td>
                      <td>{env.hasTls ? "Oui" : "Non"}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={testingId === env.id}
                          onClick={() => dispatch(testRemoteEnvironment(env.id))}
                        >
                          {testingId === env.id ? "Test…" : "Tester"}
                        </button>
                        {testResult && (
                          <span style={{ marginLeft: 8, color: testResult.ok ? "var(--success, #2e7d32)" : "var(--danger, #c62828)" }}>
                            {testResult.ok ? "OK" : testResult.message}
                          </span>
                        )}
                      </td>
                      <td className="cell-actions">
                        {admin && (
                          <button
                            type="button"
                            className="icon-btn icon-btn--danger"
                            title="Supprimer"
                            aria-label="Supprimer"
                            onClick={() => handleDeleteRemote(env.id, env.name)}
                          >
                            <IconTrash />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}
        {status === "loading" && environments.length === 0 && (
          <div className="empty-state">Chargement…</div>
        )}
        {status !== "loading" && visible.length === 0 && !error && (
          <div className="empty-state">Aucun environnement configuré.</div>
        )}

        <div className="env-tree">
          {visible.map((env) => {
            const isOpen = expandedIds.includes(env.id);
            const nodesStatus = nodesStatusByEnv[env.id] ?? "idle";
            return (
              <div className="env-node" key={env.id}>
                <button type="button" className="env-node__head" onClick={() => handleToggle(env.id)}>
                  <span className={`env-node__caret${isOpen ? " is-open" : ""}`}>
                    <IconChevron />
                  </span>
                  <span className="env-node__name">{env.name}</span>
                  <span className="env-node__orchestrator">{env.orchestrator}</span>
                  <StatusPill status={env.status} />
                </button>

                {env.hostInfo && (
                  <div className="env-node__hostinfo">
                    <span className="env-node__hostinfo-item">
                      <strong>{env.hostInfo.serverVersion}</strong> Docker Engine
                    </span>
                    <span className="env-node__hostinfo-item cell-mono">{env.hostInfo.endpoint}</span>
                    <span className="env-node__hostinfo-sep" />
                    <span className="env-node__hostinfo-item">
                      <strong>{env.hostInfo.containersRunning}</strong> actif(s)
                    </span>
                    <span className="env-node__hostinfo-item">
                      <strong>{env.hostInfo.containersStopped}</strong> arrêté(s)
                    </span>
                    <span className="env-node__hostinfo-item">
                      <strong>{env.hostInfo.imagesCount}</strong> image(s)
                    </span>
                    <span className="env-node__hostinfo-item">
                      <strong>{env.hostInfo.volumesCount}</strong> volume(s)
                    </span>
                    <span className="env-node__hostinfo-item">
                      <strong>{env.hostInfo.cpus}</strong> CPU
                    </span>
                    <span className="env-node__hostinfo-item">
                      <strong>{formatBytes(env.hostInfo.totalMemBytes)}</strong> RAM
                    </span>
                    <span className="env-node__hostinfo-item">{env.hostInfo.os} · {env.hostInfo.architecture}</span>
                  </div>
                )}

                {isOpen && (
                  <div className="node-list">
                    {nodesStatus === "loading" && env.nodes.length === 0 && (
                      <div className="empty-state">Chargement des nœuds…</div>
                    )}
                    {env.nodes.map((node) => (
                      <button
                        key={node.id}
                        type="button"
                        className={`node-row${node.id === selectedNodeId ? " is-selected" : ""}`}
                        onClick={() => dispatch(selectNode(node.id))}
                      >
                        <span className="node-row__name">{node.id}</span>
                        <span className="node-row__role">{node.role}</span>
                        <span className="cell-mono">{node.containerCount} conteneur(s)</span>
                        <StatusPill status={node.status} />
                      </button>
                    ))}
                    {nodesStatus !== "loading" && env.nodes.length === 0 && (
                      <div className="empty-state">Aucun nœud.</div>
                    )}
                  </div>
                )}

                {isOpen && env.orchestrator === "nutanix" && (
                  <div className="node-list">
                    <div className="node-list-label">VMs</div>
                    {nutanixVmsStatus === "loading" && nutanixVms.length === 0 && (
                      <div className="empty-state">Chargement des VMs…</div>
                    )}
                    {nutanixVms.map((vm) => (
                      <button
                        key={vm.id}
                        type="button"
                        className={`node-row${vm.id === selectedVmId ? " is-selected" : ""}`}
                        onClick={() => dispatch(selectVm(vm.id))}
                      >
                        <span className="node-row__name">{vm.name}</span>
                        <span className="node-row__role">{vm.cluster}</span>
                        <span className="cell-mono">
                          {vm.numVcpus} vCPU · {formatBytes(vm.memoryMib * 1024 * 1024)}
                        </span>
                        <StatusPill {...vmStatusProps(vm.powerState)} />
                      </button>
                    ))}
                    {nutanixVmsStatus !== "loading" && nutanixVms.length === 0 && (
                      <div className="empty-state">Aucune VM.</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <Inspector
        title={selectedVm ? selectedVm.name : selectedNode?.id}
        subtitle={
          selectedVm
            ? `VM Nutanix · ${selectedVm.cluster}`
            : selectedNodeEnv
              ? `${selectedNodeEnv.name} · ${selectedNode?.role}`
              : undefined
        }
        onClose={() => {
          dispatch(selectNode(null));
          dispatch(selectVm(null));
        }}
      >
        {selectedVm && (
          <>
            <StatusPill {...vmStatusProps(selectedVm.powerState)} />
            <KeyValueList
              rows={[
                { key: "Cluster", value: selectedVm.cluster },
                { key: "vCPUs", value: String(selectedVm.numVcpus) },
                { key: "Mémoire", value: formatBytes(selectedVm.memoryMib * 1024 * 1024) },
              ]}
            />
          </>
        )}
        {!selectedVm && selectedNode && (
          <>
            <StatusPill status={selectedNode.status} />
            <Gauge label="CPU" percent={selectedNode.cpuPercent} />
            <Gauge label="Mémoire" percent={selectedNode.memPercent} />
            <KeyValueList
              rows={[
                { key: "Rôle", value: selectedNode.role },
                { key: "Conteneurs", value: String(selectedNode.containerCount) },
              ]}
            />
          </>
        )}
      </Inspector>
    </div>
  );
}
