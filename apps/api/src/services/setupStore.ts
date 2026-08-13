/**
 * Assistant de configuration au premier lancement (cf. ARCHITECTURE.md, chapitre
 * "Assistant de configuration au premier lancement").
 *
 * Persistance JSON sur disque (CONFIG_PATH, défaut ./data/config.json en dev). Chargé une
 * fois au premier accès puis mis en cache en mémoire process ; toute écriture (complete/
 * reset) met à jour le cache et le fichier de façon synchrone l'un avec l'autre.
 *
 * Les variables d'environnement (LDAP_*, DOCKER_HOST, KUBECONFIG) restent un mécanisme de
 * bootstrap pour un déploiement scripté : si présentes au tout premier démarrage et
 * qu'aucun config.json n'existe encore, elles pré-remplissent la config candidate
 * (`completed: false`) sans jamais marquer l'assistant terminé automatiquement — seul un
 * appel explicite à POST /api/setup/complete (après test) fait passer `completed` à true.
 *
 * Secrets au repos : le mot de passe LDAP, le kubeconfig et les identifiants de registry
 * sont chiffrés (AES-256-GCM, voir crypto.ts) avant d'être écrits sur disque — le fichier
 * ne contient jamais de secret en clair. Un ancien config.json écrit avant l'introduction de
 * ce chiffrement est migré automatiquement (déchiffré transparemment, rechiffré et réécrit)
 * au premier accès suivant le déploiement de cette version. Aucun secret n'est journalisé
 * par ce module, chiffré ou non.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { decryptSecret, encryptSecretIfNeeded, isEncrypted } from "./crypto.js";
import type { RegistryKind, Role } from "../types.js";

export interface SetupLdapConfig {
  url: string;
  bindDn: string;
  bindPassword: string;
  searchBase: string;
  searchFilter: string;
  groupRoleMap: Record<string, Role>;
  defaultRole: Role;
}

export interface SetupDockerConfig {
  host?: string;
}

export interface SetupKubernetesConfig {
  // Contenu YAML brut du kubeconfig collé dans l'assistant (pas un chemin de fichier).
  kubeconfigYaml?: string;
}

export interface SetupNutanixConfig {
  // URL de Prism Central (ex: "https://prism.lecreusot.fr:9440").
  prismCentralUrl: string;
  username: string;
  // password : chiffré au repos (voir encryptSecrets ci-dessous), comme le mot de passe LDAP
  // et le kubeconfig.
  password: string;
}

/**
 * DNS Active Directory (RFC 2136 + GSS-TSIG, voir services/adDns.ts et types.ts#AdDnsConfig) —
 * config distincte de l'assistant de configuration au premier lancement (jamais requise pour
 * `completed`) : gérée en continu via GET/PUT/DELETE /api/ad-dns/config (routes/adDns.ts), même
 * principe que l'ajout d'un registry en dehors de l'assistant (addRegistry ci-dessous).
 */
export interface SetupAdDnsConfig {
  realm: string;
  kdcHost: string;
  zone: string;
  serviceAccount: string;
  // password : chiffré au repos (voir encryptSecrets ci-dessous), comme le mot de passe LDAP.
  password: string;
  targetIp: string;
}

export interface SetupRegistryConfig {
  kind: RegistryKind;
  name: string;
  url: string;
  username?: string;
  // password/token : chiffrés au repos (voir encryptSecrets/decryptRegistry ci-dessous).
  password?: string;
  token?: string;
}

