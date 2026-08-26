import { describe, expect, it } from "vitest";
import { describeAction, directoryDisplayNames, pluginAuditLabels } from "@/features/audit/auditMessage";
import type { AuditEvent } from "@/types";

function event(method: string, path: string, extra: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "1",
    timestamp: "2026-08-24T10:00:00.000Z",
    actor: "ybanas",
    actorDisplayName: "BANAS Yann",
    method,
    path,
    statusCode: 200,
    ok: true,
    ...extra,
  };
}

// Relevé exhaustif des routes mutantes réelles (apps/api/src/routes/*.ts). Les segments variables
// sont remplacés par une valeur réaliste. Toute nouvelle route ajoutée à l'API doit apparaître ici
// ET obtenir sa phrase dans describeAction : c'est ce que verrouille le premier test.
const MUTATING_ROUTES: [string, string][] = [
  ["POST", "/api/auth/login"],
  ["POST", "/api/auth/logout"],
  ["POST", "/api/auth/ldap-diagnose"],
  ["POST", "/api/setup/complete"],
  ["POST", "/api/setup/reset"],
  ["PUT", "/api/setup/ldap"],
  ["POST", "/api/setup/test/docker"],
  ["POST", "/api/setup/test/kubernetes"],
  ["POST", "/api/setup/test/ldap"],
  ["POST", "/api/setup/test/nutanix"],
  ["POST", "/api/setup/test/registry"],
  ["POST", "/api/containers"],
  ["POST", "/api/containers/abc123/start"],
  ["POST", "/api/containers/abc123/stop"],
  ["POST", "/api/containers/abc123/restart"],
  ["PUT", "/api/containers/abc123/mounts"],
  ["PUT", "/api/containers/abc123/env"],
  ["DELETE", "/api/containers/abc123"],
  ["POST", "/api/volumes"],
  ["DELETE", "/api/volumes/quai_data"],
  ["POST", "/api/networks"],
  ["POST", "/api/networks/net1/connect"],
  ["POST", "/api/networks/net1/disconnect"],
  ["DELETE", "/api/networks/net1"],
  ["POST", "/api/images/pull"],
  ["POST", "/api/images/img1/update"],
  ["DELETE", "/api/images/img1"],
  ["POST", "/api/registries"],
  ["PATCH", "/api/registries/reg1"],
  ["DELETE", "/api/registries/reg1"],
  ["POST", "/api/secrets"],
  ["PATCH", "/api/secrets/sec1"],
  ["DELETE", "/api/secrets/sec1"],
  ["POST", "/api/cron-jobs"],
  ["POST", "/api/cron-jobs/job1/trigger"],
  ["PATCH", "/api/cron-jobs/job1"],
  ["DELETE", "/api/cron-jobs/job1"],
  ["POST", "/api/backups"],
  ["POST", "/api/backups/bk1/run"],
  ["POST", "/api/backups/bk1/restore/run1"],
  ["PATCH", "/api/backups/bk1"],
  ["DELETE", "/api/backups/bk1"],
  ["POST", "/api/iac/lint"],
  ["POST", "/api/iac/workspaces"],
  ["DELETE", "/api/iac/workspaces/ws1"],
  ["POST", "/api/gitops/sync"],
  ["PUT", "/api/github/token"],
  ["POST", "/api/github/webhook"],
  ["POST", "/api/notification-channels"],
  ["POST", "/api/notification-channels/ch1/test"],
  ["DELETE", "/api/notification-channels/ch1"],
  ["POST", "/api/notifications/read-all"],
  ["PUT", "/api/ad-dns/config"],
  ["DELETE", "/api/ad-dns/config"],
  ["POST", "/api/ad-dns/test"],
  ["PUT", "/api/nutanix/config"],
  ["DELETE", "/api/nutanix/config"],
  ["POST", "/api/nutanix/images"],
  ["POST", "/api/nutanix/images/upload"],
  ["POST", "/api/nutanix/vms/uuid-1/start"],
  ["POST", "/api/nutanix/vms/uuid-1/stop"],
  ["POST", "/api/nutanix/vms/uuid-1/restart"],
  ["POST", "/api/nutanix/vms/uuid-1/disks"],
  ["POST", "/api/nutanix/vms/uuid-1/nics"],
  ["DELETE", "/api/nutanix/vms/uuid-1"],
  ["PUT", "/api/plugins/nutanix/config"],
  ["POST", "/api/plugins/nutanix/config/test"],
  ["DELETE", "/api/plugins/nutanix/config"],
  ["PUT", "/api/plugins/nutanix/enabled"],
  ["POST", "/api/plugins/nutanix/actions/vm.start"],
  ["PUT", "/api/lxc/config"],
  ["DELETE", "/api/lxc/config"],
  ["POST", "/api/remote-environments"],
  ["PATCH", "/api/remote-environments/env1"],
  ["DELETE", "/api/remote-environments/env1"],
  ["POST", "/api/reverse-proxy/routes"],
  ["POST", "/api/reverse-proxy/routes/r1/resync-dns"],
  ["DELETE", "/api/reverse-proxy/routes/r1"],
  ["POST", "/api/reverse-proxy/push"],
  ["PUT", "/api/certificates/config"],
  ["DELETE", "/api/certificates/config"],
  ["POST", "/api/certificates/config/test"],
  ["POST", "/api/certificates/issue"],
  ["DELETE", "/api/certificates/quai.lecreusot.priv"],
  ["PUT", "/api/hycu/config"],
  ["DELETE", "/api/hycu/config"],
  ["POST", "/api/hycu/config/test"],
  ["PUT", "/api/glpi/config"],
  ["DELETE", "/api/glpi/config"],
  ["POST", "/api/glpi/config/test"],
  ["POST", "/api/glpi/inventory/computers"],
  ["PATCH", "/api/glpi/inventory/computers/42"],
  ["PUT", "/api/3cx/config"],
  ["DELETE", "/api/3cx/config"],
  ["POST", "/api/3cx/config/test"],
  ["POST", "/api/templates"],
  ["PUT", "/api/templates/tpl1"],
  ["DELETE", "/api/templates/tpl1"],
  ["POST", "/api/templates/tpl1/build"],
  ["POST", "/api/templates/tpl1/validate"],
  ["PUT", "/api/templates/build-defaults"],
  ["PUT", "/api/service-modules/bindings"],
  ["DELETE", "/api/service-modules/bindings/node1"],
  ["POST", "/api/automation/nodes"],
  ["DELETE", "/api/automation/nodes/n1"],
  ["POST", "/api/automation/edges"],
  ["DELETE", "/api/automation/edges/e1"],
  ["POST", "/api/topology/groups"],
  ["PATCH", "/api/topology/groups/g1"],
  ["DELETE", "/api/topology/groups/g1"],
  ["PUT", "/api/topology/groups/g1/positions"],
  ["PUT", "/api/topology/positions"],
  ["POST", "/api/plugins/installed"],
  ["DELETE", "/api/plugins/installed/mon-module"],
];

