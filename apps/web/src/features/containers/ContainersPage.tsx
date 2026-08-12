import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  createContainer,
  fetchContainerDetail,
  fetchContainers,
  runContainerAction,
  selectContainer,
  type LifecycleAction,
  type SecretEnvEntry,
} from "@/features/containers/containersSlice";
import { fetchSecrets } from "@/features/secrets/secretsSlice";
import { canOperate } from "@/features/auth/authSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import { usePagination } from "@/hooks/usePagination";
import Inspector from "@/components/Inspector";
import StatusPill from "@/components/StatusPill";
import Gauge from "@/components/Gauge";
import KeyValueList from "@/components/KeyValueList";
import Pagination from "@/components/Pagination";
import { SkeletonTable } from "@/components/Skeleton";
import ContainerConsole from "@/components/ContainerConsole";
import ContainerLogs from "@/features/containers/ContainerLogs";
import { IconHistory, IconPlay, IconRestart, IconStop, IconTerminal, IconTrash } from "@/components/icons";

/** Une ligne du formulaire "Secrets" — id local (pas de valeur réelle stockée côté client, voir
 * plus bas) le temps de l'édition, avant conversion en SecretEnvEntry[] pour le payload. */
interface SecretEnvRow {
  rowId: number;
  key: string;
  secretName: string;
}

