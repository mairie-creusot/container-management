import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { apiUrl } from "@/api/client";
import { createRoute, deleteRoute, fetchCaddyStatus, fetchRoutes, resyncRouteDns } from "@/features/reverseProxy/reverseProxySlice";
import type { CreatedRoute } from "@/features/reverseProxy/reverseProxySlice";
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

/** Port déduit du conteneur réel faute de saisie (voir ReverseProxyRoute#portDetection) — explique
 * POURQUOI ce port a été retenu, pour que l'utilisateur puisse recréer la route avec un autre. */
function portDetectionHint(route: ReverseProxyRoute): string | null {
  const detection = route.portDetection;
  if (!detection) return null;
  const origin = detection.source === "exposed" ? "exposés par le conteneur" : "publiés par le conteneur";
  if (detection.rule === "single") return `Port ${route.targetPort} détecté automatiquement (seul port TCP du conteneur).`;
  if (detection.rule === "preferred") {
    return `Port ${route.targetPort} détecté automatiquement parmi les ports ${origin} (${detection.candidates.join(", ")}) — port HTTP usuel prioritaire.`;
  }
  return `Port ${route.targetPort} détecté automatiquement parmi les ports ${origin} (${detection.candidates.join(", ")}) — aucun port HTTP usuel, le plus petit a été retenu.`;
}

/** Message affiché après création : le port RÉELLEMENT retenu, et l'état du certificat AD CS. */
function createdRouteSummary(route: CreatedRoute): string {
  const detail = portDetectionHint(route);
  const port = detail ?? `Port ${route.targetPort} (saisi).`;
  const certificate =
    route.certificate?.status === "issued"
      ? " Certificat AD CS émis pour ce sous-domaine."
      : route.certificate?.status === "already-valid"
        ? " Certificat AD CS déjà valide pour ce sous-domaine."
        : route.certificate?.status === "failed"
          ? ` Émission du certificat AD CS échouée (${route.certificate.message ?? "raison inconnue"}) — la route reste active avec le certificat interne de Caddy, un nouvel essai aura lieu automatiquement.`
          : "";
  return `Route "${route.subdomain}" créée. ${port}${certificate}`;
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
  /** Résultat de la DERNIÈRE création réussie (port réellement retenu + certificat) — jamais un
   * résumé inventé : construit à partir de la route renvoyée par l'API. */
  const [createdSummary, setCreatedSummary] = useState<string | null>(null);

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

  /** `clearFeedback` false après une création réussie : le message de résultat (port retenu,
   * certificat, échec de push Caddy) doit survivre à la fermeture du formulaire. */
  function resetForm(clearFeedback = true) {
    setShowForm(false);
    setTargetMode("container");
    setForm({ subdomain: "", targetContainerId: "", targetHost: "", targetPort: "" });
    if (clearFeedback) {
      setCreateError(null);
      setCreatedSummary(null);
    }
  }

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    const subdomain = form.subdomain.trim();
    // Port facultatif pour un conteneur (déduit du conteneur réel côté API) ; toujours requis pour
    // une cible host:port arbitraire, qui n'est pas inspectable.
    const rawPort = form.targetPort.trim();
    const targetPort = rawPort ? Number(rawPort) : undefined;
    if (!subdomain) return;
    if (targetPort !== undefined && (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535)) return;
    if (targetMode === "container" && !form.targetContainerId) return;
    if (targetMode === "manual" && (!form.targetHost.trim() || targetPort === undefined)) return;

    setCreateError(null);
    setCreatedSummary(null);
    dispatch(
      createRoute({
        subdomain,
        ...(targetPort !== undefined ? { targetPort } : {}),
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
        setCreatedSummary(createdRouteSummary(action.payload));
        resetForm(false);
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
              <label htmlFor="route-port">
                {targetMode === "container" ? "Port cible (laisser vide pour détecter automatiquement)" : "Port cible"}
              </label>
              <input
                id="route-port"
                type="number"
                min={1}
                max={65535}
                value={form.targetPort}
                onChange={(event) => setForm((f) => ({ ...f, targetPort: event.target.value }))}
                placeholder={targetMode === "container" ? "laisser vide : détecté sur le conteneur" : "ex : 8080"}
                disabled={creating}
                required={targetMode === "manual"}
              />
              {targetMode === "container" && (
                <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                  Vide : QUAI inspecte le conteneur et retient son seul port TCP exposé, ou — s'il y en a plusieurs —
                  le premier des ports HTTP usuels (80, 8080, 8000, 3000, 5000), sinon le plus petit. Aucun port
                  exposé : la création échoue explicitement, jamais un port inventé.
                </span>
              )}
            </div>

            {createError && <p className="graph-popover__error">{createError}</p>}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={
                  creating ||
                  !form.subdomain.trim() ||
                  (targetMode === "container" ? !form.targetContainerId : !form.targetHost.trim() || !form.targetPort.trim())
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

        {createdSummary && !showForm && (
          <div className="card" style={{ marginBottom: 16, fontSize: 13 }}>
            {createdSummary}
          </div>
        )}
        {createError && !showForm && <div className="error-banner">{createError}</div>}
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
                    <td className="cell-mono" {...(portDetectionHint(route) ? { title: portDetectionHint(route)! } : {})}>
                      {targetLabel(route, containerNameById)}
                      {route.portDetection && (
                        <span style={{ marginLeft: 6, fontSize: 11.5, color: "var(--color-text-muted)" }}>port auto</span>
                      )}
                    </td>
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
