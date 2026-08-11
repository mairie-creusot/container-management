import { useState } from "react";
import TopologyGraph from "@/components/TopologyGraph";
import Inspector from "@/components/Inspector";
import KeyValueList from "@/components/KeyValueList";
import StatusPill from "@/components/StatusPill";
import type { TopologyNode } from "@/types";

const KIND_LABEL: Record<TopologyNode["kind"], string> = {
  container: "Conteneur",
  volume: "Volume",
  network: "Network",
};

export default function TopologyPage() {
  const [selected, setSelected] = useState<TopologyNode | null>(null);

  return (
    <div className="workspace">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h2>Topologie</h2>
            <p>
              Vue visuelle de l'infrastructure — conteneurs, volumes et networks réellement
              rattachés les uns aux autres, en direct.
            </p>
          </div>
        </div>

        <TopologyGraph height={window.innerHeight - 230} onSelectNode={setSelected} />
      </div>

      <Inspector
        title={selected?.label}
        subtitle={selected ? KIND_LABEL[selected.kind] : undefined}
        onClose={() => setSelected(null)}
        emptyLabel="Cliquez sur un nœud du graphe pour voir son détail."
      >
        {selected && (
          <>
            <StatusPill status={selected.status} />
            <KeyValueList
              rows={[
                { key: "Type", value: KIND_LABEL[selected.kind] },
                { key: "Détail", value: selected.subtitle },
              ]}
            />
          </>
        )}
      </Inspector>
    </div>
  );
}