describe("journal de traçabilité : phrases lisibles", () => {
  // Exigence de l'utilisateur : plus aucun "POST /api/certificates/issue" à l'écran.
  it.each(MUTATING_ROUTES)("%s %s produit une phrase sans verbe HTTP ni chemin", (method, path) => {
    const message = describeAction(event(method, path));
    expect(message).not.toContain("/api/");
    expect(message).not.toMatch(/\b(GET|POST|PUT|PATCH|DELETE)\b/);
    expect(message).not.toBe("a effectué une action d'administration");
    expect(message.length).toBeGreaterThan(10);
  });

  it("décrit une route inconnue par sa famille, jamais par sa méthode", () => {
    expect(describeAction(event("POST", "/api/certificates/futur-endpoint/x"))).toBe(
      "a effectué une action sur les certificats",
    );
    expect(describeAction(event("POST", "/api/inconnu-total"))).toBe("a effectué une action d'administration");
  });

  /** Canal d'exécution générique des greffons : le chemin ne porte QUE l'identifiant de l'action,
   * c'est le libellé du manifeste (GET /api/plugins) qui le rend lisible. */
  it("nomme une action de greffon par le libellé de son manifeste", () => {
    const labels = pluginAuditLabels([
      {
        manifest: {
          id: "nutanix",
          name: "Virtualisation Nutanix",
          auditLabels: { "vm.start": "Démarrer une VM Nutanix", "vm.delete": "Supprimer définitivement une VM Nutanix" },
        },
      },
    ]);

    expect(describeAction(event("POST", "/api/plugins/nutanix/actions/vm.start"), labels)).toBe(
      "a exécuté « Démarrer une VM Nutanix »",
    );
    expect(describeAction(event("POST", "/api/plugins/nutanix/actions/vm.delete"), labels)).toBe(
      "a exécuté « Supprimer définitivement une VM Nutanix »",
    );
    expect(describeAction(event("PUT", "/api/plugins/nutanix/enabled"), labels)).toBe(
      "a activé ou désactivé le module « Virtualisation Nutanix »",
    );
  });

  it("reste lisible sans libellé connu : l'identifiant réel, jamais un libellé inventé", () => {
    const message = describeAction(event("POST", "/api/plugins/nutanix/actions/vm.start"));
    expect(message).toBe("a exécuté l'action « vm.start » du module « nutanix »");

    const labels = pluginAuditLabels([{ manifest: { id: "nutanix", name: "Virtualisation Nutanix", auditLabels: {} } }]);
    expect(describeAction(event("POST", "/api/plugins/nutanix/actions/vm.inconnue"), labels)).toBe(
      "a exécuté l'action « vm.inconnue » du module « Virtualisation Nutanix »",
    );
  });

  it("distingue une connexion réussie d'un échec", () => {
    expect(describeAction(event("POST", "/api/auth/login"))).toBe("s'est connecté(e)");
    expect(describeAction(event("POST", "/api/auth/login", { ok: false, statusCode: 401 }))).toBe(
      "a échoué à se connecter",
    );
  });
});

describe("harmonisation des noms d'utilisateur", () => {
  it("applique à tout l'historique le nom porté par la connexion (celui de l'annuaire)", () => {
    const events = [
      event("POST", "/api/certificates/issue", { id: "1", actorDisplayName: "Yann Banas", timestamp: "2026-08-24T09:00:00.000Z" }),
      event("POST", "/api/auth/login", { id: "2", actorDisplayName: "BANAS Yann", timestamp: "2026-08-24T10:00:00.000Z" }),
    ];
    expect(directoryDisplayNames(events).get("ybanas")).toBe("BANAS Yann");
  });

  it("ignore une connexion échouée et garde le nom de la dernière connexion réussie", () => {
    const events = [
      event("POST", "/api/auth/login", { id: "1", actorDisplayName: "BANAS Yann", timestamp: "2026-08-24T08:00:00.000Z" }),
      event("POST", "/api/auth/login", { id: "2", actorDisplayName: "ybanas", ok: false, statusCode: 401, timestamp: "2026-08-24T09:00:00.000Z" }),
    ];
    expect(directoryDisplayNames(events).get("ybanas")).toBe("BANAS Yann");
  });

  it("ne connaît aucun nom pour un compte qui ne s'est jamais connecté (repli sur la ligne)", () => {
    expect(directoryDisplayNames([event("POST", "/api/volumes")]).has("ybanas")).toBe(false);
  });
});
