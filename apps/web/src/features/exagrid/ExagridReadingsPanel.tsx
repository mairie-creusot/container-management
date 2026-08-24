import {
  MISSING,
  ageSeverityClass,
  formatAge,
  formatBytes,
  formatPercent,
  usageSeverityClass,
} from "@/features/exagrid/exagridFormat";
import type { ExagridAlarm, ExagridCapacityZone, ExagridStatusSummary } from "@/types";

export function ExagridMeter({ label, zone }: { label: string; zone?: ExagridCapacityZone | undefined }) {
  const percent = zone?.usedPct;
  const known = percent !== undefined && Number.isFinite(percent);
  const clamped = known ? Math.max(0, Math.min(100, percent)) : 0;
  const foot =
    zone?.configuredBytes === undefined && zone?.availableBytes === undefined
      ? "Volumes non communiqués par la MIB"
      : `${formatBytes(zone?.availableBytes)} disponibles sur ${formatBytes(zone?.configuredBytes)}`;
  return (
    <div className="exagrid-meter">
      <div className="exagrid-meter__head">
        <span className="exagrid-meter__label">{label}</span>
        <span className={`exagrid-meter__value${known ? "" : " is-missing"}`}>{formatPercent(percent)}</span>
      </div>
      {known && (
        <div className="exagrid-meter__track">
          <div className={`exagrid-meter__fill${usageSeverityClass(percent)}`} style={{ width: `${clamped}%` }} />
        </div>
      )}
      <span className="exagrid-meter__foot">{foot}</span>
      {zone?.usedBytes !== undefined && <span className="exagrid-meter__foot">{formatBytes(zone.usedBytes)} occupés</span>}
    </div>
  );
}

export function ExagridTile({
  label,
  value,
  hint,
  hintClass,
  title,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
  hintClass?: string | undefined;
  title?: string | undefined;
}) {
  return (
    <div className="exagrid-tile" {...(title ? { title } : {})}>
      <span className="exagrid-tile__label">{label}</span>
      <span className={`exagrid-tile__value${value === MISSING ? " is-missing" : ""}`}>{value}</span>
      {hint && <span className={`exagrid-tile__hint${hintClass ?? ""}`}>{hint}</span>}
    </div>
  );
}

const ALARM_TEXT = {
  ok: { className: "is-ok", title: "Aucune alarme", text: "L'appliance signale un fonctionnement normal." },
  warning: {
    className: "is-warning",
    title: "Avertissement",
    text: "L'appliance signale une alarme d'avertissement — consultez son interface d'administration.",
  },
  error: {
    className: "is-error",
    title: "Alarme critique",
    text: "L'appliance signale une alarme en erreur — intervention requise sur l'appliance.",
  },
} as const;

export function ExagridAlarmBanner({ alarm }: { alarm?: ExagridAlarm | undefined }) {
  if (!alarm) return null;
  // `state` absent = valeur d'alarme hors des trois codes de la MIB : annoncée comme non
  // interprétée plutôt que rattachée arbitrairement à un niveau.
  const meta = alarm.state
    ? ALARM_TEXT[alarm.state]
    : {
        className: "is-unknown",
        title: "État d'alarme non interprété",
        text: "L'appliance a renvoyé une valeur d'alarme hors des codes prévus par la MIB.",
      };
  const rawLabel = alarm.raw !== undefined ? `Valeur brute SNMP : ${alarm.raw}` : undefined;
  return (
    <div className={`exagrid-alarm ${meta.className}`} {...(rawLabel ? { title: rawLabel } : {})}>
      <span className="exagrid-alarm__dot" />
      <div className="exagrid-alarm__body">
        <strong className="exagrid-alarm__title">{meta.title}</strong>
        <span className="exagrid-alarm__text">{meta.text}</span>
      </div>
      {!alarm.state && alarm.raw !== undefined && <span className="exagrid-alarm__raw">{alarm.raw}</span>}
    </div>
  );
}

/** Relevés réels de l'appliance : occupation, volumes restaurables, files d'attente, alarme. */
export default function ExagridReadingsPanel({ status }: { status: ExagridStatusSummary }) {
  const readings = status.readings;
  return (
    <>
      <ExagridAlarmBanner {...(readings?.alarm ? { alarm: readings.alarm } : {})} />

      {!readings && (
        <div className="exagrid-note" style={{ marginTop: 12 }}>
          L'appliance répond mais aucune valeur de la MIB n'a été relevée lors du dernier poll.
        </div>
      )}

      <h4 className="exagrid-section-title">Occupation</h4>
      <div className="exagrid-meters">
        <ExagridMeter label="Zone d'atterrissage (landing)" zone={readings?.landing} />
        <ExagridMeter label="Zone de rétention" zone={readings?.retention} />
      </div>

      <h4 className="exagrid-section-title">Données de sauvegarde</h4>
      <div className="exagrid-tiles">
        <ExagridTile
          label="Disponibles pour restauration"
          value={formatBytes(readings?.backupData.availableForRestoreBytes)}
          hint="volume de sauvegardes restaurables"
        />
        <ExagridTile
          label="Consommées en rétention"
          value={formatBytes(readings?.backupData.retentionConsumedBytes)}
          hint="après déduplication et compression"
        />
      </div>

      <h4 className="exagrid-section-title">Files d'attente</h4>
      <div className="exagrid-tiles">
        <ExagridTile
          label="En attente de déduplication"
          value={formatBytes(readings?.pendingDeduplication.bytes)}
          hint={`Ancienneté : ${formatAge(readings?.pendingDeduplication.ageSeconds)}`}
          hintClass={ageSeverityClass(readings?.pendingDeduplication.ageSeconds)}
        />
        <ExagridTile
          label="En attente de réplication"
          value={formatBytes(readings?.pendingReplication.bytes)}
          hint={`Ancienneté : ${formatAge(readings?.pendingReplication.ageSeconds)}`}
          hintClass={ageSeverityClass(readings?.pendingReplication.ageSeconds)}
          title="Une ancienneté de réplication qui grandit signale un retard de copie hors site."
        />
      </div>

      {status.lastPoll && (
        <p className="exagrid-poll">
          Dernier relevé SNMP : {new Date(status.lastPoll.at).toLocaleString("fr-FR")}
          {status.lastPoll.reachable ? " — réussi" : " — échoué"}
        </p>
      )}
    </>
  );
}
