import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { apiUrl } from "@/api/client";
import { createRoute, deleteRoute, fetchCaddyStatus, fetchRoutes, resyncRouteDns } from "@/features/reverseProxy/reverseProxySlice";
import { fetchContainers } from "@/features/containers/containersSlice";
import { canOperate } from "@/features/auth/authSlice";
import { setUnsavedFormActive } from "@/features/ui/uiSlice";
import { useConfirm } from "@/components/ConfirmProvider";
import { SkeletonTable } from "@/components/Skeleton";
import StatusPill from "@/components/StatusPill";
import { IconPlus, IconRestart, IconTrash } from "@/components/icons";
import type { ReverseProxyRoute } from "@/types";

type TargetMode = "container" | "manual";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function targetLabel(route: ReverseProxyRoute, containerNameById: Map<string, string>): string {
  if (route.targetContainerId) {
    return `${containerNameById.get(route.targetContainerId) ?? route.targetContainerId.slice(0, 12)} : ${route.targetPort}`;
  }
  return `${route.targetHost} : ${route.targetPort}`;
}

/** Statut DNS AD de la route (voir services/adDns.ts côté API) — absent = intégration jamais
 * configurée, résolution manuelle (fichier hosts/DNS interne) toujours nécessaire pour ce
 * sous-domaine. */
function dnsStatusPill(route: ReverseProxyRoute) {
  if (!route.dnsSync) {
    return <StatusPill status="unconfigured" label="DNS manuel" />;
  }
  if (route.dnsSync.status === "synced") {
    return <StatusPill status="ok" label="DNS synchronisé" />;
  }
  return <StatusPill status="crit" label="Échec DNS" />;
}

