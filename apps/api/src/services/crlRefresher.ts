/**
 * Rapatriement périodique des listes de révocation (CRL) de l'autorité interne.
 *
 * C'est la SEULE partie du dispositif de révocation qui touche au réseau, et elle est délibérément
 * séparée de la vérification : plugins/crl.ts ne lit que des fichiers déjà posés sur le disque.
 * Ainsi, une PKI injoignable ne se transforme jamais en décision prise dans l'urgence au moment de
 * charger du code — elle se traduit par une liste qui vieillit, ce que l'écran des Modules montre.
 *
 * Démarrée depuis index.ts#main() seulement, jamais depuis buildServer() — même câblage que
 * certificatesReconciler.ts. Sans PLUGIN_CRL_URLS, elle ne démarre pas du tout : les fichiers
 * déposés à la main dans PLUGIN_CRL_PATH restent alors la seule source, et QUAI n'émet aucun appel.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { crlDirectory } from "../plugins/installed.js";
import { parseCrl, pemToDer } from "../plugins/crl.js";

export interface CrlRefreshOutcome {
  url: string;
  file: string | null;
  ok: boolean;
  /** Motif RÉEL de l'échec — jamais avalé, c'est lui qui explique une liste qui vieillit. */
  message: string;
}

export interface CrlRefreshStatus {
  intervalMs: number;
  lastRunAt: string | null;
  outcomes: CrlRefreshOutcome[];
}

let status: CrlRefreshStatus = { intervalMs: 0, lastRunAt: null, outcomes: [] };
let timer: NodeJS.Timeout | undefined;

export function getCrlRefreshStatus(): CrlRefreshStatus {
  return { ...status, outcomes: [...status.outcomes] };
}

/** Nom de fichier stable et sans échappatoire, dérivé de l'URL. Deux URLs distinctes ne peuvent pas
 * se recouvrir : le nom garde le dernier segment ET une empreinte courte de l'URL entière. */
function fileNameFor(url: string): string {
  const last = url.split("/").pop() ?? "liste";
  const safe = last.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60) || "liste";
  let hash = 0;
  for (const char of url) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `${safe}.${hash.toString(16)}.crl`;
}

const FETCH_TIMEOUT_MS = 15_000;
/** Une CRL de collectivité pèse quelques dizaines de kilo-octets ; au-delà, ce n'est pas une CRL. */
const MAX_CRL_BYTES = 8 * 1024 * 1024;

async function refreshOne(url: string, directory: string): Promise<CrlRefreshOutcome> {
  let body: Buffer;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return { url, file: null, ok: false, message: `l'autorité a répondu ${response.status}` };
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.byteLength > MAX_CRL_BYTES) {
      return { url, file: null, ok: false, message: `réponse de ${raw.byteLength} octets : ce n'est pas une liste de révocation` };
    }
    body = raw;
  } catch (err) {
    return { url, file: null, ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  // Vérifiée AVANT d'être posée : une page d'erreur HTML ne doit pas s'accumuler dans le répertoire
  // de confiance. Sa signature, elle, est confrontée à l'émetteur réel au moment de la vérification
  // du paquet (plugins/crl.ts) — le serveur n'a pas forcément ici le certificat de l'émettrice.
  const parsed = parseCrl(pemToDer(body), url);
  if (!parsed.ok) return { url, file: null, ok: false, message: `réponse inexploitable : ${parsed.reason}` };

  const name = fileNameFor(url);
  const target = path.join(directory, name);
  const staging = `${target}.entrante`;
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(staging, body, { mode: 0o600 });
    await fs.rename(staging, target);
  } catch (err) {
    await fs.rm(staging, { force: true }).catch(() => undefined);
    return { url, file: null, ok: false, message: `écriture impossible : ${err instanceof Error ? err.message : String(err)}` };
  }

  const validity = parsed.crl.nextUpdate === undefined ? "sans date de péremption" : `valable jusqu'au ${parsed.crl.nextUpdate.toISOString().slice(0, 10)}`;
  return { url, file: name, ok: true, message: `${parsed.crl.revoked.size} certificat(s) révoqué(s), ${validity}` };
}

/** Une passe complète, sans exception : chaque URL rend son verdict, réussite comme échec. */
export async function refreshCrls(): Promise<CrlRefreshOutcome[]> {
  const directory = crlDirectory();
  const outcomes: CrlRefreshOutcome[] = [];
  for (const url of config.plugins.crlUrls) {
    const outcome = await refreshOne(url, directory);
    outcomes.push(outcome);
    if (!outcome.ok) console.warn(`[crl] ${url} non rapatriée : ${outcome.message}`);
  }
  status = { intervalMs: status.intervalMs, lastRunAt: new Date().toISOString(), outcomes };
  return outcomes;
}

export function startCrlRefresher(): void {
  if (config.plugins.crlUrls.length === 0 || config.plugins.crlPolicy === "off") return;

  const intervalMs = Math.max(config.plugins.crlRefreshIntervalMs, 60_000);
  status = { intervalMs, lastRunAt: null, outcomes: [] };
  void refreshCrls();
  timer = setInterval(() => void refreshCrls(), intervalMs);
  timer.unref();
  console.warn(`[crl] rapatriement des listes de révocation toutes les ${Math.round(intervalMs / 60_000)} min`);
}

/** Arrêt propre : appelé à l'extinction du serveur comme en fin de test. */
export function stopCrlRefresher(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