export interface SetupConfig {
  completed: boolean;
  /**
   * true dès que l'assistant a été terminé AU MOINS UNE FOIS — contrairement à `completed`,
   * jamais remis à `false` par resetSetup() (voir plugins/auth.ts). Distingue un VRAI premier
   * démarrage (aucune session requise sur /api/setup/*, seul cas légitime) d'une réouverture de
   * l'assistant par un admin déjà authentifié (completed=false temporairement, mais everCompleted
   * reste true) — sans cette distinction, POST /api/setup/complete redevenait accessible sans
   * authentification pendant toute la fenêtre de reconfiguration, permettant à quiconque sur le
   * réseau d'y injecter un LDAP qu'il contrôle et de s'octroyer le rôle admin (voir
   * docs/reports/security-audit-2026-08-12.md, finding C1).
   */
  everCompleted?: boolean;
  ldap?: SetupLdapConfig;
  docker?: SetupDockerConfig;
  kubernetes?: SetupKubernetesConfig;
  nutanix?: SetupNutanixConfig;
  registries?: SetupRegistryConfig[];
  adDns?: SetupAdDnsConfig;
}

let cache: SetupConfig | null = null;

function resolvedConfigPath(): string {
  return path.resolve(config.setup.configPath);
}

/** Pré-remplissage best-effort depuis les variables d'environnement (mécanisme de bootstrap). */
function defaultCandidate(): SetupConfig {
  const hasLdapEnv = process.env.LDAP_URL !== undefined || process.env.LDAP_BIND_DN !== undefined;

  return {
    completed: false,
    ...(hasLdapEnv
      ? {
          ldap: {
            url: config.ldap.url,
            bindDn: config.ldap.bindDn,
            bindPassword: config.ldap.bindPassword,
            searchBase: config.ldap.searchBase,
            searchFilter: config.ldap.searchFilter,
            groupRoleMap: config.ldap.groupRoleMap,
            defaultRole: config.ldap.defaultRole,
          },
        }
      : {}),
    ...(config.docker.host ? { docker: { host: config.docker.host } } : {}),
    // KUBECONFIG (env) est un chemin de fichier, pas un contenu collé : non pré-rempli.
  };
}

/**
 * Chiffre (si besoin) tous les champs secrets d'une config avant écriture disque.
 * Utilise des spreads conditionnels (pas `champ: cfg.champ && {...}`) car exactOptionalPropertyTypes
 * interdit d'assigner explicitement `undefined` à une propriété optionnelle — il faut omettre
 * la clé plutôt que la mettre à `undefined`.
 */
function encryptSecrets(cfg: SetupConfig): SetupConfig {
  return {
    ...cfg,
    ...(cfg.ldap
      ? { ldap: { ...cfg.ldap, bindPassword: encryptSecretIfNeeded(cfg.ldap.bindPassword) } }
      : {}),
    ...(cfg.kubernetes?.kubeconfigYaml
      ? { kubernetes: { ...cfg.kubernetes, kubeconfigYaml: encryptSecretIfNeeded(cfg.kubernetes.kubeconfigYaml) } }
      : {}),
    ...(cfg.nutanix?.password
      ? { nutanix: { ...cfg.nutanix, password: encryptSecretIfNeeded(cfg.nutanix.password) } }
      : {}),
    ...(cfg.adDns?.password
      ? { adDns: { ...cfg.adDns, password: encryptSecretIfNeeded(cfg.adDns.password) } }
      : {}),
    ...(cfg.registries
      ? {
          registries: cfg.registries.map((r) => ({
            ...r,
            ...(r.password !== undefined ? { password: encryptSecretIfNeeded(r.password) } : {}),
            ...(r.token !== undefined ? { token: encryptSecretIfNeeded(r.token) } : {}),
          })),
        }
      : {}),
  };
}

/** true si la config chargée depuis le disque contient encore un secret en clair (ancien format). */
function hasLegacyPlaintextSecret(cfg: SetupConfig): boolean {
  if (cfg.ldap && !isEncrypted(cfg.ldap.bindPassword)) return true;
  if (cfg.kubernetes?.kubeconfigYaml && !isEncrypted(cfg.kubernetes.kubeconfigYaml)) return true;
  if (cfg.nutanix?.password && !isEncrypted(cfg.nutanix.password)) return true;
  if (cfg.adDns?.password && !isEncrypted(cfg.adDns.password)) return true;
  if (cfg.registries?.some((r) => (r.password && !isEncrypted(r.password)) || (r.token && !isEncrypted(r.token)))) {
    return true;
  }
  return false;
}

