// Paramètres de build Nutanix par défaut (cluster + subnet servant à la VM temporaire des builds
// Packer) — data/template-build-defaults.json, 0600. Aucun secret : uniquement des NOMS de
// ressources réelles, les identifiants Prism restent dans setupStore (chiffrés) et ne sont
// injectés qu'au spawn.

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export interface TemplateBuildDefaults {
  clusterName?: string;
  subnetName?: string;
}

function defaultsPath(): string {
  return path.join(path.dirname(path.resolve(config.setup.configPath)), "template-build-defaults.json");
}

export async function getBuildDefaults(): Promise<TemplateBuildDefaults> {
  try {
    const parsed = JSON.parse(await fs.readFile(defaultsPath(), "utf-8")) as TemplateBuildDefaults;
    return {
      ...(typeof parsed.clusterName === "string" && parsed.clusterName ? { clusterName: parsed.clusterName } : {}),
      ...(typeof parsed.subnetName === "string" && parsed.subnetName ? { subnetName: parsed.subnetName } : {}),
    };
  } catch {
    return {};
  }
}

export async function setBuildDefaults(next: TemplateBuildDefaults): Promise<TemplateBuildDefaults> {
  const merged: TemplateBuildDefaults = {
    ...(next.clusterName ? { clusterName: next.clusterName } : {}),
    ...(next.subnetName ? { subnetName: next.subnetName } : {}),
  };
  await fs.mkdir(path.dirname(defaultsPath()), { recursive: true });
  await fs.writeFile(defaultsPath(), JSON.stringify(merged, null, 2), { encoding: "utf-8", mode: 0o600 });
  return merged;
}