function formatMem(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)} Mo`;
  return `${(mb / 1024).toFixed(2)} Go`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const ACTION_LABEL: Record<LifecycleAction, string> = {
  start: "Démarrer",
  stop: "Arrêter",
  restart: "Redémarrer",
  remove: "Supprimer",
};

export default function ContainersPage() {
  const dispatch = useAppDispatch();
  const { items, status, error, selectedId, createStatus, createError, detail, detailStatus, actionPendingId } =
    useAppSelector((s) => s.containers);
  const searchQuery = useAppSelector((s) => s.ui.searchQuery);
  const selectedEnvironmentId = useAppSelector((s) => s.ui.selectedEnvironmentId);
  const environments = useAppSelector((s) => s.clusters.environments);
  const session = useAppSelector((s) => s.auth.session);
  const availableSecrets = useAppSelector((s) => s.secrets.items);
  const confirm = useConfirm();

  const [formOpen, setFormOpen] = useState(false);
  const [image, setImage] = useState("");
  const [name, setName] = useState("");
  const [portsInput, setPortsInput] = useState("");
  const [envInput, setEnvInput] = useState("");
  const [volumesInput, setVolumesInput] = useState("");
  const [network, setNetwork] = useState("");
  const [secretEnvRows, setSecretEnvRows] = useState<SecretEnvRow[]>([]);
  const nextSecretRowId = useRef(0);
  const [consoleTarget, setConsoleTarget] = useState<{ id: string; name: string } | null>(null);
  const [logsTarget, setLogsTarget] = useState<{ id: string; name: string } | null>(null);
  // Limites de ressources optionnelles (converties vers les unités Docker natives — octets/
  // NanoCpus — juste avant l'envoi, voir handleCreate) : absentes = pas de limite, comportement
  // Docker natif inchangé (voir POST /api/containers, aucune valeur par défaut fabriquée).
  const [memoryLimitValue, setMemoryLimitValue] = useState("");
  const [memoryLimitUnit, setMemoryLimitUnit] = useState<"Mo" | "Go">("Mo");
  const [cpuLimitCores, setCpuLimitCores] = useState("");

  // Re-fetch quand l'environnement sélectionné dans le Topbar change — voir
  // apps/api/src/utils/environmentId.ts : seul un id "remote-docker:<id>" change réellement le
  // démon interrogé (voir ARCHITECTURE.md § "Environnements Docker distants"), tout autre id
  // retombe sur le comportement historique (démon local).
  useEffect(() => {
    dispatch(fetchContainers(selectedEnvironmentId));
  }, [dispatch, selectedEnvironmentId]);

  // Chargé pour peupler le sélecteur "Secrets" du formulaire de création — n'affiche jamais de
  // valeur, seulement les noms référençables (voir features/secrets/secretsSlice.ts).
  useEffect(() => {
    dispatch(fetchSecrets());
  }, [dispatch]);

  useEffect(() => {
    if (selectedId) dispatch(fetchContainerDetail(selectedId));
  }, [dispatch, selectedId]);

  function addSecretEnvRow() {
    setSecretEnvRows((rows) => [
      ...rows,
      { rowId: nextSecretRowId.current++, key: "", secretName: availableSecrets[0]?.name ?? "" },
    ]);
  }

  function updateSecretEnvRow(rowId: number, patch: Partial<Pick<SecretEnvRow, "key" | "secretName">>) {
    setSecretEnvRows((rows) => rows.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)));
  }

  function removeSecretEnvRow(rowId: number) {
    setSecretEnvRows((rows) => rows.filter((row) => row.rowId !== rowId));
  }

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    const trimmedImage = image.trim();
    if (!trimmedImage) return;
    const ports = portsInput.split(",").map((p) => p.trim()).filter(Boolean);
    const env = envInput.split("\n").map((e) => e.trim()).filter(Boolean);
    const volumes = volumesInput.split(",").map((v) => v.trim()).filter(Boolean);
    const trimmedName = name.trim();
    const trimmedNetwork = network.trim();
    const secretEnv: SecretEnvEntry[] = secretEnvRows
      .map((row) => ({ key: row.key.trim(), secretName: row.secretName.trim() }))
      .filter((row) => row.key && row.secretName);

    // Conversion Mo/Go -> octets et cœurs -> NanoCpus (unités Docker natives, voir
    // HostConfig.Memory/NanoCpus côté API) — un champ vide ou invalide reste `undefined`, jamais
    // une limite fabriquée par défaut.
    const memoryLimitTrimmed = memoryLimitValue.trim();
    const memoryLimitParsed = memoryLimitTrimmed ? Number(memoryLimitTrimmed) : NaN;
    const memoryLimitBytes =
      Number.isFinite(memoryLimitParsed) && memoryLimitParsed > 0
        ? Math.round(memoryLimitParsed * (memoryLimitUnit === "Go" ? 1024 * 1024 * 1024 : 1024 * 1024))
        : undefined;
    const cpuLimitTrimmed = cpuLimitCores.trim();
    const cpuLimitParsed = cpuLimitTrimmed ? Number(cpuLimitTrimmed) : NaN;
    const nanoCpus = Number.isFinite(cpuLimitParsed) && cpuLimitParsed > 0 ? Math.round(cpuLimitParsed * 1_000_000_000) : undefined;

    dispatch(
      createContainer({
        image: trimmedImage,
        ...(trimmedName ? { name: trimmedName } : {}),
        ports,
        env,
        ...(secretEnv.length > 0 ? { secretEnv } : {}),
        volumes,
        ...(trimmedNetwork ? { network: trimmedNetwork } : {}),
        ...(memoryLimitBytes !== undefined ? { memoryLimitBytes } : {}),
        ...(nanoCpus !== undefined ? { nanoCpus } : {}),
      }),
    ).then((result) => {
      if (createContainer.fulfilled.match(result)) {
        setFormOpen(false);
        setImage("");
        setName("");
        setPortsInput("");
        setEnvInput("");
        setVolumesInput("");
        setNetwork("");
        setSecretEnvRows([]);
        setMemoryLimitValue("");
        setMemoryLimitUnit("Mo");
        setCpuLimitCores("");
      }
    });
  }

  async function handleAction(id: string, containerName: string, action: LifecycleAction) {
    if (action === "stop" || action === "remove") {
      const ok = await confirm({
        title: `${ACTION_LABEL[action]} le conteneur`,
        description:
          action === "remove"
            ? `Confirmer la suppression de "${containerName}" ? Cette action est irréversible (le conteneur doit être arrêté, ou utilisez "force").`
            : `Confirmer l'arrêt de "${containerName}" ?`,
        confirmLabel: ACTION_LABEL[action],
        variant: "danger",
      });
      if (!ok) return;
    }
    dispatch(runContainerAction({ id, action }));
  }

  const selectedEnvironmentName = environments.find((e) => e.id === selectedEnvironmentId)?.name;

  const visible = items.filter((container) => {
    if (selectedEnvironmentName && container.environment !== selectedEnvironmentName) return false;
    if (searchQuery && !container.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const selected = items.find((container) => container.id === selectedId) ?? null;
  const maxMemBytes = Math.max(1, ...items.map((container) => container.memBytes));
  const { page, totalPages, pageItems, setPage, pageSize, setPageSize } = usePagination(visible, 10);

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Conteneurs</h2>
            <p>Conteneurs actifs sur les environnements Swarm et Kubernetes.</p>
          </div>
          {canOperate(session) && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setFormOpen((open) => !open)}>
              {formOpen ? "Annuler" : "+ Nouveau conteneur"}
            </button>
          )}
        </div>

        {formOpen && canOperate(session) && (
          <form className="create-container-form" onSubmit={handleCreate}>
            <div className="field">
              <label htmlFor="create-image">Image</label>
              <input
                id="create-image"
                type="text"
                placeholder="ex : redis:7-alpine"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                disabled={createStatus === "creating"}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="create-name">Nom (optionnel)</label>
              <input
                id="create-name"
                type="text"
                placeholder="ex : cache-redis"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={createStatus === "creating"}
              />
            </div>
            <div className="field">
              <label htmlFor="create-ports">Ports (optionnel)</label>
              <input
                id="create-ports"
                type="text"
                placeholder="ex : 6379:6379, 8080:80"
                value={portsInput}
                onChange={(e) => setPortsInput(e.target.value)}
                disabled={createStatus === "creating"}
              />
            </div>
            <div className="field">
              <label htmlFor="create-volumes">Volumes (optionnel)</label>
              <input
                id="create-volumes"
                type="text"
                placeholder="ex : pgdata:/var/lib/postgresql/data"
                value={volumesInput}
                onChange={(e) => setVolumesInput(e.target.value)}
                disabled={createStatus === "creating"}
              />
            </div>
            <div className="field">
              <label htmlFor="create-network">Network (optionnel)</label>
              <input
                id="create-network"
                type="text"
                placeholder="bridge"
                value={network}
                onChange={(e) => setNetwork(e.target.value)}
                disabled={createStatus === "creating"}
              />
            </div>
            <div className="field">
              <label htmlFor="create-memory-limit">Limite mémoire (optionnel)</label>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  id="create-memory-limit"
                  type="number"
                  min="1"
                  step="any"
                  placeholder="ex : 512"
                  value={memoryLimitValue}
                  onChange={(e) => setMemoryLimitValue(e.target.value)}
                  disabled={createStatus === "creating"}
                  style={{ flex: 1 }}
                />
                <select
                  className="topbar__env-select"
                  value={memoryLimitUnit}
                  onChange={(e) => setMemoryLimitUnit(e.target.value === "Go" ? "Go" : "Mo")}
                  disabled={createStatus === "creating"}
                  aria-label="Unité de la limite mémoire"
                >
                  <option value="Mo">Mo</option>
                  <option value="Go">Go</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="create-cpu-limit">Limite CPU en cœurs (optionnel)</label>
              <input
                id="create-cpu-limit"
                type="number"
                min="0.05"
                step="0.05"
                placeholder="ex : 0.5"
                value={cpuLimitCores}
                onChange={(e) => setCpuLimitCores(e.target.value)}
                disabled={createStatus === "creating"}
              />
            </div>
            <div className="field" style={{ flexBasis: "100%" }}>
              <label htmlFor="create-env">Variables d'environnement (optionnel, une par ligne)</label>
              <textarea
                id="create-env"
                placeholder={"POSTGRES_PASSWORD=secret\nNODE_ENV=production"}
                value={envInput}
                onChange={(e) => setEnvInput(e.target.value)}
                disabled={createStatus === "creating"}
                rows={3}
              />
            </div>

            <div className="field" style={{ flexBasis: "100%" }}>
              <label>Secrets (optionnel)</label>
              {availableSecrets.length === 0 ? (
                <p className="create-container-hint">
                  Aucun secret configuré, voir la page Secrets.
                </p>
              ) : (
                <>
                  {secretEnvRows.map((row) => (
                    <div key={row.rowId} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                      <input
                        type="text"
                        placeholder="ex : DB_PASSWORD"
                        value={row.key}
                        onChange={(e) => updateSecretEnvRow(row.rowId, { key: e.target.value })}
                        disabled={createStatus === "creating"}
                        style={{ flex: 1 }}
                      />
                      <span>=</span>
                      <select
                        className="topbar__env-select"
                        value={row.secretName}
                        onChange={(e) => updateSecretEnvRow(row.rowId, { secretName: e.target.value })}
                        disabled={createStatus === "creating"}
                        style={{ flex: 1 }}
                      >
                        {availableSecrets.map((secret) => (
                          <option key={secret.id} value={secret.name}>
                            {secret.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="icon-btn icon-btn--danger"
                        title="Retirer cette ligne"
                        aria-label="Retirer cette ligne"
                        onClick={() => removeSecretEnvRow(row.rowId)}
                        disabled={createStatus === "creating"}
                      >
                        <IconTrash />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={addSecretEnvRow}
                    disabled={createStatus === "creating"}
                  >
                    + Référencer un secret
                  </button>
                </>
              )}
            </div>

            <button type="submit" className="btn btn-primary" disabled={createStatus === "creating" || !image.trim()}>
              {createStatus === "creating" ? "Création…" : "Créer et démarrer"}
            </button>
            <p className="create-container-hint">
              L'image doit déjà être présente localement — utilisez « Pull » sur la page Images si besoin. Les
              volumes nommés doivent déjà exister (page Volumes), les networks aussi (page Networks).
            </p>
          </form>
        )}

        {createStatus === "error" && createError && <div className="error-banner">{createError}</div>}
        {error && <div className="error-banner">{error}</div>}
        {status === "loading" && items.length === 0 && (
          <SkeletonTable
            columns={["Nom", "Image", "Environnement", "Nœud", "État", "CPU", "RAM", ""]}
            rows={8}
          />
        )}
        {status !== "loading" && visible.length === 0 && !error && (
          <div className="empty-state">Aucun conteneur ne correspond aux critères.</div>
        )}

        {visible.length > 0 && (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th>Image</th>
                  <th>Environnement</th>
                  <th>Nœud</th>
                  <th>État</th>
                  <th>CPU</th>
                  <th>RAM</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pageItems.map((container) => (
                  <tr
                    key={container.id}
                    className={container.id === selectedId ? "is-selected" : ""}
                    onClick={() => dispatch(selectContainer(container.id))}
                  >
                    <td className="cell-primary cell-mono">{container.name}</td>
                    <td className="cell-mono">{container.image}</td>
                    <td>{container.environment}</td>
                    <td className="cell-mono">{container.node}</td>
                    <td>
                      <StatusPill status={container.state} />
                    </td>
                    <td className="cell-mono">{container.cpuPercent.toFixed(0)}%</td>
                    <td className="cell-mono">{formatMem(container.memBytes)}</td>
                    <td className="cell-actions" onClick={(e) => e.stopPropagation()}>
                      {canOperate(session) && container.environment !== "Kubernetes" && (
                        <div className="row-actions">
                          {container.state !== "running" ? (
                            <button
                              type="button"
                              className="icon-btn"
                              title="Démarrer"
                              disabled={actionPendingId === container.id}
                              onClick={() => handleAction(container.id, container.name, "start")}
                            >
                              <IconPlay />
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="icon-btn"
                              title="Arrêter"
                              disabled={actionPendingId === container.id}
                              onClick={() => handleAction(container.id, container.name, "stop")}
                            >
                              <IconStop />
                            </button>
                          )}
                          <button
                            type="button"
                            className="icon-btn"
                            title="Redémarrer"
                            disabled={actionPendingId === container.id}
                            onClick={() => handleAction(container.id, container.name, "restart")}
                          >
                            <IconRestart />
                          </button>
                          <button
                            type="button"
                            className="icon-btn icon-btn--danger"
                            title="Supprimer"
                            disabled={actionPendingId === container.id}
                            onClick={() => handleAction(container.id, container.name, "remove")}
                          >
                            <IconTrash />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pagination
          page={page}
          totalPages={totalPages}
          totalItems={visible.length}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>

      <Inspector title={selected?.name} subtitle={selected?.image} onClose={() => dispatch(selectContainer(null))}>
        {selected && (
          <>
            <StatusPill status={selected.state} />

            {canOperate(session) && selected.environment !== "Kubernetes" && (
              <div className="inspector-actions">
                {selected.state !== "running" ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={actionPendingId === selected.id}
                    onClick={() => handleAction(selected.id, selected.name, "start")}
                  >
                    <IconPlay /> Démarrer
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={actionPendingId === selected.id}
                    onClick={() => handleAction(selected.id, selected.name, "stop")}
                  >
                    <IconStop /> Arrêter
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={actionPendingId === selected.id}
                  onClick={() => handleAction(selected.id, selected.name, "restart")}
                >
                  <IconRestart /> Redémarrer
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={actionPendingId === selected.id}
                  onClick={() => handleAction(selected.id, selected.name, "remove")}
                >
                  <IconTrash /> Supprimer
                </button>
              </div>
            )}

            {selected.environment !== "Kubernetes" && (
              <div className="inspector-actions">
                {/* Logs : lecture seule, ouvert à tout rôle authentifié (viewer inclus) — voir
                    routes/containerLogs.ts, contrairement à la console ci-dessous qui ouvre un
                    vrai shell et reste réservée operator/admin. Utile même sur un conteneur
                    arrêté (comprendre pourquoi il s'est arrêté), donc pas conditionné à `running`. */}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setLogsTarget({ id: selected.id, name: selected.name })}
                >
                  <IconHistory /> Logs
                </button>
                {canOperate(session) && selected.state === "running" && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setConsoleTarget({ id: selected.id, name: selected.name })}
                  >
                    <IconTerminal /> Console
                  </button>
                )}
              </div>
            )}

            <Gauge label="CPU" percent={selected.cpuPercent} />
            <Gauge
              label={`Mémoire (${formatMem(selected.memBytes)})`}
              percent={(selected.memBytes / maxMemBytes) * 100}
            />

            <KeyValueList
              rows={[
                { key: "Environnement", value: selected.environment },
                { key: "Nœud", value: selected.node },
                { key: "Mémoire", value: formatMem(selected.memBytes) },
              ]}
            />

            {detailStatus === "loading" && <div className="empty-state">Chargement du détail…</div>}

            {detail && detail.id === selected.id && (
              <>
                <div className="inspector-section-title">Détail</div>
                <KeyValueList
                  rows={[
                    { key: "ID complet", value: detail.fullId },
                    { key: "Créé le", value: formatDate(detail.createdAt) },
                    { key: "Commande", value: detail.command || "—" },
                    { key: "Politique de redémarrage", value: detail.restartPolicy },
                    { key: "Network", value: detail.networkMode },
                    // Limites réellement configurées (docker inspect HostConfig.Memory/NanoCpus) —
                    // n'apparaissent QUE si effectivement fixées à la création, jamais une valeur
                    // fabriquée pour un conteneur sans limite (voir services/docker.ts#inspectDockerContainer).
                    ...(detail.memoryLimitBytes !== undefined
                      ? [{ key: "Limite mémoire", value: formatMem(detail.memoryLimitBytes) }]
                      : []),
                    ...(detail.nanoCpus !== undefined
                      ? [{ key: "Limite CPU", value: `${(detail.nanoCpus / 1_000_000_000).toFixed(2)} cœur(s)` }]
                      : []),
                  ]}
                />

                {detail.ports.length > 0 && (
                  <>
                    <div className="inspector-section-title">Ports</div>
                    <KeyValueList
                      rows={detail.ports.map((p) => ({
                        key: `${p.containerPort}/${p.proto}`,
                        value: p.hostPort ? `→ ${p.hostPort}` : "non publié",
                      }))}
                    />
                  </>
                )}

                {detail.mounts.length > 0 && (
                  <>
                    <div className="inspector-section-title">Montages</div>
                    <KeyValueList
                      rows={detail.mounts.map((m) => ({
                        key: m.destination,
                        value: `${m.source}${m.readOnly ? " (ro)" : ""}`,
                      }))}
                    />
                  </>
                )}

                {detail.env.length > 0 && (
                  <>
                    <div className="inspector-section-title">Variables d'environnement</div>
                    <KeyValueList
                      rows={detail.env.map((e) => {
                        const eq = e.indexOf("=");
                        return { key: eq >= 0 ? e.slice(0, eq) : e, value: eq >= 0 ? e.slice(eq + 1) : "" };
                      })}
                    />
                  </>
                )}
              </>
            )}
          </>
        )}
      </Inspector>

      <ContainerConsole
        containerId={consoleTarget?.id ?? null}
        containerName={consoleTarget?.name ?? ""}
        onClose={() => setConsoleTarget(null)}
      />

      <ContainerLogs
        containerId={logsTarget?.id ?? null}
        containerName={logsTarget?.name ?? ""}
        onClose={() => setLogsTarget(null)}
      />
    </div>
  );
}
