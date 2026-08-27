import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, apiGet } from "@/api/client";

/** Miroir de WindowsServicesOutcome (apps/api/src/services/windowsServices.ts). */
interface WindowsService {
  name: string;
  displayName: string;
  status: "running" | "stopped" | "unknown";
  startMode: string;
  account: string;
  description: string;
}

type Outcome =
  | { status: "ready"; host: string; services: WindowsService[]; truncated: boolean }
  | { status: "no-ticket" | "unreachable" | "denied" | "failed"; host: string; message: string };

const STATUS_LABEL: Record<WindowsService["status"], string> = {
  running: "En cours",
  stopped: "Arrêté",
  unknown: "Transitoire",
};

/**
 * Services RÉELS d'un Windows Server, lus par WinRM sous l'identité de la personne connectée.
 *
 * Ce panneau n'affiche jamais une liste vide en guise d'échec : sans ticket, machine injoignable,
 * certificat non validé ou droits insuffisants, c'est l'état exact qui s'affiche, avec le message du
 * serveur. Un écran de consultation ne doit pas laisser croire qu'une machine n'a aucun service.
 *
 * LECTURE SEULE dans ce lot — démarrer ou arrêter un service est une mutation sur une machine de
 * production, elle viendra avec sa confirmation et sa trace.
 */
export default function WindowsServicesPanel({ host }: { host: string }) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOutcome(await apiGet<Outcome>(`/windows/services?host=${encodeURIComponent(host)}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Impossible d'interroger cette machine.");
    } finally {
      setLoading(false);
    }
  }, [host]);

  useEffect(() => {
    void load();
  }, [load]);

  const services = outcome?.status === "ready" ? outcome.services : [];
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return services;
    return services.filter((service) =>
      `${service.displayName} ${service.name} ${service.account} ${service.description}`.toLowerCase().includes(needle),
    );
  }, [services, query]);

  const running = services.filter((service) => service.status === "running").length;

  return (
    <div className="windows-services">
      <div className="windows-services__head">
        <div>
          <strong>Services de {host}</strong>
          <p className="create-container-hint" style={{ margin: "2px 0 0" }}>
            Lus sur la machine par WinRM, sous votre propre compte : vous voyez ce que vos droits Windows vous
            permettent de voir, ni plus ni moins. Lecture seule.
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading}>
          {loading ? "Lecture…" : "Actualiser"}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {outcome && outcome.status !== "ready" && (
        <div className={`topology-subgraph-panel__note${outcome.status === "denied" ? " is-denied" : ""}`}>
          {outcome.message}
        </div>
      )}

      {outcome?.status === "ready" && (
        <>
          <div className="windows-services__toolbar">
            <input
              type="search"
              placeholder="Rechercher un service…"
              aria-label="Rechercher un service"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <span className="windows-services__count">
              {running} en cours sur {services.length}
              {query.trim().length > 0 && ` · ${visible.length} affiché${visible.length > 1 ? "s" : ""}`}
            </span>
          </div>

          {outcome.truncated && (
            <div className="topology-subgraph-panel__note">
              La machine a renvoyé plus de services que QUAI n'en tire en une fois : cette liste est partielle, et le
              dit plutôt que de se présenter comme complète.
            </div>
          )}

          {services.length === 0 ? (
            <div className="empty-state">Cette machine ne rapporte aucun service.</div>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>État</th>
                    <th>Démarrage</th>
                    <th>Compte</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((service) => (
                    <tr key={service.name}>
                      <td>
                        <span className="cell-primary">{service.displayName}</span>
                        <span className="windows-services__name">{service.name}</span>
                      </td>
                      <td>
                        <span
                          className={`chip ${service.status === "running" ? "chip--accent" : service.status === "stopped" ? "" : "chip--warn"}`}
                        >
                          {STATUS_LABEL[service.status]}
                        </span>
                      </td>
                      <td>{service.startMode || "—"}</td>
                      <td className="cell-mono">{service.account || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {loading && !outcome && <div className="empty-state">Interrogation de {host}…</div>}
    </div>
  );
}