async function readFromDisk(): Promise<SetupConfig | null> {
  try {
    const raw = await fs.readFile(resolvedConfigPath(), "utf-8");
    return JSON.parse(raw) as SetupConfig;
  } catch {
    return null;
  }
}

async function writeToDisk(next: SetupConfig): Promise<void> {
  const filePath = resolvedConfigPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // mode 0o600 : lisible/écrivable uniquement par le compte qui fait tourner le process —
  // le fichier contient des secrets chiffrés, mais autant limiter aussi l'accès au fichier.
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export async function getCurrent(): Promise<SetupConfig> {
  if (cache) return cache;

  const fromDisk = await readFromDisk();
  if (fromDisk) {
    if (hasLegacyPlaintextSecret(fromDisk)) {
      // Migration transparente d'un config.json écrit avant l'introduction du chiffrement au
      // repos : on rechiffre et on réécrit immédiatement, une seule fois.
      const migrated = encryptSecrets(fromDisk);
      await writeToDisk(migrated);
      cache = migrated;
      return cache;
    }
    cache = fromDisk;
    return cache;
  }

  cache = defaultCandidate();
  return cache;
}

export async function isSetupCompleted(): Promise<boolean> {
  return (await getCurrent()).completed;
}

/** Voir SetupConfig#everCompleted — jamais remis à false, y compris après resetSetup(). */
export async function hasEverCompletedSetup(): Promise<boolean> {
  return (await getCurrent()).everCompleted === true;
}

export type SetupCandidate = Omit<SetupConfig, "completed" | "everCompleted">;

/** POST /api/setup/complete — persiste la config candidate (secrets chiffrés) et marque l'assistant terminé. */
export async function completeSetup(candidate: SetupCandidate): Promise<SetupConfig> {
  const next: SetupConfig = encryptSecrets({ ...candidate, completed: true, everCompleted: true });
  await writeToDisk(next);
  cache = next;
  return next;
}

/** POST /api/setup/reset — repasse en mode assistant (les valeurs déjà saisies restent pré-remplies). */
export async function resetSetup(): Promise<SetupConfig> {
  const current = await getCurrent();
  const next: SetupConfig = { ...current, completed: false };
  await writeToDisk(next);
  cache = next;
  return next;
}

/**
 * Ajoute un registry en dehors de l'assistant (POST /api/registries) sans toucher au reste de
 * la config (LDAP/Docker/K8s/autres registries) — utilisé par registriesStore.ts, seule source
 * de vérité pour la liste des registries (voir ARCHITECTURE.md).
 */
export async function addRegistry(input: SetupRegistryConfig): Promise<SetupConfig> {
  const current = await getCurrent();
  const next: SetupConfig = encryptSecrets({
    ...current,
    registries: [...(current.registries ?? []), input],
  });
  await writeToDisk(next);
  cache = next;
  return next;
}

export interface RegistryPatch {
  name?: string;
  url?: string;
  username?: string;
  // password/token vides ou absents = "conserver le secret existant" — seule une valeur non
  // vide déclenche un remplacement (voir updateRegistryAt) : sinon rouvrir le formulaire pour
  // ne changer que le nom effacerait silencieusement l'identifiant déjà enregistré.
  password?: string;
  token?: string;
}

/**
 * Met à jour le registry à l'index `index` du tableau persisté (même indexation que l'id de
 * vue "reg-<kind>-<index>" construit par registriesStore.ts). `password`/`token` ne sont
 * remplacés que si une valeur non vide est fournie ; le reste écrase toujours (name/url/username
 * vides sont des choix valides de l'utilisateur, contrairement aux secrets).
 */
export async function updateRegistryAt(index: number, patch: RegistryPatch): Promise<SetupConfig> {
  const current = await getCurrent();
  const registries = current.registries ?? [];
  const existing = registries[index];
  if (!existing) {
    throw new Error(`No registry at index ${index}`);
  }
  const merged: SetupRegistryConfig = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.url !== undefined ? { url: patch.url } : {}),
    ...(patch.username !== undefined ? { username: patch.username } : {}),
    ...(patch.password ? { password: patch.password } : {}),
    ...(patch.token ? { token: patch.token } : {}),
  };
  const next: SetupConfig = encryptSecrets({
    ...current,
    registries: registries.map((r, i) => (i === index ? merged : r)),
  });
  await writeToDisk(next);
  cache = next;
  return next;
}

