import type { AppDispatch } from "@/store";
import { fetchNutanixConfig } from "@/features/clusters/clustersSlice";
import { fetchHycuConfig } from "@/features/hycu/hycuSlice";

/**
 * Pages du cœur qui lisent la MÊME configuration par leur route dédiée. Écrire par la voie
 * générique ne met pas leur état à jour : sans ce rappel, une intégration configurée depuis les
 * Réglages resterait « non configurée » sur une page déjà ouverte pendant la session. Ces deux
 * lectures sont exactement celles que ces pages font à leur ouverture — rien de plus.
 */
const AFTER_WRITE: Record<string, (dispatch: AppDispatch) => void> = {
  nutanix: (dispatch) => {
    void dispatch(fetchNutanixConfig());
  },
  hycu: (dispatch) => {
    void dispatch(fetchHycuConfig());
  },
};

export function refreshDedicatedViews(pluginId: string, dispatch: AppDispatch): void {
  AFTER_WRITE[pluginId]?.(dispatch);
}
