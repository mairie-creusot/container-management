import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeAction } from "./auditMessage";
import type { AuditEvent } from "@/types";

/**
 * COUVERTURE du journal de traçabilité — le test qui rend l'exigence vérifiable au lieu de
 * déclarative : CHAQUE route mutante de l'API doit produire une phrase qui dit ce qui a été fait,
 * jamais le repli générique « a effectué une action sur X ».
 *
 * L'inventaire vient de l'API elle-même (apps/api/test/fixtures/mutating-routes.json, tenu à jour
 * par apps/api/test/auditRouteInventory.test.ts qui échoue dès qu'une route mutante y manque).
 * Ajouter une route sans lui écrire sa phrase fait donc échouer la CI des deux côtés.
 */
const INVENTORY = path.join(
  fileURLToPath(new URL("../../../../..", import.meta.url)),
  "apps/api/test/fixtures/mutating-routes.json",
);

interface RouteEntry {
  method: string;
  path: string;
}

/** Valeurs d'exemple RÉALISTES : la phrase dépend souvent du segment, pas seulement du gabarit. */
const SAMPLES: Record<string, string> = {
  ":id": "abc123def456",
  ":uuid": "4f2c1e88-1111-2222-3333-444455556666",
  ":name": "Spooler",
  ":subject": "gitlab.lecreusot.priv",
  ":nodeId": "nutanix-vm%3A4f2c1e88",
  ":runId": "run-2026-08-27",
  ":moduleId": "3cx",
  ":actionId": "vm.start",
  ":packageName": "openssl",
  ":pluginId": "hycu",
  ":action": "start",
};

function concretePath(pattern: string): string {
  return pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? SAMPLES[segment] ?? "exemple" : segment))
    .join("/");
}

function event(method: string, routePath: string): AuditEvent {
  return {
    id: "e1",
    timestamp: "2026-08-27T09:00:00.000Z",
    actor: "ybanas",
    actorDisplayName: "BANAS Yann",
    method,
    path: routePath,
    statusCode: 200,
    ok: true,
  };
}

const routes: RouteEntry[] = JSON.parse(readFileSync(INVENTORY, "utf-8")) as RouteEntry[];

describe("journal de traçabilité : aucune action ne se dit en langage vague", () => {
  it("l'inventaire des routes mutantes est réellement lu", () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it.each(routes.map((route) => [route.method, route.path] as const))(
    "%s %s dit CE QUI a été fait",
    (method, routePath) => {
      const message = describeAction(event(method, concretePath(routePath)));

      // Ni verbe HTTP, ni chemin : exigence utilisateur de longue date.
      expect(message).not.toContain("/api/");
      expect(message).not.toMatch(/\b(GET|POST|PUT|PATCH|DELETE)\b/);
      // Et surtout : pas le repli générique, qui ne dit PAS ce qui a été fait.
      expect(message).not.toMatch(/^a effectué une action/);
      expect(message.length).toBeGreaterThan(10);
    },
  );
});
