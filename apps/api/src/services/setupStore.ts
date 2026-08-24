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
import { writeFileRestricted } from "../utils/secureFile.js";
import type { RegistryKind, Role } from "../types.js";
// Types purs (effacés à la compilation) : aucune dépendance runtime vers services/exagrid.ts,
// qui lui importe RÉELLEMENT ce module.
import type { ExagridAuthProtocol, ExagridPrivProtocol, ExagridSecurityLevel, ExagridSnmpVersion } from "./exagrid.js";

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
 * HYCU (contrôleur de sauvegarde des VMs Nutanix, API REST /rest/v1.0 sur :8443) — stocké ICI,
 * dans le même config.json que Nutanix, plutôt que dans un store dédié type remoteDockerStore :
 * même nature exacte (une appliance interne unique, URL + identifiants, mot de passe chiffré au
 * repos), même cycle de vie (configurable/retirable en dehors de l'assistant via
 * /api/hycu/config). Cohérence d'abord — voir services/hycu.ts.
 */
export interface SetupHycuConfig {
  // URL du contrôleur HYCU (ex: "https://172.20.0.100:8443").
  url: string;
  username: string;
  // password : chiffré au repos (voir encryptSecrets ci-dessous), comme nutanix.password.
  password: string;
}

/**
 * GLPI (outil de tickets de la mairie, API REST apirest.php) — même emplacement et même cycle de
 * vie que SetupHycuConfig ci-dessus (configurable/retirable via /api/glpi/config). L'app_token est
 * TOUJOURS requis ; l'authentification se fait au choix par user_token OU par login/mot de passe
 * d'un compte de service. Les trois secrets sont chiffrés au repos et ne ressortent JAMAIS d'une
 * route (voir routes/glpi.ts#toPublicConfig) — voir services/glpi.ts.
 */
export interface SetupGlpiConfig {
  // URL de l'API (ex: "http://172.16.8.22/apirest.php").
  apiUrl: string;
  // appToken/userToken/password : chiffrés au repos (voir encryptSecrets ci-dessous).
  appToken: string;
  userToken?: string;
  username?: string;
  password?: string;
}

/**
 * PBX 3CX (XAPI OData, voir services/threecx.ts) — stocké ICI comme HYCU/Nutanix : une instance
 * interne unique, même cycle de vie (/api/3cx/config). Deux voies d'authentification possibles vers
 * le MÊME XAPI (`Authorization: Bearer`), au choix de l'admin :
 *  - "client-credentials" : clientId = DN du point de routage créé dans Admin Console →
 *    Integrations > API, clientSecret = la clé remise UNE SEULE FOIS, échangés sur /connect/token.
 *  - "user" : identifiant + mot de passe d'une extension disposant des droits propriétaire système,
 *    échangés sur /webclient/api/Login/GetAccessToken — seule voie disponible quand l'entrée
 *    Integrations > API est absente de la console (build/licence).
 * clientSecret ET password sont chiffrés au repos et ne ressortent JAMAIS d'une route.
 */
export type ThreecxAuthMode = "client-credentials" | "user";

export interface SetupThreecxConfig {
  // URL de base du PBX (ex: "https://pbx.exemple.fr:5001") — sans le suffixe /xapi/v1.
  baseUrl: string;
  // Absent dans une config écrite avant l'ajout du mode identifiant : migré en "client-credentials"
  // à la lecture par getEffectiveThreecxConfig (jamais réécrit en place tant que rien ne change).
  authMode?: ThreecxAuthMode;
  clientId?: string;
  // clientSecret : chiffré au repos (voir encryptSecrets ci-dessous), comme hycu.password.
  clientSecret?: string;
  username?: string;
  // password : chiffré au repos, exactement comme clientSecret.
  password?: string;
  // Absent = défaut config.threecx.tlsRejectUnauthorized. Pas un secret.
  tlsRejectUnauthorized?: boolean;
}

