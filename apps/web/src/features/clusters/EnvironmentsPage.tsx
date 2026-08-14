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
  updateRemoteEnvironment,
} from "@/features/remoteEnvironments/remoteEnvironmentsSlice";
import { canAdminister } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import Inspector from "@/components/Inspector";
import Modal from "@/components/Modal";
import StatusPill from "@/components/StatusPill";
import Gauge from "@/components/Gauge";
import KeyValueList from "@/components/KeyValueList";
import { IconChevron, IconPlus, IconSettings, IconTrash, IconVm } from "@/components/icons";
import type { NutanixVm, RemoteDockerEnvironmentRef, RemoteDockerTransport } from "@/types";

/** État du bloc TLS partagé par le formulaire de création et celui d'édition — un objet vide
 * (`ca`/`cert`/`key` tous vides) avec `enabled: false` équivaut à "pas de TLS" ; `cert`/`key`
 * doivent être fournis ensemble (même règle que remoteDockerStore.ts#assertValidInput), vérifié
 * côté client pour un message d'erreur immédiat plutôt qu'un aller-retour serveur inutile.
 */
interface RemoteTlsFormState {
  enabled: boolean;
  ca: string;
  cert: string;
  key: string;
}

const EMPTY_TLS_FORM: RemoteTlsFormState = { enabled: false, ca: "", cert: "", key: "" };

/** true si le bloc TLS est dans un état soumissible (désactivé, ou cert+key fournis ensemble —
 * ca seul ou cert/key dépareillés bloquent la soumission côté client, en miroir de
 * remoteDockerStore.ts#assertValidInput côté serveur). */
function isTlsFormValid(tls: RemoteTlsFormState): boolean {
  if (!tls.enabled) return true;
  const hasCert = tls.cert.trim().length > 0;
  const hasKey = tls.key.trim().length > 0;
  return hasCert === hasKey;
}

/** État du bloc SSH (transport "ssh" — VPS/hôte joignable uniquement par SSH, aucun port Docker
 * exposé, voir remoteDockerStore.ts en-tête). `authMethod` est un choix EXCLUSIF côté formulaire
 * (mot de passe OU clé privée) — le store accepte les deux en théorie mais un seul à la fois
 * garde le formulaire lisible ; l'autre champ est toujours vidé au changement de méthode. */
interface RemoteSshFormState {
  username: string;
  authMethod: "password" | "privateKey";
  password: string;
  privateKey: string;
}

const EMPTY_SSH_FORM: RemoteSshFormState = { username: "", authMethod: "password", password: "", privateKey: "" };

/** miroir de remoteDockerStore.ts#assertValidInput pour transport "ssh" : username requis, ET
 * (password OU privateKey) requis pour la méthode choisie. */
function isSshFormValid(ssh: RemoteSshFormState): boolean {
  if (!ssh.username.trim()) return false;
  return ssh.authMethod === "password" ? ssh.password.trim().length > 0 : ssh.privateKey.trim().length > 0;
}

