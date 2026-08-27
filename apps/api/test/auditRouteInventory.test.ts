import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { describe, expect, it } from "vitest";

/**
 * INVENTAIRE des routes mutantes — la moitié serveur d'une exigence en deux temps : toute route
 * mutante est auditée (plugins/audit.ts le fait automatiquement), et toute route auditée doit avoir
 * une PHRASE qui dit ce qui a été fait (vérifié côté web par auditCoverage.test.ts, qui lit ce même
 * fichier).
 *
 * Ce test échoue dès qu'une route mutante est ajoutée sans figurer dans l'inventaire. Le développeur
 * doit alors l'y ajouter, ce qui fait immédiatement échouer le test web tant qu'aucune phrase ne
 * décrit l'action. Sans ce couple, « traçabilité complète » resterait une intention.
 */
const tmpDir = path.join(os.tmpdir(), `quai-audit-inventory-${Date.now()}`);
process.env.CONFIG_PATH = path.join(tmpDir, "config.json");
process.env.CONFIG_ENCRYPTION_KEY = "8".repeat(64);

const { buildServer } = await import("../src/index.js");

const INVENTORY_PATH = fileURLToPath(new URL("./fixtures/mutating-routes.json", import.meta.url));

interface RouteEntry {
  method: string;
  path: string;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Non audités par le hook : /api/auth/* (login l'est séparément) et le webhook, sans session. */
const NOT_AUDITED = (routePath: string): boolean =>
  (routePath.startsWith("/api/auth/") && routePath !== "/api/auth/login") || routePath === "/api/github/webhook";

/** Routes RÉELLEMENT enregistrées par Fastify — jamais une liste relue dans le code source. */
async function registeredMutatingRoutes(): Promise<RouteEntry[]> {
  const app = buildServer();
  const found: RouteEntry[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (MUTATING.has(method) && !NOT_AUDITED(route.url)) found.push({ method, path: route.url });
    }
  });
  await app.ready();
  await app.close();
  return found;
}

function key(entry: RouteEntry): string {
  return `${entry.method} ${entry.path}`;
}

describe("inventaire des routes auditées", () => {
  it("chaque route mutante réellement enregistrée figure dans l'inventaire", async () => {
    const inventory = new Set((JSON.parse(readFileSync(INVENTORY_PATH, "utf-8")) as RouteEntry[]).map(key));
    const registered = await registeredMutatingRoutes();

    const missing = registered.map(key).filter((entry) => !inventory.has(entry)).sort();
    expect(
      missing,
      `Routes mutantes absentes de fixtures/mutating-routes.json — ajoutez-les, puis écrivez leur phrase dans apps/web/src/features/audit/auditMessage.ts :\n${missing.join("\n")}`,
    ).toEqual([]);
  });
});
