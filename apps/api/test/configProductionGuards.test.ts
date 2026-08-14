import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Vérifie RÉELLEMENT (process enfant `tsx` distinct, pas une relecture de code) les deux gardes
 * de démarrage anti-secret-faible-en-production de QUAI :
 * - JWT_SECRET (config.ts, finding C2 de docs/reports/security-audit-2026-08-12.md) — sans ce
 *   garde, n'importe qui connaissant "dev-insecure-secret-change-me" (committé en clair dans ce
 *   dépôt, voir .env.example) pourrait forger un JWT de session admin.
 * - CONFIG_ENCRYPTION_KEY (crypto.ts#requireKey) — sans ce garde, les secrets persistés (mot de
 *   passe LDAP, kubeconfig, jetons de registry, valeurs du gestionnaire de secrets) seraient
 *   chiffrés avec une clé aléatoire éphémère perdue au redémarrage, ou pire, illisibles/silencieux.
 *
 * Un throw au chargement du module (JWT_SECRET) ou au premier appel de chiffrement
 * (CONFIG_ENCRYPTION_KEY) ne peut pas être exercé dans le process vitest principal — config.ts et
 * crypto.ts y sont déjà importés par d'autres fichiers de test, et le throw stopperait toute la
 * suite. On spawn donc `tsx` (déjà utilisé par `pnpm dev`, cf. package.json) sur une fixture
 * minimale dans un process enfant dont on ne contrôle QUE les variables d'environnement testées.
 */

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "..");
const tsxBin = path.join(apiRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

interface FixtureResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function runFixture(fixture: string, envOverrides: Record<string, string>): Promise<FixtureResult> {
  const fixturePath = path.join(__dirname, "fixtures", fixture);
  try {
    const { stdout, stderr } = await execFileAsync(tsxBin, [fixturePath], {
      cwd: apiRoot,
      env: { ...process.env, ...envOverrides },
      timeout: 20_000,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
  }
}

describe("Garde de démarrage — JWT_SECRET en production (finding C2)", () => {
  it(
    "refuse de démarrer si NODE_ENV=production et JWT_SECRET est absent (retombe sur le défaut public)",
    async () => {
      const result = await runFixture("checkJwtSecretGuard.ts", { NODE_ENV: "production", JWT_SECRET: "" });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("JWT_SECRET is required in production");
    },
    30_000,
  );

  it(
    "refuse de démarrer si NODE_ENV=production et JWT_SECRET est explicitement laissé au défaut de dev",
    async () => {
      const result = await runFixture("checkJwtSecretGuard.ts", {
        NODE_ENV: "production",
        JWT_SECRET: "dev-insecure-secret-change-me",
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("JWT_SECRET is required in production");
    },
    30_000,
  );

  it(
    "démarre normalement si NODE_ENV=production et un vrai JWT_SECRET est fourni",
    async () => {
      const result = await runFixture("checkJwtSecretGuard.ts", {
        NODE_ENV: "production",
        JWT_SECRET: "a-real-randomly-generated-production-secret-value",
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).toBe("OK:a-real-randomly-generated-production-secret-value");
    },
    30_000,
  );

  it(
    "démarre normalement en développement même sans JWT_SECRET (le défaut de dev reste toléré hors production)",
    async () => {
      const result = await runFixture("checkJwtSecretGuard.ts", { NODE_ENV: "development", JWT_SECRET: "" });
      expect(result.ok).toBe(true);
      expect(result.stdout).toBe("OK:dev-insecure-secret-change-me");
    },
    30_000,
  );
});

describe("Garde de démarrage — CONFIG_ENCRYPTION_KEY en production (crypto.ts#requireKey)", () => {
  it(
    "refuse de chiffrer un secret si NODE_ENV=production et CONFIG_ENCRYPTION_KEY est absente",
    async () => {
      const result = await runFixture("checkConfigEncryptionKeyGuard.ts", {
        NODE_ENV: "production",
        CONFIG_ENCRYPTION_KEY: "",
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("CONFIG_ENCRYPTION_KEY is required in production");
    },
    30_000,
  );

  it(
    "chiffre normalement si NODE_ENV=production et une vraie CONFIG_ENCRYPTION_KEY (64 hex) est fournie",
    async () => {
      const result = await runFixture("checkConfigEncryptionKeyGuard.ts", {
        NODE_ENV: "production",
        CONFIG_ENCRYPTION_KEY: "a".repeat(64),
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).toBe("OK");
    },
    30_000,
  );
});
