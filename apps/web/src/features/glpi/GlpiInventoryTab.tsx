import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { canOperate } from "@/features/auth/authSlice";
import { IconCheck, IconInfo } from "@/components/icons";
import {
  alignGlpiComputer,
  clearGlpiInventoryFeedback,
  createGlpiComputer,
  fetchGlpiInventoryDiff,
  selectGlpiState,
} from "@/features/glpi/glpiSlice";
import { MISSING, fieldLabel, formatDateTime, formatInventoryValue, resourceKindLabel } from "@/features/glpi/format";
import type {
  GlpiEnrichmentState,
  GlpiInventoryDiff,
  GlpiMatchedPair,
  GlpiRealResource,
  GlpiStaleRecord,
} from "@/features/glpi/types";

function CountTile({ label, value, hint }: { label: string; value: number; hint?: string | undefined }) {
  return (
    <div className="glpi-tile">
      <span className="glpi-tile__label">{label}</span>
      <span className="glpi-tile__value">{value}</span>
      {hint && <span className="glpi-tile__hint">{hint}</span>}
    </div>
  );
}

function resourceIdentity(resource: GlpiRealResource): string {
  const parts = [resourceKindLabel(resource.kind)];
  if (resource.uuid) parts.push(`UUID ${resource.uuid}`);
  else parts.push(`identifiant ${resource.id}`);
  if (resource.cluster) parts.push(`cluster ${resource.cluster}`);
  if (resource.hostName) parts.push(`hôte ${resource.hostName}`);
  return parts.join(" · ");
}

const ENRICHMENT_LABELS: Record<string, string> = {
  virtualMachines: "liens de virtualisation (vCPU, mémoire, hôte)",
  ipAddresses: "adresses IP",
  operatingSystems: "systèmes d'exploitation",
};

function unavailableEnrichments(enrichment: GlpiInventoryDiff["enrichment"]): string[] {
  return Object.entries(enrichment)
    .filter(([, state]) => (state as GlpiEnrichmentState) === "unavailable")
    .map(([key]) => ENRICHMENT_LABELS[key] ?? key);
}

function MissingCard({ resource }: { resource: GlpiRealResource }) {
  const dispatch = useAppDispatch();
  const { inventoryActionKey } = useAppSelector(selectGlpiState);
  const session = useAppSelector((s) => s.auth.session);
  const operator = canOperate(session);
  const busy = inventoryActionKey === `create:${resource.id}`;

  return (
    <div className="glpi-item">
      <div className="glpi-item__head">
        <strong className="glpi-item__title">{resource.name}</strong>
        {operator ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void dispatch(createGlpiComputer(resource.id))}
            disabled={busy}
          >
            {busy ? "Création…" : "Créer la fiche"}
          </button>
        ) : (
          <span className="glpi-item__denied">Création réservée aux rôles opérateur et administrateur</span>
        )}
      </div>
      <span className="glpi-item__meta">{resourceIdentity(resource)}</span>
    </div>
  );
}

