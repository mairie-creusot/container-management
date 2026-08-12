import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Fichier de test DÉDIÉ (CONFIG_PATH propre, isolé de test/setup.test.ts) : ce scénario dépend
// d'un enchaînement précis d'états (jamais complété -> complété -> réouvert) qui serait fragile
// à partager avec d'autres `it()` dans le même fichier (vitest isole le registre de modules par
// fichier de test, pas par bloc `it()` — le cache en mémoire de setupStore.ts persiste entre les
// `it()` d'un même fichier).
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-reset-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const { buildServer } = await import("../src/index.js");
const { signSessionToken } = await import("../src/services/session.js");
const { config } = await import("../src/config.js");

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

// Régression pour docs/reports/security-audit-2026-08-12.md, finding C1 : la fenêtre de
// reconfiguration (`completed` repassé à `false` par un admin via POST /api/setup/reset) ne doit
// JAMAIS rouvrir /api/setup/* sans authentification — seul un vrai premier démarrage (jamais
// terminé une seule fois) doit être ouvert. Avant le correctif, un attaquant réseau sans aucune
// session pouvait, pendant cette fenêtre, appeler POST /api/setup/complete avec un LDAP qu'il
// contrôle (defaultRole:"admin") et prendre le contrôle admin total de l'instance.
describe("setup wizard reset window stays authenticated (security regression C1)", () => {
  it("rejects an unauthenticated POST /api/setup/complete during a reset window, but allows it on a true first boot", async () => {
    const app = buildServer();

    // Vrai premier démarrage : jamais complété, donc ouvert sans session (comportement inchangé).
    const firstComplete = await app.inject({
      method: "POST",
      url: "/api/setup/complete",
      payload: {
        ldap: {
          url: "ldap://localhost:389",
          bindDn: "cn=admin,dc=example,dc=org",
          bindPassword: "admin",
          searchBase: "ou=people,dc=example,dc=org",
          searchFilter: "(uid={{username}})",
          groupRoleMap: {},
          defaultRole: "viewer",
        },
      },
    });
    expect(firstComplete.statusCode).toBe(200);
    expect(firstComplete.json()).toMatchObject({ completed: true });

    // Un admin légitime rouvre l'assistant pour le reconfigurer plus tard.
    const adminToken = signSessionToken({ username: "admin", displayName: "Admin", roles: ["admin"] });
    const resetResponse = await app.inject({
      method: "POST",
      url: "/api/setup/reset",
      cookies: { [config.session.cookieName]: adminToken },
    });
    expect(resetResponse.statusCode).toBe(200);
    expect(resetResponse.json()).toMatchObject({ completed: false });

    // Un attaquant SANS AUCUNE session tente d'injecter sa propre config LDAP admin pendant la
    // fenêtre de reconfiguration : doit être rejeté (401), jamais accepté silencieusement — c'est
    // exactement le scénario du finding C1.
    const attackerComplete = await app.inject({
      method: "POST",
      url: "/api/setup/complete",
      payload: {
        ldap: {
          url: "ldap://attacker.example.org:389",
          bindDn: "cn=admin,dc=attacker,dc=example,dc=org",
          bindPassword: "attacker-controlled",
          searchBase: "ou=people,dc=attacker,dc=example,dc=org",
          searchFilter: "(uid={{username}})",
          groupRoleMap: {},
          defaultRole: "admin",
        },
      },
    });
    expect(attackerComplete.statusCode).toBe(401);

    // GET /api/setup/status (aucun secret) reste lui aussi fermé sans authentification pendant
    // cette fenêtre — seul un vrai premier démarrage l'ouvre.
    const unauthenticatedStatus = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(unauthenticatedStatus.statusCode).toBe(401);

    // Un admin authentifié, lui, peut toujours reconfigurer normalement.
    const legitimateComplete = await app.inject({
      method: "POST",
      url: "/api/setup/complete",
      cookies: { [config.session.cookieName]: adminToken },
      payload: {
        ldap: {
          url: "ldap://localhost:389",
          bindDn: "cn=admin,dc=example,dc=org",
          bindPassword: "admin",
          searchBase: "ou=people,dc=example,dc=org",
          searchFilter: "(uid={{username}})",
          groupRoleMap: {},
          defaultRole: "viewer",
        },
      },
    });
    expect(legitimateComplete.statusCode).toBe(200);
    expect(legitimateComplete.json()).toMatchObject({ completed: true });

    await app.close();
  });
});