const DEFAULT_PORT_BY_TRANSPORT: Record<RemoteDockerTransport, string> = { "tcp-tls": "2376", ssh: "22" };

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
  const [remoteTransport, setRemoteTransport] = useState<RemoteDockerTransport>("tcp-tls");
  const [remoteTlsForm, setRemoteTlsForm] = useState<RemoteTlsFormState>(EMPTY_TLS_FORM);
  const [remoteSshForm, setRemoteSshForm] = useState<RemoteSshFormState>(EMPTY_SSH_FORM);
  const [remoteCreateError, setRemoteCreateError] = useState<string | null>(null);

  /** Changement de transport dans le formulaire de création : ne réajuste le port au défaut du
   * nouveau transport QUE s'il portait encore le défaut de l'ANCIEN transport — un port saisi à la
   * main par l'utilisateur n'est jamais écrasé silencieusement. */
  function handleRemoteTransportChange(next: RemoteDockerTransport) {
    setRemoteTransport(next);
    setRemoteForm((f) =>
      f.port === DEFAULT_PORT_BY_TRANSPORT[remoteTransport] ? { ...f, port: DEFAULT_PORT_BY_TRANSPORT[next] } : f,
    );
  }

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

  function resetRemoteCreateForm() {
    setShowRemoteForm(false);
    setRemoteForm({ name: "", host: "", port: "2376" });
    setRemoteTransport("tcp-tls");
    setRemoteTlsForm(EMPTY_TLS_FORM);
    setRemoteSshForm(EMPTY_SSH_FORM);
    setRemoteCreateError(null);
  }

  function handleCreateRemote(event: FormEvent) {
    event.preventDefault();
    const name = remoteForm.name.trim();
    const host = remoteForm.host.trim();
    const port = Number(remoteForm.port);
    if (!name || !host || !Number.isInteger(port) || port < 1 || port > 65535) return;
    if (remoteTransport === "tcp-tls" && !isTlsFormValid(remoteTlsForm)) return;
    if (remoteTransport === "ssh" && !isSshFormValid(remoteSshForm)) return;
    setRemoteCreateError(null);

    let payload: Parameters<typeof createRemoteEnvironment>[0];
    if (remoteTransport === "ssh") {
      const username = remoteSshForm.username.trim();
      const password = remoteSshForm.authMethod === "password" ? remoteSshForm.password.trim() : "";
      const privateKey = remoteSshForm.authMethod === "privateKey" ? remoteSshForm.privateKey.trim() : "";
      payload = {
        name,
        host,
        port,
        transport: "ssh",
        ssh: { username, ...(password ? { password } : {}), ...(privateKey ? { privateKey } : {}) },
      };
    } else {
      const ca = remoteTlsForm.ca.trim();
      const cert = remoteTlsForm.cert.trim();
      const key = remoteTlsForm.key.trim();
      const tls =
        remoteTlsForm.enabled && (ca || cert || key)
          ? { ...(ca ? { ca } : {}), ...(cert ? { cert } : {}), ...(key ? { key } : {}) }
          : undefined;
      payload = { name, host, port, transport: "tcp-tls", ...(tls ? { tls } : {}) };
    }

    dispatch(createRemoteEnvironment(payload)).then((action) => {
      if (createRemoteEnvironment.fulfilled.match(action)) {
        resetRemoteCreateForm();
        // Cet environnement devient sélectionnable dans le sélecteur du Topbar dès le prochain
        // rechargement de GET /api/environments (voir services/environments.ts#getRemoteDockerEnvironments).
        dispatch(fetchEnvironments());
      } else {
        setRemoteCreateError(action.payload ?? "Impossible de créer cet environnement.");
      }
    });
  }

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

      {/* Création — modale (même pattern que RegistriesPage.tsx#showForm) : le bouton "Nouvel
          environnement" ci-dessus l'ouvre, jamais de logique de création sans ce flux. */}
      <Modal open={showRemoteForm} onClose={resetRemoteCreateForm} labelledBy="remote-env-create-title">
        <form className="confirm-dialog" onSubmit={handleCreateRemote}>
          <h2 id="remote-env-create-title" className="confirm-dialog__title">
            Nouvel environnement Docker distant
          </h2>
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
            <label htmlFor="remote-env-transport">Transport</label>
            <select
              id="remote-env-transport"
              className="topbar__env-select"
              value={remoteTransport}
              onChange={(event) => handleRemoteTransportChange(event.target.value as RemoteDockerTransport)}
              disabled={creatingRemote}
            >
              <option value="tcp-tls">TCP+TLS — démon Docker exposé sur le réseau</option>
              <option value="ssh">SSH — hôte joignable uniquement en SSH (ex : VPS)</option>
            </select>
            <p className="create-container-hint">
              {remoteTransport === "ssh"
                ? "Aucun port Docker exposé : QUAI se connecte au port SSH déjà ouvert pour l'administration de la machine, puis tunnelise Docker au travers."
                : "Le démon Docker distant expose directement son API TCP (voir docs.docker.com/engine/security/protect-access)."}
            </p>
          </div>
          <div className="field">
            <label htmlFor="remote-env-port">Port {remoteTransport === "ssh" ? "SSH" : "Docker"}</label>
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

          {remoteTransport === "tcp-tls" && (
            <>
              <label className="filter-toggle">
                <input
                  type="checkbox"
                  checked={remoteTlsForm.enabled}
                  onChange={(event) =>
                    setRemoteTlsForm((f) => ({ ...f, enabled: event.target.checked }))
                  }
                  disabled={creatingRemote}
                />
                Activer TLS (démon exposé en TCP+TLS — recommandé)
              </label>
              {remoteTlsForm.enabled && (
                <>
                  <div className="field">
                    <label htmlFor="remote-env-tls-ca">Certificat CA (PEM)</label>
                    <textarea
                      id="remote-env-tls-ca"
                      rows={3}
                      value={remoteTlsForm.ca}
                      onChange={(event) => setRemoteTlsForm((f) => ({ ...f, ca: event.target.value }))}
                      placeholder="-----BEGIN CERTIFICATE-----&#10;… (optionnel)"
                      disabled={creatingRemote}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="remote-env-tls-cert">Certificat client (PEM)</label>
                    <textarea
                      id="remote-env-tls-cert"
                      rows={3}
                      value={remoteTlsForm.cert}
                      onChange={(event) => setRemoteTlsForm((f) => ({ ...f, cert: event.target.value }))}
                      placeholder="-----BEGIN CERTIFICATE-----&#10;…"
                      disabled={creatingRemote}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="remote-env-tls-key">Clé privée client (PEM)</label>
                    <textarea
                      id="remote-env-tls-key"
                      rows={3}
                      value={remoteTlsForm.key}
                      onChange={(event) => setRemoteTlsForm((f) => ({ ...f, key: event.target.value }))}
                      placeholder="-----BEGIN PRIVATE KEY-----&#10;…"
                      disabled={creatingRemote}
                    />
                  </div>
                  {!isTlsFormValid(remoteTlsForm) && (
                    <p className="graph-popover__error">Certificat et clé doivent être fournis ensemble.</p>
                  )}
                  <p style={{ margin: 0, fontSize: "0.85em", opacity: 0.75 }}>
                    Chiffrés au repos (AES-256-GCM) ; jamais relus ni réaffichés une fois enregistrés.
                  </p>
                </>
              )}
            </>
          )}

          {remoteTransport === "ssh" && (
            <>
              <div className="field">
                <label htmlFor="remote-env-ssh-username">Utilisateur SSH</label>
                <input
                  id="remote-env-ssh-username"
                  value={remoteSshForm.username}
                  onChange={(event) => setRemoteSshForm((f) => ({ ...f, username: event.target.value }))}
                  placeholder="ex : deploy"
                  disabled={creatingRemote}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="remote-env-ssh-auth-method">Authentification</label>
                <select
                  id="remote-env-ssh-auth-method"
                  className="topbar__env-select"
                  value={remoteSshForm.authMethod}
                  onChange={(event) =>
                    setRemoteSshForm((f) => ({ ...f, authMethod: event.target.value as "password" | "privateKey" }))
                  }
                  disabled={creatingRemote}
                >
                  <option value="password">Mot de passe</option>
                  <option value="privateKey">Clé privée</option>
                </select>
              </div>
              {remoteSshForm.authMethod === "password" ? (
                <div className="field">
                  <label htmlFor="remote-env-ssh-password">Mot de passe SSH</label>
                  <input
                    id="remote-env-ssh-password"
                    type="password"
                    value={remoteSshForm.password}
                    onChange={(event) => setRemoteSshForm((f) => ({ ...f, password: event.target.value }))}
                    autoComplete="new-password"
                    disabled={creatingRemote}
                    required
                  />
                </div>
              ) : (
                <div className="field">
                  <label htmlFor="remote-env-ssh-private-key">Clé privée SSH (PEM)</label>
                  <textarea
                    id="remote-env-ssh-private-key"
                    rows={3}
                    value={remoteSshForm.privateKey}
                    onChange={(event) => setRemoteSshForm((f) => ({ ...f, privateKey: event.target.value }))}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;…"
                    disabled={creatingRemote}
                    required
                  />
                </div>
              )}
              <p style={{ margin: 0, fontSize: "0.85em", opacity: 0.75 }}>
                Chiffrés au repos (AES-256-GCM) ; jamais relus ni réaffichés une fois enregistrés.
              </p>
            </>
          )}

          {remoteCreateError && <p className="graph-popover__error">{remoteCreateError}</p>}
          <div className="confirm-dialog__actions">
            <button type="button" className="btn btn-ghost" onClick={resetRemoteCreateForm} disabled={creatingRemote}>
              Annuler
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={
                creatingRemote ||
                !remoteForm.name.trim() ||
                !remoteForm.host.trim() ||
                (remoteTransport === "tcp-tls" ? !isTlsFormValid(remoteTlsForm) : !isSshFormValid(remoteSshForm))
              }
            >
              {creatingRemote ? "Test et création…" : "Créer"}
            </button>
          </div>
        </form>
      </Modal>

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