/**
 * ExaGrid (appliance de sauvegarde) — stocké ICI comme HYCU/Nutanix : même nature (une appliance
 * interne unique), même cycle de vie (/api/exagrid/config). Pas d'API REST côté ExaGrid : la
 * config décrit une session SNMP v2c OU v3 (voir services/exagrid.ts).
 */
export interface SetupExagridConfig {
  host: string;
  port: number;
  version: ExagridSnmpVersion;
  // v2c — community : chiffrée au repos (voir encryptSecrets ci-dessous), jamais renvoyée.
  community?: string;
  // v3 — username/securityLevel/protocoles ne sont PAS secrets ; authKey/privKey le sont.
  username?: string;
  securityLevel?: ExagridSecurityLevel;
  authProtocol?: ExagridAuthProtocol;
  authKey?: string;
  privProtocol?: ExagridPrivProtocol;
  privKey?: string;
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

/**
 * Autorité de certification interne AD CS de la mairie (voir services/certificates.ts) — même
 * emplacement et même cycle de vie que SetupHycuConfig ci-dessus (configurable/retirable via
 * /api/certificates/config). `password` est le mot de passe du compte de service autorisé à
 * s'inscrire sur le site d'inscription web `certsrv` : chiffré au repos, jamais renvoyé par une
 * route, jamais journalisé.
 */
export type CertificateEnrollmentMethod = "certsrv";

export interface SetupCertificatesConfig {
  // URL du site d'inscription web AD CS (ex: "https://ca.lecreusot.priv/certsrv").
  caUrl: string;
  // Absente dans une config écrite avant l'ajout d'une seconde voie : lue comme "certsrv".
  method?: CertificateEnrollmentMethod;
  // Nom du modèle de certificat AD CS (ex: "WebServer").
  template: string;
  username: string;
  // password : chiffré au repos (voir encryptSecrets ci-dessous), comme hycu.password.
  password: string;
  // Marge de renouvellement en jours ; absent = config.certificates.renewBeforeDays.
  renewBeforeDays?: number;
  // Taille de clé RSA ; absent = 2048 (minimum usuel d'un modèle AD CS moderne).
  keySize?: number;
  // Émettre automatiquement un certificat pour tout sous-domaine du reverse proxy qui n'en a pas
  // encore. Absent = true.
  autoEnroll?: boolean;
  // Absent = défaut config.certificates.tlsRejectUnauthorized. Pas un secret.
  tlsRejectUnauthorized?: boolean;
}

export interface SetupRegistryConfig {
  kind: RegistryKind;
  name: string;
  url: string;
  username?: string;
  // password/token : chiffrés au repos (voir encryptSecrets/decryptRegistry ci-dessous).
  password?: string;
  token?: string;
  // Organisation GitHub (ghcr) ou namespace/compte (dockerhub) EXPLICITEMENT configuré —
  // INDÉPENDANT de `username` (identité de connexion : GHCR demande souvent un e-mail comme
  // identifiant `docker login`, qui n'est jamais un org/user GitHub valide). Pas un secret,
  // jamais chiffré. Toujours prioritaire sur toute déduction (username-sans-@, inférence depuis
  // les images locales) — voir registriesStore.ts#resolveRegistryOrg, seule fonction qui
  // implémente cette résolution (utilisée à la fois par le compteur "images suivies" et par
  // l'explorateur de catalogue, pour qu'ils ne divergent jamais).
  org?: string;
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
  hycu?: SetupHycuConfig;
  glpi?: SetupGlpiConfig;
  threecx?: SetupThreecxConfig;
  exagrid?: SetupExagridConfig;
  registries?: SetupRegistryConfig[];
  adDns?: SetupAdDnsConfig;
  certificates?: SetupCertificatesConfig;
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

/** Applique `transform` aux SEULS champs secrets d'ExaGrid (community/authKey/privKey) — host,
 * port, version, username et noms de protocoles ne sont pas des secrets. */
function mapExagridSecrets(cfg: SetupExagridConfig, transform: (value: string) => string): SetupExagridConfig {
  return {
    ...cfg,
    ...(cfg.community !== undefined ? { community: transform(cfg.community) } : {}),
    ...(cfg.authKey !== undefined ? { authKey: transform(cfg.authKey) } : {}),
    ...(cfg.privKey !== undefined ? { privKey: transform(cfg.privKey) } : {}),
  };
}

/** Applique `transform` aux SEULS champs secrets de GLPI (appToken/userToken/password) — apiUrl et
 * username (compte de service) ne sont pas des secrets. */
function mapGlpiSecrets(cfg: SetupGlpiConfig, transform: (value: string) => string): SetupGlpiConfig {
  return {
    ...cfg,
    appToken: transform(cfg.appToken),
    ...(cfg.userToken !== undefined ? { userToken: transform(cfg.userToken) } : {}),
    ...(cfg.password !== undefined ? { password: transform(cfg.password) } : {}),
  };
}

/** Applique `transform` aux SEULS champs secrets de 3CX (clientSecret/password) — baseUrl, authMode,
 * clientId et username ne sont pas des secrets. */
function mapThreecxSecrets(cfg: SetupThreecxConfig, transform: (value: string) => string): SetupThreecxConfig {
  return {
    ...cfg,
    ...(cfg.clientSecret ? { clientSecret: transform(cfg.clientSecret) } : {}),
    ...(cfg.password ? { password: transform(cfg.password) } : {}),
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
    ...(cfg.hycu?.password
      ? { hycu: { ...cfg.hycu, password: encryptSecretIfNeeded(cfg.hycu.password) } }
      : {}),
    ...(cfg.glpi ? { glpi: mapGlpiSecrets(cfg.glpi, encryptSecretIfNeeded) } : {}),
    ...(cfg.threecx ? { threecx: mapThreecxSecrets(cfg.threecx, encryptSecretIfNeeded) } : {}),
    ...(cfg.exagrid ? { exagrid: mapExagridSecrets(cfg.exagrid, encryptSecretIfNeeded) } : {}),
    ...(cfg.adDns?.password
      ? { adDns: { ...cfg.adDns, password: encryptSecretIfNeeded(cfg.adDns.password) } }
      : {}),
    ...(cfg.certificates?.password
      ? { certificates: { ...cfg.certificates, password: encryptSecretIfNeeded(cfg.certificates.password) } }
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
  if (cfg.hycu?.password && !isEncrypted(cfg.hycu.password)) return true;
  if (cfg.glpi && [cfg.glpi.appToken, cfg.glpi.userToken, cfg.glpi.password].some((s) => s && !isEncrypted(s))) return true;
  if (cfg.threecx && [cfg.threecx.clientSecret, cfg.threecx.password].some((s) => s && !isEncrypted(s))) return true;
  if (cfg.exagrid && [cfg.exagrid.community, cfg.exagrid.authKey, cfg.exagrid.privKey].some((s) => s && !isEncrypted(s))) return true;
  if (cfg.adDns?.password && !isEncrypted(cfg.adDns.password)) return true;
  if (cfg.certificates?.password && !isEncrypted(cfg.certificates.password)) return true;
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
  // 0600 réellement forcé (y compris sur un fichier déjà existant avec des permissions plus
  // larges héritées d'une écriture antérieure à ce durcissement) — voir utils/secureFile.ts,
  // le fichier contient des secrets chiffrés mais aussi des champs en clair (ldap.url/bindDn,
  // groupRoleMap) dont l'altération suffirait à détourner l'authentification.
  await writeFileRestricted(resolvedConfigPath(), JSON.stringify(next, null, 2));
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
  // org : PAS un secret, donc PAS la même convention que password/token — même principe que
  // name/url (« vides sont des choix valides de l'utilisateur »). Une chaîne vide EFFACE
  // explicitement l'organisation configurée et fait retomber la résolution sur l'ancienne
  // déduction (username-sans-@, puis image locale) — seule l'ABSENCE de la clé laisse l'org déjà
  // enregistrée inchangée. Décision de conception assumée : contrairement à password/token, il
  // n'existe aucun moyen de distinguer « l'utilisateur veut effacer l'org » de « l'utilisateur a
  // laissé le champ vide sans y penser » autrement que par cette convention explicite du champ.
  org?: string;
}

/**
 * Met à jour le registry à l'index `index` du tableau persisté (même indexation que l'id de
 * vue "reg-<kind>-<index>" construit par registriesStore.ts). `password`/`token` ne sont
 * remplacés que si une valeur non vide est fournie ; le reste écrase toujours (name/url/username
 * vides sont des choix valides de l'utilisateur, contrairement aux secrets).
 *
 * Bug réel corrigé le 14/08/2026 (retour utilisateur : "sa doit utiliser les bon identifiant
 * rentrer car sa utilise mon compt au lieux des info que jai mis") — root-causé en lisant le
 * registry réellement configuré sur disque : `password` ET `token` étaient TOUS LES DEUX
 * présents (saisis à des moments différents, probablement via une confusion entre les deux champs
 * du formulaire d'édition — "Mot de passe"/"Jeton d'accès" pour ce qui n'est, pour GHCR comme pour
 * la plupart des registries à un seul secret, qu'UN SEUL identifiant réel). resolveToken()
 * (registries/ghcr.ts) préfère `.token` à `.password` : un jeton ANCIEN et non pertinent (ex :
 * saisi par erreur une première fois) continuait donc silencieusement de primer sur le mot de
 * passe fraîchement corrigé, qui ne remplaçait jamais rien tant que `.token` restait présent.
 * Un registry n'a jamais qu'UN SEUL secret actif à la fois : fournir explicitement l'un des deux
 * efface maintenant l'autre plutôt que de laisser une valeur périmée cohabiter et prendre le pas.
 */
export async function updateRegistryAt(index: number, patch: RegistryPatch): Promise<SetupConfig> {
  const current = await getCurrent();
  const registries = current.registries ?? [];
  const existing = registries[index];
  if (!existing) {
    throw new Error(`No registry at index ${index}`);
  }
  // `exactOptionalPropertyTypes` interdit `{ token: undefined }` pour "effacer" la clé — on
  // construit `secretFields` séparément puis on l'étale, en omettant explicitement l'autre champ
  // via déstructuration plutôt que de lui assigner `undefined` (voir commentaire de tête ci-dessus
  // pour le pourquoi de cet effacement croisé).
  const { password: _droppedPassword, token: _droppedToken, ...existingWithoutSecrets } = existing;
  const secretFields: Pick<SetupRegistryConfig, "password" | "token"> = patch.password
    ? { password: patch.password }
    : patch.token
      ? { token: patch.token }
      : { ...(existing.password !== undefined ? { password: existing.password } : {}), ...(existing.token !== undefined ? { token: existing.token } : {}) };
  const merged: SetupRegistryConfig = {
    ...existingWithoutSecrets,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.url !== undefined ? { url: patch.url } : {}),
    ...(patch.username !== undefined ? { username: patch.username } : {}),
    ...(patch.org !== undefined ? { org: patch.org } : {}),
    ...secretFields,
  };
  const next: SetupConfig = encryptSecrets({
    ...current,
    registries: registries.map((r, i) => (i === index ? merged : r)),
  });
  await writeToDisk(next);
  cache = next;
  return next;
}

/**
 * Supprime le registry à l'index `index` (retour utilisateur du 14/08/2026 : "manque option pour
 * suprimer" — aucune route DELETE n'existait jusqu'ici). `false` si l'index n'existe pas/plus
 * (jamais une exception pour un simple double-clic/une course avec une autre suppression).
 *
 * ATTENTION id INSTABLE après suppression : `reg-<kind>-<index>` (registriesStore.ts) est calculé
 * depuis la position dans le tableau, pas un id stable propre à chaque entrée — supprimer une
 * entrée DÉCALE les index (donc les ids) de toutes les entrées suivantes du même kind. Comportement
 * déjà présent pour update/delete sur ce même schéma d'id (pas une régression introduite ici) ;
 * le frontend doit toujours relire GET /api/registries après une suppression plutôt que de
 * réutiliser un id mémorisé avant coup.
 */
export async function removeRegistryAt(index: number): Promise<boolean> {
  const current = await getCurrent();
  const registries = current.registries ?? [];
  if (!registries[index]) return false;
  // encryptSecrets() ci-dessus est idempotente (encryptSecretIfNeeded) — sans incidence sur les
  // entrées restantes déjà chiffrées, juste une garde de cohérence avec addRegistry/updateRegistryAt.
  const next: SetupConfig = encryptSecrets({
    ...current,
    registries: registries.filter((_, i) => i !== index),
  });
  await writeToDisk(next);
  cache = next;
  return true;
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
/** PUT /api/setup/ldap — corrige la configuration de l'annuaire APRÈS l'assistant, sans toucher au
 * reste (Nutanix, registries, HYCU…). Sans cette route, la seule façon de changer un mapping de
 * rôle était de rejouer tout l'assistant, dont `completeSetup` REMPLACE la configuration entière :
 * un oubli y effaçait les intégrations déjà configurées (cas réel du 24/08/2026). Mot de passe
 * vide = on conserve celui déjà enregistré, comme les autres intégrations. */
export async function setLdapConfig(input: SetupLdapConfig): Promise<SetupConfig> {
  const current = await getCurrent();
  const bindPassword = input.bindPassword?.trim() ? input.bindPassword : (current.ldap?.bindPassword ?? "");
  const next: SetupConfig = encryptSecrets({ ...current, ldap: { ...input, bindPassword } });
  await writeToDisk(next);
  cache = next;
  return next;
}

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

/** Config HYCU effective (mot de passe déchiffré), ou `null` si jamais configurée — même
 * principe que getEffectiveNutanixConfig ci-dessus (aucun bootstrap par variable
 * d'environnement : toujours une URL + des identifiants saisis explicitement). */
export async function getEffectiveHycuConfig(): Promise<SetupHycuConfig | null> {
  const current = await getCurrent();
  if (!current.hycu) return null;
  return { ...current.hycu, password: decryptSecret(current.hycu.password) };
}

/** PUT /api/hycu/config — configure/remplace HYCU (mot de passe chiffré avant écriture),
 * n'affecte aucune autre section — même principe que setNutanixConfig ci-dessus. */
export async function setHycuConfig(input: SetupHycuConfig): Promise<SetupConfig> {
  const current = await getCurrent();
  const next: SetupConfig = encryptSecrets({ ...current, hycu: input });
  await writeToDisk(next);
  cache = next;
  return next;
}

/** DELETE /api/hycu/config — retire la configuration HYCU (retour à "jamais configuré",
 * toutes les routes GET /api/hycu/* redeviennent []/non configuré). */
export async function clearHycuConfig(): Promise<SetupConfig> {
  const current = await getCurrent();
  const { hycu: _removed, ...rest } = current;
  const next: SetupConfig = rest;
  await writeToDisk(next);
  cache = next;
  return next;
}

/** Config GLPI effective (appToken/userToken/password déchiffrés), ou `null` si jamais configurée
 * — même principe que getEffectiveHycuConfig (aucun bootstrap par variable d'environnement). */
export async function getEffectiveGlpiConfig(): Promise<SetupGlpiConfig | null> {
  const current = await getCurrent();
  if (!current.glpi) return null;
  return mapGlpiSecrets(current.glpi, decryptSecret);
}

/** PUT /api/glpi/config — configure/remplace GLPI (secrets chiffrés avant écriture), n'affecte
 * aucune autre section — même principe que setHycuConfig ci-dessus. */
export async function setGlpiConfig(input: SetupGlpiConfig): Promise<SetupConfig> {
  const current = await getCurrent();
  const next: SetupConfig = encryptSecrets({ ...current, glpi: input });
  await writeToDisk(next);
  cache = next;
  return next;
}

/** DELETE /api/glpi/config — retire la configuration GLPI (retour à "jamais configuré", toutes les
 * routes /api/glpi/* redeviennent non configurées). */
export async function clearGlpiConfig(): Promise<SetupConfig> {
  const current = await getCurrent();
  const { glpi: _removed, ...rest } = current;
  const next: SetupConfig = rest;
  await writeToDisk(next);
  cache = next;
  return next;
}

/** Config 3CX effective (clientSecret/password déchiffrés), ou `null` si jamais configurée — même
 * principe que getEffectiveHycuConfig (aucun bootstrap par variable d'environnement : l'URL du PBX
 * et les identifiants sont toujours saisis explicitement). */
export async function getEffectiveThreecxConfig(): Promise<SetupThreecxConfig | null> {
  const current = await getCurrent();
  if (!current.threecx) return null;
  // Migration à la lecture : une config enregistrée avant l'ajout du mode reste en client credentials.
  return { ...mapThreecxSecrets(current.threecx, decryptSecret), authMode: current.threecx.authMode ?? "client-credentials" };
}

/** PUT /api/3cx/config — configure/remplace le PBX 3CX (clientSecret/password chiffrés avant
 * écriture), n'affecte aucune autre section — même principe que setHycuConfig ci-dessus. */
export async function setThreecxConfig(input: SetupThreecxConfig): Promise<SetupConfig> {
  const current = await getCurrent();
  const next: SetupConfig = encryptSecrets({ ...current, threecx: input });
  await writeToDisk(next);
  cache = next;
  return next;
}

/** DELETE /api/3cx/config — retire la configuration 3CX (retour à "jamais configuré", toutes les
 * routes GET /api/3cx/* redeviennent non configurées). */
export async function clearThreecxConfig(): Promise<SetupConfig> {
  const current = await getCurrent();
  const { threecx: _removed, ...rest } = current;
  const next: SetupConfig = rest;
  await writeToDisk(next);
  cache = next;
  return next;
}

/** Config ExaGrid effective (community/authKey/privKey déchiffrés), ou `null` si jamais
 * configurée — même principe que getEffectiveHycuConfig (aucun bootstrap par variable
 * d'environnement : hôte et identifiants SNMP sont toujours saisis explicitement). */
export async function getEffectiveExagridConfig(): Promise<SetupExagridConfig | null> {
  const current = await getCurrent();
  if (!current.exagrid) return null;
  return mapExagridSecrets(current.exagrid, decryptSecret);
}

/** PUT /api/exagrid/config — configure/remplace ExaGrid (secrets chiffrés avant écriture),
 * n'affecte aucune autre section — même principe que setHycuConfig ci-dessus. */
export async function setExagridConfig(input: SetupExagridConfig): Promise<SetupConfig> {
  const current = await getCurrent();
  const next: SetupConfig = encryptSecrets({ ...current, exagrid: input });
  await writeToDisk(next);
  cache = next;
  return next;
}

/** DELETE /api/exagrid/config — retire la configuration ExaGrid (retour à "jamais configuré",
 * GET /api/exagrid/status redevient { configured: false }). */
export async function clearExagridConfig(): Promise<SetupConfig> {
  const current = await getCurrent();
  const { exagrid: _removed, ...rest } = current;
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

/** Config AD CS effective (mot de passe déchiffré), ou `null` si jamais configurée — même
 * principe que getEffectiveHycuConfig (aucun bootstrap par variable d'environnement : l'URL de
 * l'autorité et le compte de service sont toujours saisis explicitement). */
export async function getEffectiveCertificatesConfig(): Promise<SetupCertificatesConfig | null> {
  const current = await getCurrent();
  if (!current.certificates) return null;
  // Migration à la lecture : une config écrite avant l'ajout du champ reste en "certsrv".
  return {
    ...current.certificates,
    password: decryptSecret(current.certificates.password),
    method: current.certificates.method ?? "certsrv",
  };
}

/** PUT /api/certificates/config — configure/remplace l'autorité AD CS (mot de passe chiffré avant
 * écriture), n'affecte aucune autre section — même principe que setHycuConfig ci-dessus. */
export async function setCertificatesConfig(input: SetupCertificatesConfig): Promise<SetupConfig> {
  const current = await getCurrent();
  const next: SetupConfig = encryptSecrets({ ...current, certificates: input });
  await writeToDisk(next);
  cache = next;
  return next;
}

/** DELETE /api/certificates/config — retire la configuration AD CS. Les certificats DÉJÀ émis
 * restent stockés et continuent d'être servis par Caddy jusqu'à leur expiration (on ne casse
 * jamais TLS en retirant une config) ; seuls l'émission et le renouvellement s'arrêtent. */
export async function clearCertificatesConfig(): Promise<SetupConfig> {
  const current = await getCurrent();
  const { certificates: _removed, ...rest } = current;
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

/** Déchiffre les identifiants d'UNE entrée de registry précise déjà en main (pas de recherche
 * par kind) — pour un appelant qui possède déjà l'entrée exacte à utiliser (ex: watchdog.ts qui
 * itère `setup.registries` par index, registriesStore.ts#buildRegistryView qui construit la vue
 * d'une entrée précise) : aucune ambiguïté possible puisqu'il n'y a pas de sélection à faire. */
export function decryptRegistryCredentials(entry: SetupRegistryConfig): EffectiveRegistryCredentials {
  return {
    ...(entry.username !== undefined ? { username: entry.username } : {}),
    ...(entry.password !== undefined ? { password: decryptSecret(entry.password) } : {}),
    ...(entry.token !== undefined ? { token: decryptSecret(entry.token) } : {}),
  };
}

/**
 * Identifiants effectifs (déchiffrés) du premier registry persisté correspondant à `kind`,
 * ou `null` si aucun n'est configuré via l'assistant — dans ce cas les clients registries
 * (src/services/registries/*) retombent sur les variables d'environnement globales
 * (DOCKERHUB_TOKEN, GHCR_TOKEN, GITLAB_TOKEN).
 *
 * Réservée aux appelants qui n'ont réellement QUE le `kind`, sans image/organisation/hôte
 * précis à désambiguïser (ex: githubStore.ts#ghcrFallbackToken, un simple jeton GitHub PAT en
 * repli générique). Dès qu'un nom d'image (ou une organisation/un namespace) est disponible,
 * utiliser getEffectiveRegistryCredentialsForImage ci-dessous à la place : avec DEUX registries
 * du même kind (ex: un compte GHCR pro et un perso), cette fonction-ci retombe toujours sur le
 * PREMIER des deux, quelle que soit l'image réellement concernée.
 */
export async function getEffectiveRegistryCredentials(kind: RegistryKind): Promise<EffectiveRegistryCredentials | null> {
  const current = await getCurrent();
  const match = current.registries?.find((r) => r.kind === kind);
  if (!match) return null;
  return decryptRegistryCredentials(match);
}

/** "ghcr.io/mairie/foo" ou "mairie/foo" ou "mairie" -> "mairie" (dépouille un préfixe d'hôte
 * optionnel puis prend le premier segment de chemin). Sert à la fois pour GHCR (org GitHub) et
 * Docker Hub (namespace), les deux formes d'entrée possibles (nom d'image complet ou simple
 * org/namespace déjà isolé, ex: transmis par routes/registries.ts#GET .../repositories). */
function firstPathSegment(value: string, hostPrefix?: string): string {
  const stripped = hostPrefix && value.startsWith(hostPrefix) ? value.slice(hostPrefix.length) : value;
  return stripped.split("/")[0] ?? "";
}

/** "https://gitlab.mairie.fr/" ou "gitlab.mairie.fr" -> "gitlab.mairie.fr" (hôte seul, en
 * minuscules) — pour comparer l'hôte d'une image gitlab/harbor à l'URL d'un registry persisté. */
function registryUrlHost(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).host.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Choisit, parmi PLUSIEURS entrées du même `kind`, celle qui correspond le mieux à `target`
 * (nom d'image complet, ou organisation/namespace déjà isolé) — `undefined` si aucune
 * correspondance fiable n'est possible (l'appelant retombe alors sur la première entrée du
 * kind, comportement historique, sans régression pour un déploiement à une seule entrée).
 *
 * - ghcr : rapproche par organisation/utilisateur GitHub (`username` persisté, jamais un
 *   e-mail — voir registriesStore.ts#buildRegistryView pour la même convention) contre le
 *   premier segment de `target` (après un éventuel préfixe "ghcr.io/").
 * - dockerhub : rapproche par namespace contre le premier segment de `target`. Une image
 *   OFFICIELLE (un seul segment, ex: "nginx") n'appartient à aucun compte précis — aucune
 *   correspondance possible, ce qui est correct : n'importe quelle entrée dockerhub peut la
 *   lire, aucune authentification n'étant de toute façon nécessaire pour un dépôt public.
 * - gitlab/harbor : auto-hébergés, donc désambiguïsés par HÔTE (le nom de l'image commence
 *   toujours par l'hôte du registry, ex: "gitlab.mairie.fr/groupe/projet") plutôt que par
 *   namespace — aucune ambiguïté réelle entre deux entrées de ce type puisque chacune a
 *   nécessairement un hôte distinct.
 */
function findBestRegistryMatch(
  kind: RegistryKind,
  target: string,
  candidates: SetupRegistryConfig[],
): SetupRegistryConfig | undefined {
  if (!target) return undefined;
  switch (kind) {
    case "ghcr": {
      const org = firstPathSegment(target, "ghcr.io/");
      if (!org) return undefined;
      return candidates.find(
        (r) => r.username !== undefined && !r.username.includes("@") && r.username.toLowerCase() === org.toLowerCase(),
      );
    }
    case "dockerhub": {
      const withoutHost = target.startsWith("docker.io/") ? target.slice("docker.io/".length) : target;
      const segments = withoutHost.split("/");
      if (segments.length < 2) return undefined; // image officielle sans namespace : aucune entrée précise
      const namespace = segments[0]!;
      return candidates.find((r) => r.username !== undefined && r.username.toLowerCase() === namespace.toLowerCase());
    }
    case "gitlab":
    case "harbor": {
      const host = firstPathSegment(target);
      if (!host) return undefined;
      return candidates.find((r) => registryUrlHost(r.url) === host.toLowerCase());
    }
    default: {
      const exhaustiveCheck: never = kind;
      throw new Error(`Unsupported registry kind: ${String(exhaustiveCheck)}`);
    }
  }
}

/**
 * Identifiants effectifs (déchiffrés) de la MEILLEURE entrée de registry pour `target` (nom
 * d'image complet, ex: "ghcr.io/mairie-perso/site" — ou une organisation/un namespace déjà
 * isolé, ex: transmis par routes/registries.ts). Remplace getEffectiveRegistryCredentials(kind)
 * pour tout appelant qui connaît l'image (ou l'org/le namespace) concernée : c'est ce qui
 * permet à PLUSIEURS registries du même kind de fonctionner chacun indépendamment (ex: un
 * compte GHCR professionnel et un compte GHCR personnel) au lieu que le second retombe
 * silencieusement sur les identifiants du premier.
 *
 * - Zéro entrée du kind : `null` (comportement identique à getEffectiveRegistryCredentials).
 * - Une seule entrée du kind : celle-ci, sans même regarder `target` — comportement strictement
 *   identique à getEffectiveRegistryCredentials(kind), aucune régression pour un déploiement à
 *   une seule entrée par kind (cas de tous les déploiements existants).
 * - Plusieurs entrées : la meilleure correspondance (voir findBestRegistryMatch), avec repli sur
 *   la PREMIÈRE entrée du kind si `target` ne permet aucune désambiguïsation fiable.
 */
export async function getEffectiveRegistryCredentialsForImage(
  kind: RegistryKind,
  target: string,
): Promise<EffectiveRegistryCredentials | null> {
  const current = await getCurrent();
  const candidates = (current.registries ?? []).filter((r) => r.kind === kind);
  const first = candidates[0];
  if (!first) return null;
  if (candidates.length === 1) return decryptRegistryCredentials(first);
  const match = findBestRegistryMatch(kind, target, candidates);
  return decryptRegistryCredentials(match ?? first);
}
