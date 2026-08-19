// SHA-512 crypt ($6$) — algorithme d'Ulrich Drepper, celui de crypt(3)/`openssl passwd -6`.
// Implémenté ici en pur Node (node:crypto) : jamais de sous-processus, donc jamais de mot de
// passe en clair dans un argv visible par `ps`. Vérifié contre les vecteurs officiels.

import { createHash, randomInt } from "node:crypto";

const B64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const DEFAULT_ROUNDS = 5000;
const MAX_SALT_LENGTH = 16;

const sha512 = (...parts: Buffer[]): Buffer => {
  const h = createHash("sha512");
  for (const part of parts) h.update(part);
  return h.digest();
};

/** Répète `seed` jusqu'à obtenir exactement `length` octets (séquences P et S de l'algorithme). */
function stretch(seed: Buffer, length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let offset = 0; offset < length; offset += seed.length) {
    seed.copy(out, offset, 0, Math.min(seed.length, length - offset));
  }
  return out;
}

/** Encodage base64 "crypt" : groupes de 3 octets réordonnés, poids faible en tête. */
function b64From24Bit(b2: number, b1: number, b0: number, count: number): string {
  let w = (b2 << 16) | (b1 << 8) | b0;
  let out = "";
  for (let i = 0; i < count; i += 1) {
    out += B64[w & 0x3f];
    w >>= 6;
  }
  return out;
}

// Ordre de sortie imposé par la spécification SHA-512 crypt (permutation des 64 octets).
const OUTPUT_ORDER: number[][] = [
  [0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26], [6, 27, 48],
  [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10], [53, 11, 32], [12, 33, 54], [34, 55, 13],
  [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19], [62, 20, 41],
];

/** Sel aléatoire de 16 caractères de l'alphabet crypt (le maximum accepté par crypt(3)). */
export function randomCryptSalt(): string {
  let salt = "";
  for (let i = 0; i < MAX_SALT_LENGTH; i += 1) salt += B64[randomInt(B64.length)];
  return salt;
}

/**
 * Hash SHA-512 crypt d'un mot de passe, au format `$6$<sel>$<hash>` posé tel quel dans un
 * fichier de réponses (autoinstall `password:`, preseed `password-crypted`, kickstart
 * `--iscrypted`). `salt` est tronqué à 16 caractères comme le fait crypt(3).
 */
export function sha512Crypt(password: string, salt: string = randomCryptSalt(), rounds: number = DEFAULT_ROUNDS): string {
  const key = Buffer.from(password, "utf-8");
  const saltBytes = Buffer.from(salt.slice(0, MAX_SALT_LENGTH), "utf-8");

  const b = sha512(key, saltBytes, key);

  const altParts: Buffer[] = [key, saltBytes];
  for (let cnt = key.length; cnt > 0; cnt -= 64) altParts.push(cnt > 64 ? b : b.subarray(0, cnt));
  for (let i = key.length; i > 0; i >>= 1) altParts.push(i & 1 ? b : key);
  let c = sha512(...altParts);

  const dp = sha512(...Array.from({ length: key.length }, () => key));
  const p = stretch(dp, key.length);
  // 16 + PREMIER OCTET DE A (le résultat intermédiaire), pas de B — écart classique d'implémentation.
  const ds = sha512(...Array.from({ length: 16 + c[0]! }, () => saltBytes));
  const s = stretch(ds, saltBytes.length);

  for (let i = 0; i < rounds; i += 1) {
    const parts: Buffer[] = [];
    parts.push(i & 1 ? p : c);
    if (i % 3 !== 0) parts.push(s);
    if (i % 7 !== 0) parts.push(p);
    parts.push(i & 1 ? c : p);
    c = sha512(...parts);
  }

  let hash = "";
  for (const [x, y, z] of OUTPUT_ORDER) hash += b64From24Bit(c[x!]!, c[y!]!, c[z!]!, 4);
  hash += b64From24Bit(0, 0, c[63]!, 2);

  const prefix = rounds === DEFAULT_ROUNDS ? "$6$" : `$6$rounds=${rounds}$`;
  return `${prefix}${saltBytes.toString("utf-8")}$${hash}`;
}