export default function ReverseProxyPage() {
  const dispatch = useAppDispatch();
  const { items, status, error, creating, caddyStatus, caddyStatusLoading, resyncingId } = useAppSelector(
    (s) => s.reverseProxy,
  );
  const containers = useAppSelector((s) => s.containers.items);
  const searchQuery = useAppSelector((s) => s.ui.searchQuery);
  const session = useAppSelector((s) => s.auth.session);
  const confirm = useConfirm();
  const operator = canOperate(session);

  const runningContainers = containers.filter((c) => c.state === "running");
  const containerNameById = new Map(containers.map((c) => [c.id, c.name]));

  const [showForm, setShowForm] = useState(false);
  const [targetMode, setTargetMode] = useState<TargetMode>("container");
  const [form, setForm] = useState({ subdomain: "", targetContainerId: "", targetHost: "", targetPort: "" });
  const [createError, setCreateError] = useState<string | null>(null);

  const isDirty = showForm && form.subdomain.trim() !== "";

  useEffect(() => {
    dispatch(fetchRoutes());
    dispatch(fetchCaddyStatus());
    // Toujours le démon local ici (le reverse proxy interne ne cible que des conteneurs gérés
    // localement par QUAI, voir ARCHITECTURE.md § "Reverse proxy interne").
    dispatch(fetchContainers(null));
  }, [dispatch]);

  useEffect(() => {
    dispatch(setUnsavedFormActive(isDirty));
  }, [dispatch, isDirty]);
  useEffect(() => {
    return () => {
      dispatch(setUnsavedFormActive(false));
    };
  }, [dispatch]);

  const visible = items.filter(
    (route) => !searchQuery || route.subdomain.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  function resetForm() {
    setShowForm(false);
    setTargetMode("container");
    setForm({ subdomain: "", targetContainerId: "", targetHost: "", targetPort: "" });
    setCreateError(null);
  }

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    const subdomain = form.subdomain.trim();
    const targetPort = Number(form.targetPort);
    if (!subdomain || !Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) return;
    if (targetMode === "container" && !form.targetContainerId) return;
    if (targetMode === "manual" && !form.targetHost.trim()) return;

    setCreateError(null);
    dispatch(
      createRoute({
        subdomain,
        targetPort,
        ...(targetMode === "container"
          ? { targetContainerId: form.targetContainerId }
          : { targetHost: form.targetHost.trim() }),
      }),
    ).then((action) => {
      if (createRoute.fulfilled.match(action)) {
        if (action.payload.caddyPushError) {
          setCreateError(
            `Route créée mais pas encore active sur Caddy : ${action.payload.caddyPushError}. Réessayez le push depuis le statut ci-dessus une fois Caddy joignable.`,
          );
        }
        resetForm();
        dispatch(fetchCaddyStatus());
      } else {
        setCreateError(action.payload ?? "Impossible de créer cette route.");
      }
    });
  }

  async function handleCancelForm() {
    if (isDirty) {
      const ok = await confirm({
        title: "Abandonner cette route ?",
        description: "Les informations saisies pour cette route n'ont pas été enregistrées.",
        confirmLabel: "Abandonner les modifications",
        variant: "danger",
      });
      if (!ok) return;
    }
    resetForm();
  }

  async function handleDelete(route: ReverseProxyRoute) {
    const ok = await confirm({
      title: "Supprimer cette route",
      description: `Confirmer la suppression de la route "${route.subdomain}" ? Cette action est irréversible.`,
      confirmLabel: "Supprimer",
      variant: "danger",
    });
    if (!ok) return;
    dispatch(deleteRoute(route.id));
  }

  function handleResyncDns(route: ReverseProxyRoute) {
    dispatch(resyncRouteDns(route.id));
  }

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Reverse proxy</h2>
            <p>
              Expose un conteneur QUAI (ou un host:port arbitraire) sous un sous-domaine interne via Caddy, piloté en
              direct par son API d'administration — aucun redémarrage, aucun fichier de configuration à écrire.
            </p>
          </div>
          {operator && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => (showForm ? handleCancelForm() : setShowForm(true))}
            >
              <IconPlus /> {showForm ? "Annuler" : "Nouvelle route"}
            </button>
          )}
        </div>

        <div className="card" style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span
            className={`status-pill ${caddyStatus?.reachable ? "status-pill--success" : "status-pill--critical"}`}
          >
            {caddyStatusLoading ? "Vérification…" : caddyStatus?.reachable ? "Caddy joignable" : "Caddy injoignable"}
          </span>
          {caddyStatus?.httpsEnabled && <span className="status-pill status-pill--success">HTTPS actif (:443)</span>}
          <span style={{ fontSize: 12.5, color: "var(--color-text-muted)" }}>
            {caddyStatus?.adminUrl ?? "http://caddy:2019"} — API d'administration JSON, jamais exposée en dehors du
            réseau docker-compose.
          </span>
          {caddyStatus?.httpsEnabled && (
            <a
              href={apiUrl("/reverse-proxy/ca-certificate")}
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: "auto" }}
              download
            >
              Télécharger le certificat racine (.pem)
            </a>
          )}
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--color-text-muted)" }}>
            <strong style={{ color: "var(--color-text)" }}>Important — résolution DNS non prise en charge ici :</strong>{" "}
            un sous-domaine (ex : <code>monapp.lecreusot.priv</code>) doit ensuite être résolu vers l'hôte Docker qui
            exécute Caddy par le DNS interne de la mairie ou une entrée de fichier hosts — cette page ne fait que
            configurer le routage une fois la requête arrivée, elle ne peut pas garantir cette résolution externe.
          </p>
          <p style={{ margin: "10px 0 0", fontSize: 13, color: "var(--color-text-muted)" }}>
            <strong style={{ color: "var(--color-text)" }}>HTTPS (:443)</strong> : Caddy sert désormais aussi en
            HTTPS, avec des certificats émis par sa propre autorité interne (jamais ACME/Let's Encrypt — ces noms ne
            sont pas résolubles publiquement). Le navigateur affichera un avertissement "connexion non sécurisée"
            tant que le certificat racine ci-dessus n'a pas été installé manuellement comme autorité de confiance sur
            le poste (une fois). Le port 80 (HTTP) reste servi en parallèle, sans redirection forcée.
          </p>
        </div>

        {showForm && operator && (
          <form className="card" style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 12 }} onSubmit={handleCreate}>
            <div className="field">
              <label htmlFor="route-subdomain">Sous-domaine</label>
              <input
                id="route-subdomain"
                value={form.subdomain}
                onChange={(event) => setForm((f) => ({ ...f, subdomain: event.target.value }))}
                placeholder="ex : monapp.lecreusot.priv"
                disabled={creating}
                autoFocus
                required
              />
            </div>

            <div className="field">
              <label>Cible</label>
              <div style={{ display: "flex", gap: 16, fontSize: 13.5 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400 }}>
                  <input
                    type="radio"
                    name="target-mode"
                    checked={targetMode === "container"}
                    onChange={() => setTargetMode("container")}
                    disabled={creating}
                  />
                  Conteneur en cours d'exécution
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400 }}>
                  <input
                    type="radio"
                    name="target-mode"
                    checked={targetMode === "manual"}
                    onChange={() => setTargetMode("manual")}
                    disabled={creating}
                  />
                  Host:port manuel
                </label>
              </div>
            </div>

            {targetMode === "container" ? (
              <div className="field">
                <label htmlFor="route-container">Conteneur</label>
                <select
                  id="route-container"
                  value={form.targetContainerId}
                  onChange={(event) => setForm((f) => ({ ...f, targetContainerId: event.target.value }))}
                  disabled={creating}
                  required
                >
                  <option value="">— sélectionner —</option>
                  {runningContainers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.image})
                    </option>
                  ))}
                </select>
                {runningContainers.length === 0 && (
                  <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                    Aucun conteneur en cours d'exécution connu de QUAI.
                  </span>
                )}
              </div>
            ) : (
              <div className="field">
                <label htmlFor="route-host">Host</label>
                <input
                  id="route-host"
                  value={form.targetHost}
                  onChange={(event) => setForm((f) => ({ ...f, targetHost: event.target.value }))}
                  placeholder="ex : 10.20.0.15 ou service.interne"
                  disabled={creating}
                  required
                />
              </div>
            )}

            <div className="field">
              <label htmlFor="route-port">Port cible</label>
              <input
                id="route-port"
                type="number"
                min={1}
                max={65535}
                value={form.targetPort}
                onChange={(event) => setForm((f) => ({ ...f, targetPort: event.target.value }))}
                placeholder="ex : 8080"
                disabled={creating}
                required
              />
            </div>

            {createError && <p className="graph-popover__error">{createError}</p>}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={
                  creating ||
                  !form.subdomain.trim() ||
                  !form.targetPort ||
                  (targetMode === "container" ? !form.targetContainerId : !form.targetHost.trim())
                }
              >
                {creating ? "Création…" : "Créer"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={handleCancelForm}>
                Annuler
              </button>
            </div>
          </form>
        )}

        {error && <div className="error-banner">{error}</div>}
        {status === "loading" && items.length === 0 && (
          <SkeletonTable columns={["Sous-domaine", "Cible", "Créée le", ""]} rows={6} />
        )}
        {status !== "loading" && items.length === 0 && !error && (
          <div className="empty-state">Aucune route configurée.</div>
        )}
        {status !== "loading" && items.length > 0 && visible.length === 0 && !error && (
          <div className="empty-state">Aucune route ne correspond aux critères.</div>
        )}

        {visible.length > 0 && (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Sous-domaine</th>
                  <th>Cible</th>
                  <th>DNS</th>
                  <th>Créée le</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((route) => (
                  <tr key={route.id}>
                    <td className="cell-primary cell-mono">{route.subdomain}</td>
                    <td className="cell-mono">{targetLabel(route, containerNameById)}</td>
                    <td {...(route.dnsSync?.message ? { title: route.dnsSync.message } : {})}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {dnsStatusPill(route)}
                        {operator && (
                          <button
                            type="button"
                            className="icon-btn"
                            title="Retester la synchronisation DNS (nsupdate, sans recréer la route)"
                            aria-label="Retester la synchronisation DNS"
                            disabled={resyncingId === route.id}
                            onClick={() => handleResyncDns(route)}
                          >
                            <IconRestart {...(resyncingId === route.id ? { className: "icon-spin" } : {})} />
                          </button>
                        )}
                      </div>
                    </td>
                    <td>{formatDate(route.createdAt)}</td>
                    <td className="cell-actions">
                      {operator && (
                        <div className="row-actions">
                          <button
                            type="button"
                            className="icon-btn icon-btn--danger"
                            title="Supprimer"
                            aria-label="Supprimer"
                            onClick={() => handleDelete(route)}
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
      </div>
    </div>
  );
}