/** Config LDAP effective (secret déchiffré) : celle de l'assistant si persistée, sinon les valeurs d'environnement. */
export async function getEffectiveLdapConfig(): Promise<SetupLdapConfig> {
  const current = await getCurrent();
  if (!current.ldap) {
    return {
      url: config.ldap.url,
      bindDn: config.ldap.bindDn,
      bindPassword: config.ldap.bindPassword,
      searchBase: config.ldap.searchBase,
      searchFilter: config.ldap.searchFilter,
      groupRoleMap: config.ldap.groupRoleMap,
      defaultRole: config.ldap.defaultRole,
    };
  }
  return { ...current.ldap, bindPassword: decryptSecret(current.ldap.bindPassword) };
}

/**
 * Config Docker effective : celle persistée par l'assistant si présente (même un objet vide
 * {} — "testé, hôte par défaut"), sinon DOCKER_HOST. Même principe que getEffectiveLdapConfig :
 * sans ceci, un hôte Docker candidat saisi dans l'assistant serait sauvegardé mais jamais
 * réellement utilisé par src/services/docker.ts. (Rien à déchiffrer ici : un hôte Docker
 * n'est pas un secret.)
 */
export async function getEffectiveDockerConfig(): Promise<SetupDockerConfig> {
  const current = await getCurrent();
  if (current.docker) return current.docker;
  return config.docker.host ? { host: config.docker.host } : {};
}

/** Config Kubernetes effective (kubeconfig déchiffré) : celui de l'assistant si présent, sinon KUBECONFIG (chemin de fichier). */
export async function getEffectiveKubernetesConfig(): Promise<SetupKubernetesConfig> {
  const current = await getCurrent();
  if (!current.kubernetes?.kubeconfigYaml) return current.kubernetes ?? {};
  return { ...current.kubernetes, kubeconfigYaml: decryptSecret(current.kubernetes.kubeconfigYaml) };
}

/**
 * Config Nutanix effective (mot de passe déchiffré) : celle persistée par l'assistant, sinon
 * `null` — contrairement à Docker/Kubernetes, Nutanix n'a pas de mécanisme de bootstrap par
 * variables d'environnement (il faut toujours une URL Prism Central + des identifiants
 * explicites, saisis dans l'assistant) : rien à pré-remplir "au mieux" ici.
 */
export async function getEffectiveNutanixConfig(): Promise<SetupNutanixConfig | null> {
  const current = await getCurrent();
  if (!current.nutanix) return null;
  return { ...current.nutanix, password: decryptSecret(current.nutanix.password) };
}

/**
 * PUT /api/nutanix/config — configure/remplace Nutanix EN DEHORS de l'assistant de premier
 * lancement (mot de passe chiffré avant écriture). Avant l'ajout de cette fonction, la SEULE
 * façon de configurer Nutanix était l'étape "Orchestrateurs" de l'assistant — donc invisible/
 * inaccessible pour un admin qui a déjà terminé la configuration initiale sans Nutanix et veut
 * l'ajouter ensuite (page Environnements) sans repasser par un `POST /api/setup/reset` complet
 * (qui rouvre TOUT l'assistant, LDAP compris). Même principe que setAdDnsConfig ci-dessous :
 * n'affecte aucune autre section de la config.
 */
