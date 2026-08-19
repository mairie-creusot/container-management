import { useEffect, useState } from "react";
import {
  fetchBuildPlacement,
  fetchSubnetOptions,
  saveBuildPlacement,
  type BuildPlacement,
  type BuildPlacementState,
  type SubnetOption,
} from "./buildPlacementApi";

/** Cluster + VLAN de la VM temporaire créée sur Nutanix pendant un build Packer : réglés une fois
 * ici puis injectés à chaque build (plus besoin d'éditer template.pkr.hcl à la main). */
export default function BuildPlacementSettings({ busy }: { busy?: boolean }) {
  const [state, setState] = useState<BuildPlacementState | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [subnets, setSubnets] = useState<SubnetOption[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [placement, options] = await Promise.all([fetchBuildPlacement(), fetchSubnetOptions()]);
      if (cancelled) return;
      setSubnets(options);
      if (placement.outcome === "ok") {
        setState(placement.state);
        setStatus("ready");
      } else if (placement.outcome === "unavailable") {
        setStatus("unavailable");
      } else {
        setStatus("error");
        setMessage(placement.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function persist(next: BuildPlacement) {
    setSaving(true);
    const result = await saveBuildPlacement(next);
    setSaving(false);
    if (result.outcome === "ok") {
      setState(result.state);
      setMessage(null);
    } else if (result.outcome === "error") {
      setMessage(result.message);
    }
  }

  if (status === "loading" || status === "unavailable") return null;

  const resolved = state?.resolved ?? {};
  const disabled = busy || saving;
  const complete = Boolean(resolved.clusterName && resolved.subnetName);

  return (
    <div className="build-placement">
      <p className="build-placement__title">Placement du build sur Nutanix</p>
      <p className="build-placement__hint">
        La VM temporaire qui construit l'image a besoin d'un cluster et d'un VLAN. Réglé une fois, appliqué à tous les builds.
      </p>

      <div className="field">
        <label htmlFor="build-cluster">Cluster</label>
        <input
          id="build-cluster"
          type="text"
          value={state?.saved.clusterName ?? resolved.clusterName ?? ""}
          onChange={(e) => setState((s) => (s ? { ...s, saved: { ...s.saved, clusterName: e.target.value } } : s))}
          onBlur={(e) => void persist({ ...state?.saved, clusterName: e.target.value })}
          placeholder={resolved.clusterName ? `détecté : ${resolved.clusterName}` : "nom du cluster Nutanix"}
          disabled={disabled}
        />
      </div>

      <div className="field">
        <label htmlFor="build-subnet">VLAN de build</label>
        <select
          id="build-subnet"
          value={resolved.subnetName ?? ""}
          onChange={(e) => void persist({ ...state?.saved, subnetName: e.target.value })}
          disabled={disabled || subnets.length === 0}
        >
          <option value="">{subnets.length === 0 ? "aucun subnet remonté par Prism" : "— choisir —"}</option>
          {subnets.map((s) => (
            <option key={s.uuid} value={s.name}>
              {s.name}
              {s.vlanId !== undefined ? ` (VLAN ${s.vlanId})` : ""}
            </option>
          ))}
        </select>
      </div>

      <p className={`build-placement__state build-placement__state--${complete ? "ok" : "warn"}`}>
        {complete ? "✓ prêt à construire" : "⚠ à renseigner avant le premier build VM"}
      </p>
      {message && <p className="build-placement__state build-placement__state--warn">{message}</p>}
    </div>
  );
}
