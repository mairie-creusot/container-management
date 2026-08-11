/**
 * Chiffrement au repos des secrets persistés dans config.json (mot de passe LDAP,
 * kubeconfig, identifiants de registry). AES-256-GCM (chiffrement authentifié : toute
 * altération du fichier fait échouer le déchiffrement plutôt que de renvoyer des données
 * corrompues silencieusement) — clé fournie par CONFIG_ENCRYPTION_KEY, jamais stockée à
 * côté des données qu'elle protège (config.json ne contient que du texte chiffré).
 *
 * Format de sortie : "enc:v1:<iv base64>:<authTag base64>:<ciphertext base64>" — préfixé et
 * versionné pour (a) distinguer un champ chiffré d'un champ en clair, ce qui permet une
 * migration transparente des anciens config.json non chiffrés (voir setupStore.ts), et
 * (b) pouvoir faire évoluer l'algorithme plus tard sans casser la lecture des secrets déjà
 * écrits.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const PREFIX = "enc:v1:";
const IV_LENGTH_BYTES = 12; // taille recommandée pour GCM

let cachedKey: Buffer | undefined;

function readKeyFromEnv(): Buffer | null {
  const hex = process.env.CONFIG_ENCRYPTION_KEY;
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "CONFIG_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Generate one with: openssl rand -hex 32",
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Résout la clé de chiffrement, avec mise en cache process. En l'absence de
 * CONFIG_ENCRYPTION_KEY : échec net en production (on ne persiste jamais un secret sans
 * chiffrement réel) ; en développement, une clé aléatoire éphémère est générée une seule
 * fois pour ce process, avec un avertissement explicite — les secrets écrits avec cette clé
 * deviennent illisibles au redémarrage suivant. C'est un filet de sécurité pour ne jamais
 * retomber sur du texte en clair, pas un mode "production dégradé".
 */
function requireKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = readKeyFromEnv();
  if (fromEnv) {
    cachedKey = fromEnv;
    return cachedKey;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "CONFIG_ENCRYPTION_KEY is required in production to persist credentials (LDAP bind password, " +
        "kubeconfig, registry tokens). Generate one with: openssl rand -hex 32",
    );
  }

  // eslint-disable-next-line no-console
  console.warn(
    "[crypto] CONFIG_ENCRYPTION_KEY is not set — using a random development-only key for this process. " +
      "Secrets saved now will NOT be decryptable after a restart. Set CONFIG_ENCRYPTION_KEY " +
      "(openssl rand -hex 32) in apps/api/.env to persist secrets across restarts.",
  );
  cachedKey = randomBytes(32);
  return cachedKey;
}

/** true si la valeur est déjà passée par encryptSecret() (permet une migration transparente). */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(plaintext: string): string {
  const key = requireKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/** Idempotent : ne re-chiffre pas une valeur déjà chiffrée (utile pour la migration). */
export function encryptSecretIfNeeded(plaintext: string): string {
  return isEncrypted(plaintext) ? plaintext : encryptSecret(plaintext);
}

export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored; // legacy plaintext non encore migré (ne devrait plus arriver)
  const parts = stored.slice(PREFIX.length).split(":");
  const [ivB64, authTagB64, ciphertextB64] = parts;
  if (parts.length !== 3 || !ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted value in config.json");
  }
  const key = requireKey();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);
    return plaintext.toString("utf-8");
  } catch {
    // GCM authentication failure signifie quasi-systématiquement "mauvaise clé" (ex:
    // CONFIG_ENCRYPTION_KEY a changé depuis le chiffrement, ou ce secret a été écrit avec la
    // clé de développement éphémère d'un process précédent — voir requireKey() ci-dessus) et
    // non un fichier corrompu. Message actionnable plutôt que l'erreur crypto brute.
    throw new Error(
      "Failed to decrypt a stored secret — CONFIG_ENCRYPTION_KEY does not match the key it was encrypted " +
        "with (changed, or was an ephemeral dev key from a since-restarted process). Reconfigure the " +
        "affected step via the setup assistant to re-save it with the current key.",
    );
  }
}
