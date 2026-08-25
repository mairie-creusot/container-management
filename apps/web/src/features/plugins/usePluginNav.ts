import { useMemo } from "react";
import { useAppSelector } from "@/hooks";
import { derivePluginNavItems, type PluginNavItem } from "@/features/plugins/pluginsModel";

/** Entrées du tiroir « Extensions », dérivées de l'état réel des greffons. */
export function usePluginNavItems(): PluginNavItem[] {
  const plugins = useAppSelector((state) => state.plugins);
  return useMemo(() => derivePluginNavItems(plugins), [plugins]);
}
