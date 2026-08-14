import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SetupRegistryConfig } from "../src/services/setupStore.js";

// CONFIG_PATH isolé (même pattern que setup.test.ts/watchdog.test.ts) — un fichier temporaire
// dédié à cette suite, jamais celui du développement ni celui d'une autre suite (vitest isole
// le registre de modules par fichier de test).
const tmpConfigPath = path.join(os.tmpdir(), `quai-api-test-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.CONFIG_PATH = tmpConfigPath;

const { completeSetup, getEffectiveRegistryCredentials, getEffectiveRegistryCredentialsForImage } = await import(
  "../src/services/setupStore.js"
);

afterAll(async () => {
  await fs.rm(tmpConfigPath, { force: true });
});

/**
 * Remplace intégralement la config persistée par exactement ces registries (completeSetup
 * écrase `cache` en entier, contrairement à addRegistry qui accumule sur l'existant) — chaque
 * test part ainsi d'un état propre et isolé, sans registry résiduel d'un test précédent.
 */
async function setRegistries(registries: SetupRegistryConfig[]): Promise<void> {
  await completeSetup({ registries });
}

describe("getEffectiveRegistryCredentialsForImage — plusieurs registries du même kind", () => {
  it("désambiguïse deux comptes GHCR (pro/perso) par organisation, chacun retournant ses propres identifiants", async () => {
    await setRegistries([
      { kind: "ghcr", name: "GHCR_MAIRIE", url: "https://ghcr.io", username: "mairie-lecreusot", token: "token-pro" },
      { kind: "ghcr", name: "GHCR_PERSO", url: "https://ghcr.io", username: "ybanas", token: "token-perso" },
    ]);

    const pro = await getEffectiveRegistryCredentialsForImage("ghcr", "ghcr.io/mairie-lecreusot/portail-citoyen");
    expect(pro?.token).toBe("token-pro");

    const perso = await getEffectiveRegistryCredentialsForImage("ghcr", "ghcr.io/ybanas/mon-projet");
    expect(perso?.token).toBe("token-perso");

    // Jamais celle du premier registry pour la deuxième image (régression cible du bug corrigé).
    expect(perso?.token).not.toBe(pro?.token);
  });

  it("scale à N comptes GHCR (6+) — chacun résolu par son propre username, jamais écrasé par un autre", async () => {
    const orgs = ["org-a", "org-b", "org-c", "org-d", "org-e", "org-f"];
    await setRegistries(
      orgs.map((org) => ({ kind: "ghcr" as const, name: `GHCR_${org}`, url: "https://ghcr.io", username: org, token: `token-${org}` })),
    );

    for (const org of orgs) {
      const creds = await getEffectiveRegistryCredentialsForImage("ghcr", `ghcr.io/${org}/some-image`);
      expect(creds?.token).toBe(`token-${org}`);
    }
  });

  it("retombe sur le premier registry du kind quand aucun username ne correspond (org non configurée)", async () => {
    await setRegistries([
      { kind: "ghcr", name: "GHCR_MAIRIE", url: "https://ghcr.io", username: "mairie-lecreusot", token: "token-pro" },
      { kind: "ghcr", name: "GHCR_PERSO", url: "https://ghcr.io", username: "ybanas", token: "token-perso" },
    ]);

    const inconnu = await getEffectiveRegistryCredentialsForImage("ghcr", "ghcr.io/une-autre-org/projet");
    expect(inconnu?.token).toBe("token-pro"); // premier configuré, comportement de repli documenté
  });

  it("aucune régression pour un déploiement à une seule entrée par kind (comportement historique préservé)", async () => {
    await setRegistries([
      { kind: "ghcr", name: "GHCR_MAIRIE", url: "https://ghcr.io", username: "mairie-lecreusot", token: "token-unique" },
    ]);

    const viaImage = await getEffectiveRegistryCredentialsForImage("ghcr", "ghcr.io/nimporte-quelle-org/projet");
    const viaKind = await getEffectiveRegistryCredentials("ghcr");
    expect(viaImage?.token).toBe("token-unique");
    expect(viaImage).toEqual(viaKind);
  });

  it("désambiguïse Docker Hub par namespace (compte pro/perso)", async () => {
    await setRegistries([
      { kind: "dockerhub", name: "DockerHub pro", url: "https://hub.docker.com", username: "mairie-org", password: "pw-pro" },
      { kind: "dockerhub", name: "DockerHub perso", url: "https://hub.docker.com", username: "ybanas", password: "pw-perso" },
    ]);

    const pro = await getEffectiveRegistryCredentialsForImage("dockerhub", "mairie-org/site-vitrine");
    expect(pro?.password).toBe("pw-pro");

    const perso = await getEffectiveRegistryCredentialsForImage("dockerhub", "ybanas/side-project");
    expect(perso?.password).toBe("pw-perso");
  });

  it("une image officielle Docker Hub sans namespace (ex: nginx) retombe sur le premier registry configuré, sans erreur", async () => {
    await setRegistries([
      { kind: "dockerhub", name: "DockerHub pro", url: "https://hub.docker.com", username: "mairie-org", password: "pw-pro" },
      { kind: "dockerhub", name: "DockerHub perso", url: "https://hub.docker.com", username: "ybanas", password: "pw-perso" },
    ]);

    const officielle = await getEffectiveRegistryCredentialsForImage("dockerhub", "nginx");
    expect(officielle?.password).toBe("pw-pro"); // premier configuré — lecture publique, aucune auth requise de toute façon
  });

  it("désambiguïse GitLab par hôte (deux instances auto-hébergées distinctes)", async () => {
    await setRegistries([
      { kind: "gitlab", name: "GitLab Mairie", url: "https://gitlab.mairie.fr", token: "token-mairie" },
      { kind: "gitlab", name: "GitLab Autre", url: "https://gitlab.autre-organisation.fr", token: "token-autre" },
    ]);

    const mairie = await getEffectiveRegistryCredentialsForImage("gitlab", "gitlab.mairie.fr/groupe/projet");
    expect(mairie?.token).toBe("token-mairie");

    const autre = await getEffectiveRegistryCredentialsForImage("gitlab", "gitlab.autre-organisation.fr/groupe/projet");
    expect(autre?.token).toBe("token-autre");
  });

  it("désambiguïse Harbor par hôte, même principe que GitLab", async () => {
    await setRegistries([
      { kind: "harbor", name: "Harbor A", url: "https://harbor.a.example.org", token: "token-a" },
      { kind: "harbor", name: "Harbor B", url: "https://harbor.b.example.org", token: "token-b" },
    ]);

    const a = await getEffectiveRegistryCredentialsForImage("harbor", "harbor.a.example.org/projet/image");
    expect(a?.token).toBe("token-a");
    const b = await getEffectiveRegistryCredentialsForImage("harbor", "harbor.b.example.org/projet/image");
    expect(b?.token).toBe("token-b");
  });

  it("retourne null si aucun registry du kind demandé n'est configuré", async () => {
    await setRegistries([{ kind: "ghcr", name: "GHCR_MAIRIE", url: "https://ghcr.io", username: "mairie-lecreusot", token: "token-pro" }]);
    const result = await getEffectiveRegistryCredentialsForImage("harbor", "harbor.example.org/projet/image");
    expect(result).toBeNull();
  });

  it("ignore un username GHCR ressemblant à un e-mail pour la désambiguïsation (jamais un org/user GitHub valide)", async () => {
    await setRegistries([
      { kind: "ghcr", name: "GHCR via email", url: "https://ghcr.io", username: "quelquun@example.org", token: "token-email" },
      { kind: "ghcr", name: "GHCR_PERSO", url: "https://ghcr.io", username: "ybanas", token: "token-perso" },
    ]);

    const perso = await getEffectiveRegistryCredentialsForImage("ghcr", "ghcr.io/ybanas/mon-projet");
    expect(perso?.token).toBe("token-perso");
  });
});
