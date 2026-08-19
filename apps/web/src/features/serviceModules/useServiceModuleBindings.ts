import { useCallback, useEffect, useState } from "react";
import { fetchServiceModuleBindings, fetchServiceModules } from "./api";
import type { ResolvedServiceModuleBinding, ServiceModuleDescriptor } from "./types";

/**
 * Liaisons effectives nœud -> module, résolues avec le LIBELLÉ humain du module (jointure sur le
 * registre GET /api/service-modules) — la pastille d'une carte doit dire « module Active
 * Directory / DNS », jamais « module ad-dns ».
 *
 * Chargées une fois au montage (+ `refresh()` explicite après une liaison manuelle) : ces données
 * ne bougent que quand un administrateur lie/délie un nœud, ou quand une correspondance
 * automatique cesse d'être vraie — aucun intérêt à les sonder en continu. Le seul sondage court de
 * cette fonctionnalité est celui de l'instantané d'un module OUVERT (voir ServiceModuleView).
 *
 * Échec silencieux (Map vide) : un backend plus ancien renvoie 404 sur ces routes, et l'absence de
 * module ne doit RIEN changer au comportement existant du graphe — jamais un bandeau d'erreur pour
 * une fonctionnalité optionnelle.
 */
export interface ServiceModuleBindingsState {
  bindingByNodeId: Map<string, ResolvedServiceModuleBinding>;
  modules: ServiceModuleDescriptor[];
  refresh: () => void;
}

export function useServiceModuleBindings(): ServiceModuleBindingsState {
  const [bindingByNodeId, setBindingByNodeId] = useState<Map<string, ResolvedServiceModuleBinding>>(new Map());
  const [modules, setModules] = useState<ServiceModuleDescriptor[]>([]);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [registry, bindings] = await Promise.all([fetchServiceModules(), fetchServiceModuleBindings()]);
        if (cancelled) return;
        const labelById = new Map(registry.modules.map((module) => [module.id, module.label]));
        const next = new Map<string, ResolvedServiceModuleBinding>();
        for (const binding of bindings.bindings) {
          // Une liaison vers un module absent du registre n'est jamais affichée (module retiré
          // entre-temps) — pas de pastille orpheline qui ouvrirait un panneau vide.
          const moduleLabel = labelById.get(binding.moduleId);
          if (!moduleLabel) continue;
          next.set(binding.nodeId, { ...binding, moduleLabel });
        }
        setBindingByNodeId(next);
        setModules(registry.modules);
      } catch {
        if (!cancelled) setBindingByNodeId(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  return { bindingByNodeId, modules, refresh };
}
