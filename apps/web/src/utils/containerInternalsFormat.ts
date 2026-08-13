/**
 * Formatage pur (aucune dépendance React/Redux) pour le panneau unifié "Composition interne" du
 * sous-graphe (voir TopologySubGraphPanel.tsx) — extrait à part pour être testable en isolation
 * (voir containerInternalsFormat.test.ts), les données qu'il met en forme (temps CPU cumulé,
 * âge d'un process, dump hexadécimal d'un fichier) viennent toutes de routes API réelles
 * (GET /api/containers/:id/processes/detailed, GET /api/containers/:id/files/hexdump) — ce
 * module ne fait QUE de la présentation, jamais de calcul qui inventerait une valeur.
 */

/** Temps CPU cumulé (`ContainerProcessDetail.cpuTimeMs`, utime+stime réels lus dans le conteneur
 * cible) -> "HH:MM:SS", même convention d'affichage que la maquette validée ("00:00:41",
 * "02:14:09"). Toujours zéro-paddé sur 2 chiffres par segment, y compris pour des heures ≥ 100
 * (peu probable en pratique mais jamais tronqué silencieusement). */
export function formatCpuTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "00:00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** Âge d'un process (`ContainerProcessDetail.ageSeconds`, uptime système - starttime réels lus
 * dans le conteneur cible) -> forme courte façon "uptime" ("2s", "31m", "4h12"), même convention
 * que la maquette validée. Volontairement plus compact que formatCpuTime ci-dessus : l'âge sert
 * de repère visuel rapide dans une liste de processus, pas une mesure de précision. */
export function formatProcessAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes.toString().padStart(2, "0")}`;
}

export interface HexdumpRow {
  /** Offset de début de ligne, hexadécimal minuscule sur 8 chiffres (convention `xxd`). */
  offsetLabel: string;
  /** Octets de la ligne (jusqu'à 16), groupés par paires ("7f45", "4c46"...) — jamais coupé au
   * milieu d'un octet. */
  groups: string[];
  /** Représentation ASCII de la ligne — caractère imprimable (0x20-0x7e) tel quel, "." sinon
   * (convention `xxd`/`hexdump -C`, jamais un caractère deviné pour un octet non imprimable). */
  ascii: string;
}

const BYTES_PER_ROW = 16;
const BYTES_PER_GROUP = 2;

/** Découpe la chaîne hexadécimale brute (`FileHexdump.bytes`, minuscule sans séparateurs, voir
 * apps/api/src/types.ts) en lignes affichables façon `xxd` : offset / groupes de 2 octets /
 * ASCII. `startOffset` = `FileHexdump.offset` (fenêtre demandée), reporté sur l'étiquette de
 * chaque ligne pour que l'offset affiché corresponde à la position RÉELLE dans le fichier, pas à
 * une position relative à 0 qui serait fausse dès qu'on navigue au-delà du premier octet. */
export function hexdumpRows(bytesHex: string, startOffset: number): HexdumpRow[] {
  const clean = bytesHex.trim();
  if (!clean) return [];
  const byteCount = Math.floor(clean.length / 2);
  const rows: HexdumpRow[] = [];
  for (let rowStart = 0; rowStart < byteCount; rowStart += BYTES_PER_ROW) {
    const rowByteCount = Math.min(BYTES_PER_ROW, byteCount - rowStart);
    const groups: string[] = [];
    let ascii = "";
    for (let g = 0; g < rowByteCount; g += BYTES_PER_GROUP) {
      const groupByteCount = Math.min(BYTES_PER_GROUP, rowByteCount - g);
      groups.push(clean.slice((rowStart + g) * 2, (rowStart + g + groupByteCount) * 2));
    }
    for (let b = 0; b < rowByteCount; b++) {
      const byteHex = clean.slice((rowStart + b) * 2, (rowStart + b) * 2 + 2);
      const code = Number.parseInt(byteHex, 16);
      ascii += code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : ".";
    }
    rows.push({
      offsetLabel: (startOffset + rowStart).toString(16).padStart(8, "0"),
      groups,
      ascii,
    });
  }
  return rows;
}