function DriftCard({ pair }: { pair: GlpiMatchedPair }) {
  const dispatch = useAppDispatch();
  const { inventoryActionKey } = useAppSelector(selectGlpiState);
  const session = useAppSelector((s) => s.auth.session);
  const operator = canOperate(session);
  const busy = inventoryActionKey === `align:${pair.glpi.id}`;
  const fixable = pair.differences.filter((difference) => difference.fixable);

  return (
    <div className="glpi-item">
      <div className="glpi-item__head">
        <strong className="glpi-item__title">
          {pair.resource.name} ↔ fiche GLPI #{pair.glpi.id}
        </strong>
        {fixable.length === 0 ? (
          <span className="glpi-item__denied">
            Aucun de ces écarts n'est corrigeable par l'API : ils ne sont pas portés par l'objet Computer de GLPI.
          </span>
        ) : operator ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() =>
              void dispatch(
                alignGlpiComputer({
                  computerId: pair.glpi.id,
                  resourceId: pair.resource.id,
                  fields: fixable.map((difference) => difference.field),
                }),
              )
            }
            disabled={busy}
          >
            {busy ? "Alignement…" : `Aligner les champs (${fixable.length})`}
          </button>
        ) : (
          <span className="glpi-item__denied">Alignement réservé aux rôles opérateur et administrateur</span>
        )}
      </div>
      <span className="glpi-item__meta">
        {resourceIdentity(pair.resource)} · rapproché par {pair.matchedBy}
      </span>

      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Champ</th>
              <th>Valeur dans GLPI</th>
              <th>Valeur réelle</th>
              <th>Correction</th>
            </tr>
          </thead>
          <tbody>
            {pair.differences.map((difference) => (
              <tr key={difference.field}>
                <td>{fieldLabel(difference.field)}</td>
                <td className="cell-mono">{formatInventoryValue(difference.glpiValue)}</td>
                <td className="cell-mono">{formatInventoryValue(difference.realValue)}</td>
                <td>
                  {difference.fixable ? (
                    "Corrigeable par l'API"
                  ) : (
                    <span className="glpi-item__denied">
                      Non corrigeable{difference.reason ? ` — ${difference.reason}` : ""}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StaleCard({ record }: { record: GlpiStaleRecord }) {
  return (
    <div className="glpi-item">
      <div className="glpi-item__head">
        <strong className="glpi-item__title">
          Fiche GLPI #{record.glpi.id} — {record.glpi.name || MISSING}
        </strong>
      </div>
      <span className="glpi-item__meta">{record.detail}</span>
      <span className="glpi-item__meta">
        {record.scopeReason === "provenance-marker"
          ? "Périmètre prouvé par le marqueur de provenance écrit par QUAI."
          : "Périmètre prouvé par le lien de virtualisation GLPI vers un hôte Nutanix réel."}
      </span>
    </div>
  );
}

export default function GlpiInventoryTab() {
  const dispatch = useAppDispatch();
  const {
    inventory,
    inventoryLoad,
    inventoryError,
    inventoryActionError,
    inventoryActionMessage,
    backendUnavailable,
  } = useAppSelector(selectGlpiState);

  useEffect(() => {
    if (inventoryLoad === "idle") dispatch(fetchGlpiInventoryDiff());
  }, [dispatch, inventoryLoad]);

  if (backendUnavailable) return null;

  if (inventoryError) return <div className="error-banner">{inventoryError}</div>;

  if (inventoryLoad === "loading" && !inventory) {
    return <div className="empty-state">Comparaison de l'inventaire réel et de la CMDB GLPI…</div>;
  }

  if (!inventory) return null;

  const enrichmentGaps = unavailableEnrichments(inventory.enrichment);

  return (
    <>
      {inventoryActionMessage && (
        <div className="success-banner" style={{ marginBottom: 16 }}>
          <IconCheck />
          {inventoryActionMessage}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => dispatch(clearGlpiInventoryFeedback())}
            style={{ marginLeft: "auto" }}
          >
            Masquer
          </button>
        </div>
      )}

      {inventoryActionError && (
        <div className="error-banner" style={{ marginBottom: 16 }}>
          {inventoryActionError}
        </div>
      )}

      {!inventory.conclusive && (
        <div className="empty-state">
          <IconInfo />
          <strong>Diagnostic non concluant — aucune liste n'est affichée</strong>
          <span>
            La comparaison n'a pas pu être menée jusqu'au bout : sans les deux inventaires lus réellement, toute
            fiche GLPI paraîtrait obsolète et toute ressource manquante.
          </span>
          <span>
            GLPI : {inventory.glpi.configured ? "configuré" : "non configuré"},{" "}
            {inventory.glpi.reachable ? "joignable" : "injoignable"}
            {inventory.glpi.error ? ` — ${inventory.glpi.error}` : ""}.
          </span>
          <span>
            Inventaire réel (Nutanix) : {inventory.nutanix.configured ? "configuré" : "non configuré"},{" "}
            {inventory.nutanix.reachable ? "joignable" : "injoignable"} — {inventory.nutanix.resourceCount} ressources
            lues.
          </span>
        </div>
      )}

      {inventory.conclusive && (
        <>
          <div className="glpi-tiles">
            <CountTile label="Ressources réelles" value={inventory.counts.real} hint="VM et hôtes connus de QUAI" />
            <CountTile label="Fiches GLPI lues" value={inventory.counts.glpiComputers} hint="objets Computer" />
            <CountTile label="Conformes" value={inventory.counts.inSync} hint="aucun écart de champ" />
            <CountTile label="Dérives" value={inventory.counts.drifted} hint="au moins un champ divergent" />
            <CountTile label="Manquants dans GLPI" value={inventory.counts.missingInGlpi} hint="aucune fiche" />
            <CountTile label="Fiches obsolètes" value={inventory.counts.staleInGlpi} hint="plus de ressource réelle" />
            <CountTile label="Rapprochements ambigus" value={inventory.counts.ambiguous} hint="aucun appariement" />
            <CountTile
              label="Hors périmètre"
              value={inventory.counts.outOfScopeGlpi}
              hint="fiches GLPI non rattachables à QUAI"
            />
          </div>

          {enrichmentGaps.length > 0 && (
            <p className="glpi-note">
              Enrichissements GLPI non lisibles sur cette instance : {enrichmentGaps.join(", ")}. Les champs
              correspondants sont considérés comme absents, jamais comme des écarts.
            </p>
          )}

          <h3 className="glpi-section-title">Ressources réelles absentes de GLPI ({inventory.missingInGlpi.length})</h3>
          {inventory.missingInGlpi.length === 0 ? (
            <p className="glpi-note">Toutes les ressources réelles ont une fiche GLPI rapprochée.</p>
          ) : (
            <div className="glpi-items">
              {inventory.missingInGlpi.map((resource) => (
                <MissingCard key={resource.id} resource={resource} />
              ))}
            </div>
          )}

          <h3 className="glpi-section-title">Dérives champ par champ ({inventory.drifted.length})</h3>
          {inventory.drifted.length === 0 ? (
            <p className="glpi-note">Aucune fiche rapprochée ne diverge du réel.</p>
          ) : (
            <div className="glpi-items">
              {inventory.drifted.map((pair) => (
                <DriftCard key={`${pair.resource.id}-${pair.glpi.id}`} pair={pair} />
              ))}
            </div>
          )}

          <h3 className="glpi-section-title">Fiches GLPI obsolètes ({inventory.staleInGlpi.length})</h3>
          <p className="glpi-note">
            QUAI ne supprime jamais une fiche GLPI : elles sont signalées ici, la décision reste humaine.
          </p>
          {inventory.staleInGlpi.length > 0 && (
            <div className="glpi-items">
              {inventory.staleInGlpi.map((record) => (
                <StaleCard key={record.glpi.id} record={record} />
              ))}
            </div>
          )}

          {inventory.ambiguous.length > 0 && (
            <>
              <h3 className="glpi-section-title">Rapprochements ambigus ({inventory.ambiguous.length})</h3>
              <div className="glpi-items">
                {inventory.ambiguous.map((item, index) => (
                  <div className="glpi-item" key={`${item.resource?.id ?? "sans-ressource"}-${index}`}>
                    <div className="glpi-item__head">
                      <strong className="glpi-item__title">{item.resource?.name ?? "Ressource non identifiée"}</strong>
                    </div>
                    <span className="glpi-item__meta">{item.reason}</span>
                    {item.glpiCandidates.length > 0 && (
                      <span className="glpi-item__meta">
                        Fiches GLPI candidates :{" "}
                        {item.glpiCandidates.map((candidate) => `#${candidate.id} ${candidate.name}`).join(" · ")}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          <p className="glpi-poll">
            Réconciliation calculée le {formatDateTime(inventory.generatedAt)}.
          </p>
        </>
      )}
    </>
  );
}
