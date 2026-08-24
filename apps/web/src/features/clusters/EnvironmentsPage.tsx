import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  fetchEnvironmentNodes,
  fetchEnvironments,
  fetchNutanixConfig,
  fetchNutanixVms,
  selectNode,
  selectVm,
  toggleEnvironmentExpanded,
} from "@/features/clusters/clustersSlice";
import {
  deleteRemoteEnvironment,
  fetchRemoteEnvironments,
  testRemoteEnvironment,
  updateRemoteEnvironment,
} from "@/features/remoteEnvironments/remoteEnvironmentsSlice";
// Modale de CRÉATION extraite en composant réutilisable (Phase 2, 17/08/2026) — une seule source
// de vérité, montée ici ET depuis le graphe de topologie ("Ajouter un environnement…", voir
// TopologyGraph.tsx#CreateSpotlight). Les helpers TLS/SSH partagés avec la modale d'ÉDITION
// ci-dessous (restée dans cette page, seule à en avoir besoin) sont importés de là.
import RemoteEnvironmentCreateModal, {
  EMPTY_SSH_FORM,
  EMPTY_TLS_FORM,
  isSshFormValid,
  isTlsFormValid,
  type RemoteSshFormState,
  type RemoteTlsFormState,
} from "@/features/remoteEnvironments/RemoteEnvironmentCreateModal";
import { canAdminister } from "@/features/auth/authSlice";
import { openSettingsSection } from "@/features/ui/uiSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import Inspector from "@/components/Inspector";
import Modal from "@/components/Modal";
import StatusPill from "@/components/StatusPill";
import Gauge from "@/components/Gauge";
import KeyValueList from "@/components/KeyValueList";
import { IconChevron, IconInfo, IconPlus, IconSettings, IconTrash } from "@/components/icons";
import type { NutanixVm, RemoteDockerEnvironmentRef, RemoteDockerTransport } from "@/types";

// Helpers TLS/SSH (RemoteTlsFormState/EMPTY_TLS_FORM/isTlsFormValid, RemoteSshFormState/
// EMPTY_SSH_FORM/isSshFormValid) : déplacés dans RemoteEnvironmentCreateModal.tsx avec la modale
// de création (voir l'import en tête de fichier) — la modale d'ÉDITION ci-dessous les consomme
// depuis là, jamais une seconde copie qui pourrait diverger.

