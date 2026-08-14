/**
 * Écriture de fichier avec permissions restrictives — RÉELLEMENT appliquées, y compris sur un
 * fichier déjà existant.
 *
 * Piège root-causé lors de la re-passe d'audit sécurité du 14/08/2026 (re-vérification des
 * principes Vault sur TOUT le périmètre secrets, cf. rapport d'audit) : passer
 * `{ mode: 0o600 }` à `fs.writeFile`/`fs.appendFile` ne restreint les permissions QUE si le
 * fichier est créé par cet appel (POSIX : `mode` ne s'applique qu'avec `O_CREAT` quand le
 * fichier n'existe pas encore ; sur un fichier déjà présent, l'appel ouvre juste le descripteur
 * existant et ses permissions courantes ne bougent PAS, quel que soit `mode`). Concrètement :
 * en environnement réel, `data/config.json` (mots de passe LDAP/Nutanix/DNS AD, identifiants de
 * registry) a été retrouvé en `-rwxrwxrwx` (777, lisible ET modifiable par n'importe quel
 * utilisateur/processus ayant accès au volume) malgré `setupStore.ts#writeToDisk` passant déjà
 * `mode: 0o600` à chaque écriture depuis son introduction — le fichier avait simplement été créé
 * une première fois par un chemin antérieur à ce durcissement (ou par un outil externe), et
 * chaque réécriture suivante avec `mode: 0o600` n'a jamais corrigé les bits de permission déjà en
 * place. Un fichier world-writable contenant des secrets chiffrés reste un risque réel même si le
 * contenu est chiffré : n'importe qui pouvant écrire dedans peut altérer les champs NON chiffrés
 * qui l'accompagnent (ex: `ldap.url`/`ldap.bindDn`/`groupRoleMap` dans config.json, en clair par
 * conception) pour rediriger l'authentification vers un serveur contrôlé par l'attaquant et
 * s'octroyer le rôle admin sans jamais connaître le vrai mot de passe — même classe de risque que
 * le finding C1 (docs/reports/security-audit-2026-08-12.md), via l'écriture disque plutôt que
 * l'API.
 *
 * Fix : `fs.chmod()` explicite APRÈS l'écriture, qui corrige toujours les bits de permission
 * (fonctionne aussi bien sur un fichier tout juste créé que sur un fichier préexistant écrit avec
 * un mode trop permissif par un chemin antérieur) — auto-cicatrisant, sans script de migration
 * séparé : la prochaine écriture d'un store affecté referme la fenêtre.
 *
 * Réservé aux fichiers qui persistent un secret (voir chaque appelant) — pas un remplacement
 * général de `fs.writeFile`/`fs.appendFile` pour les fichiers sans donnée sensible.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const RESTRICTED_MODE = 0o600;

/** Écrit `content` dans `filePath` (remplace tout contenu existant) puis force 0600, même si le
 * fichier existait déjà avec des permissions plus larges. Crée le dossier parent si besoin. */
export async function writeFileRestricted(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: RESTRICTED_MODE });
  // Corrige les bits de permission même si le fichier existait déjà avant ce durcissement (voir
  // en-tête de fichier) — `fs.writeFile` seul ne le fait pas sur un fichier préexistant.
  await fs.chmod(filePath, RESTRICTED_MODE);
}

/** Ajoute `content` en fin de `filePath` (JSON Lines append-only) puis force 0600, même
 * raisonnement que writeFileRestricted ci-dessus. Crée le dossier parent si besoin. */
export async function appendFileRestricted(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, content, { encoding: "utf-8", mode: RESTRICTED_MODE });
  await fs.chmod(filePath, RESTRICTED_MODE);
}
