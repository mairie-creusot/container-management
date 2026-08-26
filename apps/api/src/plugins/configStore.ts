/**
 * Accès du socle à la configuration d'un greffon : quelle voie d'écriture emprunter, et comment
 * fusionner une saisie partielle avec ce qui est déjà enregistré.
 *
 * Voie d'écriture : celle DU GREFFON (Plugin#configStore) dès qu'il en déclare une. Les quatre
 * intégrations historiques en déclarent une parce qu'écrire ne suffit pas chez elles : il faut
 * aussi purger l'ancien champ typé (config.json#hycu, #nutanix…), sans quoi une configuration
 * retirée par l'admin ressusciterait au prochain démarrage. À défaut, le socle retombe sur le
 * stockage générique des intégrations, sous `manifest.id`.
 */

import type { Plugin, PluginConfigStore } from "@quai/plugin-contract";
import { clearIntegrationConfig, getEffectiveIntegrationConfig, setIntegrationConfig } from "../services/setupStore.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function configStoreOf(plugin: Plugin): PluginConfigStore {
  if (plugin.configStore) return plugin.configStore;

  const id = plugin.manifest.id;
  const secretFields = [...plugin.manifest.secretFields];
  return {
    async load(): Promise<Record<string, unknown> | null> {
      const entry = await getEffectiveIntegrationConfig(id);
      // Une entrée SANS aucun champ n'est pas une configuration : elle n'existe que pour porter une
      // mise en pause explicite d'un greffon jamais configuré (setupStore#setIntegrationEnabled).
      // La rendre ici ferait dire « Configuration : enregistrée » là où rien n'a jamais été saisi.
      if (!entry || Object.keys(entry.config).length === 0) return null;
      return entry.config;
    },
    async save(config: Record<string, unknown>): Promise<void> {
      await setIntegrationConfig(id, config, secretFields);
    },
    async remove(): Promise<void> {
      await clearIntegrationConfig(id);
    },
  };
}

/** "auth.password" -> ["auth", "password"] ; [] si le chemin est inutilisable. */
function segmentsOf(field: string): string[] {
  const segments = field.split(".");
  return segments.some((segment) => segment.length === 0) ? [] : segments;
}

function readAtPath(root: Record<string, unknown>, segments: string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Copie de `root` portant `value` au chemin donné ; les conteneurs manquants sont créés. */
function writeAtPath(root: Record<string, unknown>, segments: string[], value: string): Record<string, unknown> {
  const [head, ...rest] = segments;
  if (head === undefined) return root;
  if (rest.length === 0) return { ...root, [head]: value };
  const child = root[head];
  return { ...root, [head]: writeAtPath(isRecord(child) ? child : {}, rest, value) };
}

/** `password` -> `hasPassword` — même convention que la vue sûre du stockage générique. */
function presenceFlagName(key: string): string {
  return `has${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

/** Retire la feuille désignée, sans toucher au reste ni inventer de conteneur. */
function deleteAtPath(root: Record<string, unknown>, segments: string[]): Record<string, unknown> {
  const [head, ...rest] = segments;
  if (head === undefined || !Object.hasOwn(root, head)) return root;
  if (rest.length === 0) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(root)) {
      if (key !== head) out[key] = value;
    }
    return out;
  }
  const child = root[head];
  if (!isRecord(child)) return root;
  return { ...root, [head]: deleteAtPath(child, rest) };
}

/**
 * Convention « champ secret vide = conserver l'existant », celle de toutes les routes de
 * configuration des intégrations : un formulaire ne réaffiche jamais un secret, donc un champ
 * secret laissé vide veut dire « ne change pas celui-là », jamais « efface-le ». Le reste de la
 * configuration est REMPLACÉ tel quel — c'est ce que fait le stockage générique, et c'est la seule
 * façon de pouvoir vider un champ facultatif.
 *
 * Les booléens de présence de la vue sûre (`hasPassword`…) sont retirés au passage : ils SORTENT
 * par l'API, ils ne rentrent jamais dans une configuration, même renvoyés tels quels par le
 * formulaire.
 */
export function mergeKeepingSecrets(
  submitted: Record<string, unknown>,
  existing: Record<string, unknown> | null,
  secretFields: readonly string[],
): Record<string, unknown> {
  let merged: Record<string, unknown> = { ...submitted };

  for (const field of secretFields) {
    const segments = segmentsOf(field);
    const leaf = segments[segments.length - 1];
    if (segments.length === 0 || leaf === undefined) continue;

    merged = deleteAtPath(merged, [...segments.slice(0, -1), presenceFlagName(leaf)]);

    const given = readAtPath(merged, segments);
    if (typeof given === "string" && given.trim().length > 0) continue;

    const kept = existing ? readAtPath(existing, segments) : undefined;
    if (typeof kept !== "string" || kept.length === 0) continue;
    merged = writeAtPath(merged, segments, kept);
  }

  return merged;
}