// Configuration Nutanix (Prism Central) : le formulaire a quitté cette page le 24/08/2026 pour la
// page Réglages (features/clusters/NutanixConfigSection.tsx), SEULE source de vérité — cette page
// n'affiche plus que les environnements réels, et un renvoi vers le réglage quand rien n'est
// configuré.

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
    nutanixConfigured,
    nutanixConfigStatus,
  } = useAppSelector((s) => s.clusters);
  const searchQuery = useAppSelector((s) => s.ui.searchQuery);

  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);
  const confirm = useConfirm();
  const {
    items: remoteEnvironments,
    status: remoteStatus,
    error: remoteError,
    testResultById,
    testingId,
  } = useAppSelector((s) => s.remoteEnvironments);
  // Modale de CRÉATION extraite (RemoteEnvironmentCreateModal.tsx — voir l'import en tête de
  // fichier) : cette page ne garde que l'état d'ouverture, tout le formulaire vit dans la modale.
  const [showRemoteForm, setShowRemoteForm] = useState(false);

  // Édition d'un environnement Docker distant déjà persisté — modale séparée (voir Modal
  // "remote-env-edit-title" plus bas), même pattern que RegistriesPage.tsx#openEdit. `null` =
  // fermée. TLS/SSH jamais préchargés (write-only, voir remoteDockerStore.ts#toRef) : laisser les
  // champs vides conserve les identifiants existants tels quels côté PATCH.
  const [editingRemote, setEditingRemote] = useState<RemoteDockerEnvironmentRef | null>(null);
  const [editRemoteForm, setEditRemoteForm] = useState({ name: "", host: "", port: "" });
  const [editRemoteTransport, setEditRemoteTransport] = useState<RemoteDockerTransport>("tcp-tls");
  const [editRemoteTlsForm, setEditRemoteTlsForm] = useState<RemoteTlsFormState>(EMPTY_TLS_FORM);
  const [editRemoteSshForm, setEditRemoteSshForm] = useState<RemoteSshFormState>(EMPTY_SSH_FORM);
  // Case "Modifier les identifiants SSH" — pendant à `editRemoteTlsForm.enabled` côté TLS, mais
  // porté séparément ici : RemoteSshFormState n'a pas de champ `enabled` propre (les identifiants
  // SSH sont TOUJOURS requis en création, jamais optionnels comme le TLS l'est).
  const [editSshChangeCreds, setEditSshChangeCreds] = useState(false);
  const [updatingRemote, setUpdatingRemote] = useState(false);
  const [remoteUpdateError, setRemoteUpdateError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "idle") dispatch(fetchEnvironments());
  }, [dispatch, status]);

  useEffect(() => {
    if (remoteStatus === "idle") dispatch(fetchRemoteEnvironments());
  }, [dispatch, remoteStatus]);

  // Lecture seule de l'état de la configuration Nutanix : elle ne se MODIFIE plus ici (Réglages),
  // mais cette page doit savoir renvoyer vers le bon réglage quand rien n'est configuré.
  useEffect(() => {
    if (nutanixConfigStatus === "idle") dispatch(fetchNutanixConfig());
  }, [dispatch, nutanixConfigStatus]);

  function openEditRemote(env: RemoteDockerEnvironmentRef) {
    setEditingRemote(env);
    setEditRemoteForm({ name: env.name, host: env.host, port: String(env.port) });
    setEditRemoteTransport(env.transport);
    setEditRemoteTlsForm(EMPTY_TLS_FORM);
    setEditRemoteSshForm({ ...EMPTY_SSH_FORM, username: env.sshUsername ?? "" });
    setEditSshChangeCreds(false);
    setRemoteUpdateError(null);
  }

  function closeEditRemote() {
    setEditingRemote(null);
    setRemoteUpdateError(null);
  }

  /** Changement de transport dans la modale d'édition : bascule immédiatement la modale sur le
   * bloc d'identifiants du nouveau transport, forcé "à modifier" — changer de transport DROPPE
   * toujours les anciens identifiants côté store (voir
   * remoteDockerStore.ts#updateRemoteDockerEnvironment), de nouveaux sont donc TOUJOURS requis
   * dans ce cas précis, contrairement à une simple modification sans changement de transport. */
  function handleEditRemoteTransportChange(next: RemoteDockerTransport) {
    setEditRemoteTransport(next);
    const changedFromOriginal = next !== editingRemote?.transport;
    setEditRemoteTlsForm({ ...EMPTY_TLS_FORM, enabled: changedFromOriginal && next === "tcp-tls" });
    setEditRemoteSshForm({
      ...EMPTY_SSH_FORM,
      username: !changedFromOriginal ? (editingRemote?.sshUsername ?? "") : "",
    });
    setEditSshChangeCreds(changedFromOriginal && next === "ssh");
  }

  async function handleUpdateRemote(event: FormEvent) {
    event.preventDefault();
    if (!editingRemote) return;
    const name = editRemoteForm.name.trim();
    const host = editRemoteForm.host.trim();
    const port = Number(editRemoteForm.port);
    if (!name || !host || !Number.isInteger(port) || port < 1 || port > 65535) return;
    const transportChanged = editRemoteTransport !== editingRemote.transport;

    let transportPatch: {
      transport?: RemoteDockerTransport;
      tls?: { ca?: string; cert?: string; key?: string };
      clearTls?: boolean;
      ssh?: { username: string; password?: string; privateKey?: string };
      clearSsh?: boolean;
    };
    if (editRemoteTransport === "ssh") {
      // Nouveaux identifiants requis si le transport change ; sinon la case "Modifier les
      // identifiants SSH" pilote.
      const mustProvideSsh = transportChanged || editSshChangeCreds;
      if (mustProvideSsh && !isSshFormValid(editRemoteSshForm)) return;
      const username = editRemoteSshForm.username.trim();
      const password = editRemoteSshForm.authMethod === "password" ? editRemoteSshForm.password.trim() : "";
      const privateKey = editRemoteSshForm.authMethod === "privateKey" ? editRemoteSshForm.privateKey.trim() : "";
      transportPatch = mustProvideSsh
        ? {
            ...(transportChanged ? { transport: "ssh" as const } : {}),
            ssh: { username, ...(password ? { password } : {}), ...(privateKey ? { privateKey } : {}) },
          }
        : {};
    } else {
      if (!isTlsFormValid(editRemoteTlsForm)) return;
      const ca = editRemoteTlsForm.ca.trim();
      const cert = editRemoteTlsForm.cert.trim();
      const key = editRemoteTlsForm.key.trim();
      const hasNewTls = ca || cert || key;
      if (transportChanged && !hasNewTls) {
        setRemoteUpdateError("Un nouveau certificat TLS (cert + clé) est requis pour passer en TCP+TLS.");
        return;
      }
      // Trois façons de traiter le TLS : case décochée et transport inchangé = TLS conservé tel
      // quel (aucun champ envoyé) ; case cochée (ou transport changé) mais tout laissé vide =
      // clearTls (repasse en TCP non chiffré) ; au moins un champ rempli = remplace ca/cert/key.
      transportPatch = {
        ...(transportChanged ? { transport: "tcp-tls" as const } : {}),
        ...(!editRemoteTlsForm.enabled && !transportChanged
          ? {}
          : hasNewTls
            ? { tls: { ...(ca ? { ca } : {}), ...(cert ? { cert } : {}), ...(key ? { key } : {}) } }
            : { clearTls: true }),
      };
    }

    setUpdatingRemote(true);
    setRemoteUpdateError(null);
    const result = await dispatch(
      updateRemoteEnvironment({ id: editingRemote.id, name, host, port, ...transportPatch }),
    );
    setUpdatingRemote(false);
    if (updateRemoteEnvironment.fulfilled.match(result)) {
      closeEditRemote();
      dispatch(fetchEnvironments());
    } else {
      setRemoteUpdateError(result.payload ?? "Impossible de modifier cet environnement.");
    }
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

        {nutanixConfigStatus !== "loading" && !nutanixConfigured && (
          <div className="empty-state" style={{ marginBottom: 24 }}>
            <IconInfo />
            <strong>Nutanix n'est pas configuré</strong>
            <span>
              Aucun cluster ni aucune VM Nutanix n'est affiché tant que Prism Central n'a pas été renseigné.
              {admin ? "" : " Seul un administrateur peut le faire."}
            </span>
            {admin && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 12 }}
                onClick={() => dispatch(openSettingsSection("nutanix"))}
              >
                Ouvrir le réglage Nutanix
              </button>
            )}
          </div>
        )}

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
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowRemoteForm(true)}>
              <IconPlus /> Nouvel environnement
            </button>
          )}
        </div>

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
                  <th>Transport</th>
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
                      <td>
                        {env.transport === "ssh"
                          ? `SSH${env.hasSshCredentials ? ` (${env.sshUsername})` : " (identifiants manquants)"}`
                          : `TCP${env.hasTls ? "+TLS" : " (non chiffré)"}`}
                      </td>
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
                          <>
                            <button
                              type="button"
                              className="icon-btn"
                              title="Modifier"
                              aria-label="Modifier"
                              onClick={() => openEditRemote(env)}
                            >
                              <IconSettings />
                            </button>
                            <button
                              type="button"
                              className="icon-btn icon-btn--danger"
                              title="Supprimer"
                              aria-label="Supprimer"
                              onClick={() => handleDeleteRemote(env.id, env.name)}
                            >
                              <IconTrash />
                            </button>
                          </>
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

      {/* Création — modale EXTRAITE en composant réutilisable (RemoteEnvironmentCreateModal.tsx,
          Phase 2 du 17/08/2026) : le bouton "Nouvel environnement" ci-dessus l'ouvre, jamais de
          logique de création sans ce flux — désormais partagée avec le graphe de topologie
          ("Ajouter un environnement…", TopologyGraph.tsx#CreateSpotlight), une seule source de
          vérité pour le formulaire complet TCP+TLS/SSH. */}
      <RemoteEnvironmentCreateModal open={showRemoteForm} onClose={() => setShowRemoteForm(false)} />

      {/* Édition — même modale/pattern, ouverte par l'icône engrenage de chaque ligne du tableau. */}
      <Modal open={editingRemote !== null} onClose={closeEditRemote} labelledBy="remote-env-edit-title">
        {editingRemote && (
          <form className="confirm-dialog" onSubmit={handleUpdateRemote}>
            <h2 id="remote-env-edit-title" className="confirm-dialog__title">
              Modifier {editingRemote.name}
            </h2>
            <div className="field">
              <label htmlFor="remote-env-edit-name">Nom</label>
              <input
                id="remote-env-edit-name"
                value={editRemoteForm.name}
                onChange={(event) => setEditRemoteForm((f) => ({ ...f, name: event.target.value }))}
                disabled={updatingRemote}
                autoFocus
                required
              />
            </div>
            <div className="field">
              <label htmlFor="remote-env-edit-host">Hôte</label>
              <input
                id="remote-env-edit-host"
                value={editRemoteForm.host}
                onChange={(event) => setEditRemoteForm((f) => ({ ...f, host: event.target.value }))}
                disabled={updatingRemote}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="remote-env-edit-port">Port</label>
              <input
                id="remote-env-edit-port"
                type="number"
                min={1}
                max={65535}
                value={editRemoteForm.port}
                onChange={(event) => setEditRemoteForm((f) => ({ ...f, port: event.target.value }))}
                disabled={updatingRemote}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="remote-env-edit-transport">Transport</label>
              <select
                id="remote-env-edit-transport"
                className="topbar__env-select"
                value={editRemoteTransport}
                onChange={(event) => handleEditRemoteTransportChange(event.target.value as RemoteDockerTransport)}
                disabled={updatingRemote}
              >
                <option value="tcp-tls">TCP+TLS — démon Docker exposé sur le réseau</option>
                <option value="ssh">SSH — hôte joignable uniquement en SSH (ex : VPS)</option>
              </select>
              {editRemoteTransport !== editingRemote.transport && (
                <p className="create-container-hint">
                  Changer de transport retire les identifiants {editingRemote.transport === "ssh" ? "SSH" : "TLS"}{" "}
                  actuels — de nouveaux identifiants {editRemoteTransport === "ssh" ? "SSH" : "TLS"} sont requis
                  ci-dessous.
                </p>
              )}
            </div>

            {editRemoteTransport === "tcp-tls" && (
              <>
                <label className="filter-toggle">
                  <input
                    type="checkbox"
                    checked={editRemoteTlsForm.enabled}
                    onChange={(event) =>
                      setEditRemoteTlsForm((f) => ({ ...f, enabled: event.target.checked }))
                    }
                    disabled={updatingRemote || editRemoteTransport !== editingRemote.transport}
                  />
                  Modifier le TLS ({editingRemote.hasTls ? "actuellement activé" : "actuellement désactivé"})
                </label>
                {editRemoteTlsForm.enabled && (
                  <>
                    <div className="field">
                      <label htmlFor="remote-env-edit-tls-ca">Certificat CA (PEM)</label>
                      <textarea
                        id="remote-env-edit-tls-ca"
                        rows={3}
                        value={editRemoteTlsForm.ca}
                        onChange={(event) => setEditRemoteTlsForm((f) => ({ ...f, ca: event.target.value }))}
                        placeholder="laisser vide = conserver l'actuel"
                        disabled={updatingRemote}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="remote-env-edit-tls-cert">Certificat client (PEM)</label>
                      <textarea
                        id="remote-env-edit-tls-cert"
                        rows={3}
                        value={editRemoteTlsForm.cert}
                        onChange={(event) => setEditRemoteTlsForm((f) => ({ ...f, cert: event.target.value }))}
                        placeholder="laisser vide = conserver l'actuel"
                        disabled={updatingRemote}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="remote-env-edit-tls-key">Clé privée client (PEM)</label>
                      <textarea
                        id="remote-env-edit-tls-key"
                        rows={3}
                        value={editRemoteTlsForm.key}
                        onChange={(event) => setEditRemoteTlsForm((f) => ({ ...f, key: event.target.value }))}
                        placeholder="laisser vide = conserver l'actuel"
                        disabled={updatingRemote}
                      />
                    </div>
                    {!isTlsFormValid(editRemoteTlsForm) && (
                      <p className="graph-popover__error">Certificat et clé doivent être fournis ensemble.</p>
                    )}
                    <p style={{ margin: 0, fontSize: "0.85em", opacity: 0.75 }}>
                      {editRemoteTransport !== editingRemote.transport
                        ? "Certificat et clé requis (nouveau transport)."
                        : "Tout laisser vide ici retire le TLS (repasse en TCP non chiffré)."}
                    </p>
                  </>
                )}
              </>
            )}

            {editRemoteTransport === "ssh" && (
              <>
                <label className="filter-toggle">
                  <input
                    type="checkbox"
                    checked={editSshChangeCreds}
                    onChange={(event) => setEditSshChangeCreds(event.target.checked)}
                    disabled={updatingRemote || editRemoteTransport !== editingRemote.transport}
                  />
                  Modifier les identifiants SSH (
                  {editingRemote.hasSshCredentials ? `actuellement : ${editingRemote.sshUsername}` : "aucun identifiant enregistré"}
                  )
                </label>
                {(editSshChangeCreds || editRemoteTransport !== editingRemote.transport) && (
                  <>
                    <div className="field">
                      <label htmlFor="remote-env-edit-ssh-username">Utilisateur SSH</label>
                      <input
                        id="remote-env-edit-ssh-username"
                        value={editRemoteSshForm.username}
                        onChange={(event) => setEditRemoteSshForm((f) => ({ ...f, username: event.target.value }))}
                        disabled={updatingRemote}
                        required
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="remote-env-edit-ssh-auth-method">Authentification</label>
                      <select
                        id="remote-env-edit-ssh-auth-method"
                        className="topbar__env-select"
                        value={editRemoteSshForm.authMethod}
                        onChange={(event) =>
                          setEditRemoteSshForm((f) => ({
                            ...f,
                            authMethod: event.target.value as "password" | "privateKey",
                          }))
                        }
                        disabled={updatingRemote}
                      >
                        <option value="password">Mot de passe</option>
                        <option value="privateKey">Clé privée</option>
                      </select>
                    </div>
                    {editRemoteSshForm.authMethod === "password" ? (
                      <div className="field">
                        <label htmlFor="remote-env-edit-ssh-password">Mot de passe SSH</label>
                        <input
                          id="remote-env-edit-ssh-password"
                          type="password"
                          value={editRemoteSshForm.password}
                          onChange={(event) => setEditRemoteSshForm((f) => ({ ...f, password: event.target.value }))}
                          autoComplete="new-password"
                          disabled={updatingRemote}
                          required
                        />
                      </div>
                    ) : (
                      <div className="field">
                        <label htmlFor="remote-env-edit-ssh-private-key">Clé privée SSH (PEM)</label>
                        <textarea
                          id="remote-env-edit-ssh-private-key"
                          rows={3}
                          value={editRemoteSshForm.privateKey}
                          onChange={(event) =>
                            setEditRemoteSshForm((f) => ({ ...f, privateKey: event.target.value }))
                          }
                          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;…"
                          disabled={updatingRemote}
                          required
                        />
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {remoteUpdateError && <p className="graph-popover__error">{remoteUpdateError}</p>}
            <div className="confirm-dialog__actions">
              <button type="button" className="btn btn-ghost" onClick={closeEditRemote} disabled={updatingRemote}>
                Annuler
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={
                  updatingRemote ||
                  !editRemoteForm.name.trim() ||
                  !editRemoteForm.host.trim() ||
                  (editRemoteTransport === "tcp-tls"
                    ? !isTlsFormValid(editRemoteTlsForm)
                    : editSshChangeCreds || editRemoteTransport !== editingRemote.transport
                      ? !isSshFormValid(editRemoteSshForm)
                      : false)
                }
              >
                {updatingRemote ? "Enregistrement…" : "Enregistrer"}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
