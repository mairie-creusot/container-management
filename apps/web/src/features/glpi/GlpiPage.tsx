import { useEffect, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { canAdminister } from "@/features/auth/authSlice";
import StatusPill from "@/components/StatusPill";
import { IconInfo } from "@/components/icons";
import {
  fetchGlpiBrowseTickets,
  fetchGlpiInventoryDiff,
  fetchGlpiMyTickets,
  fetchGlpiStatus,
  selectGlpiState,
  TICKETS_PAGE_SIZE,
} from "@/features/glpi/glpiSlice";
import GlpiConfigSection from "@/features/glpi/GlpiConfigSection";
import GlpiInventoryTab from "@/features/glpi/GlpiInventoryTab";
import GlpiTicketsTab from "@/features/glpi/GlpiTicketsTab";
import { formatDateTime } from "@/features/glpi/format";

type GlpiTab = "tickets" | "inventory";

const TABS: { id: GlpiTab; label: string }[] = [
  { id: "tickets", label: "Mes tickets" },
  { id: "inventory", label: "Inventaire" },
];

export default function GlpiPage() {
  const dispatch = useAppDispatch();
  const { status, statusLoad, statusError, backendUnavailable, configured, browseScope, browseAccount, browseOffset } =
    useAppSelector(selectGlpiState);
  const session = useAppSelector((s) => s.auth.session);
  const admin = canAdminister(session);
  const [activeTab, setActiveTab] = useState<GlpiTab>("tickets");

  useEffect(() => {
    if (statusLoad === "idle") dispatch(fetchGlpiStatus());
  }, [dispatch, statusLoad]);

  function handleRefresh() {
    dispatch(fetchGlpiStatus());
    if (activeTab === "inventory") {
      dispatch(fetchGlpiInventoryDiff());
      return;
    }
    // Le périmètre consulté commande ce qu'on relit : « Mes tickets » ne devient jamais implicite.
    if (browseScope === null) {
      dispatch(fetchGlpiMyTickets());
      return;
    }
    if (browseScope === "all" || browseAccount) {
      dispatch(
        fetchGlpiBrowseTickets({
          ...(browseAccount ? { requesterId: browseAccount.id } : {}),
          offset: browseOffset,
          limit: TICKETS_PAGE_SIZE,
        }),
      );
    }
  }

  const unreachable = configured && status?.reachable === false;
  const connectionPill = backendUnavailable
    ? { status: "unavailable", label: "Indisponible" }
    : statusLoad === "loading" && !status
      ? { status: "checking", label: "Vérification…" }
      : !configured
        ? { status: "unconfigured" }
        : unreachable
          ? { status: "crit", label: "Injoignable" }
          : status?.reachable === true
            ? { status: "connected" }
            : { status: "unknown", label: "État inconnu" };

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Assistance GLPI</h2>
            <p>
              Tickets dont vous êtes demandeur dans GLPI — et, pour les rôles opérateur et administrateur, ceux de
              n'importe quel autre compte GLPI en lecture seule. Plus la réconciliation entre l'inventaire réel connu
              de QUAI et la CMDB GLPI. QUAI n'affiche que ce que l'instance renvoie réellement.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <StatusPill {...connectionPill} />
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleRefresh}>
              Actualiser
            </button>
          </div>
        </div>

        {backendUnavailable && (
          <div className="empty-state">
            <IconInfo />
            <strong>Intégration GLPI indisponible</strong>
            <span>
              L'API QUAI ne répond pas sur les routes GLPI. Aucune donnée n'est affichée tant que l'instance n'est pas
              réellement interrogée.
            </span>
          </div>
        )}

        {!backendUnavailable && statusError && (
          <div className="error-banner" style={{ marginBottom: 16 }}>
            {statusError}
          </div>
        )}

        {!backendUnavailable && statusLoad === "loading" && !status && (
          <div className="empty-state">Vérification de l'accès à GLPI…</div>
        )}

        {!backendUnavailable && status && !configured && (
          <div className="empty-state">
            <IconInfo />
            <strong>GLPI n'est pas configuré</strong>
            {admin ? (
              <span>Renseignez l'accès à l'API GLPI dans la section Configuration ci-dessous.</span>
            ) : (
              <span>Seul un administrateur peut renseigner l'accès à l'API GLPI.</span>
            )}
          </div>
        )}

        {unreachable && (
          <div className="error-banner" style={{ marginBottom: 16 }}>
            GLPI est configuré mais n'a pas répondu
            {status?.lastPoll ? ` (dernier essai : ${formatDateTime(status.lastPoll.at)})` : ""}. Ni les tickets ni
            l'inventaire ne sont affichés tant que l'instance reste injoignable.
          </div>
        )}

        {!backendUnavailable && configured && status && (
          <p className="glpi-endpoint">
            {status.apiUrl ?? "URL non communiquée"}
            {status.authMode === "user-token" ? " · jeton utilisateur" : ""}
            {status.authMode === "credentials"
              ? ` · compte de service${status.serviceAccount ? ` ${status.serviceAccount}` : ""}`
              : ""}
            {status.lastPoll
              ? ` · dernier échange le ${formatDateTime(status.lastPoll.at)} (${status.lastPoll.reachable ? "réussi" : "échoué"})`
              : ""}
          </p>
        )}

        {!backendUnavailable && configured && (
          <>
            <div className="glpi-tabs">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`glpi-tab${activeTab === tab.id ? " is-active" : ""}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {activeTab === "tickets" && <GlpiTicketsTab />}
            {activeTab === "inventory" && <GlpiInventoryTab />}
          </>
        )}

        {admin && (
          <div style={{ marginTop: configured ? 32 : 0 }}>
            <GlpiConfigSection />
          </div>
        )}
      </div>
    </div>
  );
}