export async function setNutanixConfig(input: SetupNutanixConfig): Promise<SetupConfig> {
  const current = await getCurrent();
  const next: SetupConfig = encryptSecrets({ ...current, nutanix: input });
  await writeToDisk(next);
  cache = next;
  return next;
}

/** DELETE /api/nutanix/config — retire la configuration Nutanix (retour à "jamais configuré",
 * GET /api/nutanix/vms et le nœud de topologie associé redeviennent [] / absent). */
export async function clearNutanixConfig(): Promise<SetupConfig> {
  const current = await getCurrent();
  const { nutanix: _removed, ...rest } = current;
  const next: SetupConfig = rest;
  await writeToDisk(next);
  cache = next;
  return next;
}

/** Config DNS AD effective (mot de passe déchiffré), ou `null` si jamais configurée — même
 * principe que getEffectiveNutanixConfig (aucun mécanisme de bootstrap par variable
 * d'environnement pour cette intégration, toujours saisie explicitement). */
export async function getEffectiveAdDnsConfig(): Promise<SetupAdDnsConfig | null> {
  const current = await getCurrent();
  if (!current.adDns) return null;
  return { ...current.adDns, password: decryptSecret(current.adDns.password) };
}

/** PUT /api/ad-dns/config — remplace la config DNS AD entière (mot de passe chiffré avant
 * écriture). N'affecte aucune autre section de la config (ldap/docker/k8s/nutanix/registries). */
export async function setAdDnsConfig(input: SetupAdDnsConfig): Promise<SetupConfig> {
  const current = await getCurrent();
  const next: SetupConfig = encryptSecrets({ ...current, adDns: input });
  await writeToDisk(next);
  cache = next;
  return next;
}

/** DELETE /api/ad-dns/config — désactive la synchronisation DNS automatique (retour au mode
 * manuel/fichier hosts pour les futures routes ; les enregistrements DNS déjà créés ne sont PAS
 * supprimés rétroactivement, QUAI n'a plus les moyens de les gérer une fois la config effacée). */
export async function clearAdDnsConfig(): Promise<SetupConfig> {
  const current = await getCurrent();
  const { adDns: _removed, ...rest } = current;
  const next: SetupConfig = rest;
  await writeToDisk(next);
  cache = next;
  return next;
}

export interface EffectiveRegistryCredentials {
  username?: string;
  password?: string;
  token?: string;
}

/**
 * Identifiants effectifs (déchiffrés) du premier registry persisté correspondant à `kind`,
 * ou `null` si aucun n'est configuré via l'assistant — dans ce cas les clients registries
 * (src/services/registries/*) retombent sur les variables d'environnement globales
 * (DOCKERHUB_TOKEN, GHCR_TOKEN, GITLAB_TOKEN).
 *
 * LIMITATION CONNUE : sélectionne par `kind` seul, pas par registry précis. Avec UN SEUL
 * registry par kind (cas actuel de tous les déploiements testés), aucun souci. Si un jour
 * DEUX registries GHCR (ou deux Docker Hub, etc.) sont configurés, les appels concernant le
 * second utiliseraient quand même les identifiants du premier — trouvé en vérifiant le système
 * de diagnostic d'exploration de catalogue (registries/index.ts#diagnosticFromError), pas
 * encore corrigé (nécessiterait de faire remonter l'id de registry, pas seulement le kind,
 * jusqu'à chaque client registries/*.ts).
 */
export async function getEffectiveRegistryCredentials(kind: RegistryKind): Promise<EffectiveRegistryCredentials | null> {
  const current = await getCurrent();
  const match = current.registries?.find((r) => r.kind === kind);
  if (!match) return null;
  return {
    ...(match.username !== undefined ? { username: match.username } : {}),
    ...(match.password !== undefined ? { password: decryptSecret(match.password) } : {}),
    ...(match.token !== undefined ? { token: decryptSecret(match.token) } : {}),
  };
}
