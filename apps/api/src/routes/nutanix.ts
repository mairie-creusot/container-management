/**
 * GET    /api/nutanix/vms    — détail des VMs du cluster Nutanix piloté (nom, état
 *                               d'alimentation, vCPUs, mémoire, cluster physique). Renvoie []
 *                               si Nutanix n'a jamais été configuré, ou si configuré mais
 *                               injoignable — voir services/nutanix.ts#getNutanixVms (aucune
 *                               transformation supplémentaire nécessaire ici, la forme est déjà
 *                               NutanixVm[]).
 * GET    /api/nutanix/config — config Nutanix courante, REDACTÉE (jamais le mot de passe).
 * PUT    /api/nutanix/config — configure/remplace Nutanix EN DEHORS de l'assistant de premier
 *                               lancement (admin uniquement, mêmes identifiants de sensibilité
 *                               comparable à /api/ad-dns/config) — teste réellement la
 *                               connexion à Prism Central avant d'enregistrer, jamais persisté
 *                               à l'aveugle. Répond au trou constaté : avant cette route, la
 *                               SEULE façon d'ajouter Nutanix était l'assistant de premier
 *                               lancement, invisible/inaccessible une fois celui-ci terminé sans
 *                               tout rouvrir (POST /api/setup/reset, LDAP compris).
 * DELETE /api/nutanix/config — retire la configuration (admin uniquement).
 *
 * POST   /api/nutanix/vms/:uuid/start   — démarre une VM éteinte (services/nutanix.ts#startNutanixVm).
 * POST   /api/nutanix/vms/:uuid/stop    — arrête GRACIEUSEMENT une VM allumée (ACPI, pas un
 *                                          power-off brutal — services/nutanix.ts#stopNutanixVm).
 * POST   /api/nutanix/vms/:uuid/restart — redémarre GRACIEUSEMENT une VM allumée (extinction ACPI,
 *                                          attente de convergence réelle, rallumage — voir
 *                                          services/nutanix.ts#restartNutanixVm pour le détail du
 *                                          mécanisme, l'API v3 n'a pas d'action "reboot" dédiée).
 * POST   /api/nutanix/vms/:uuid/migrate — migre une VM ALLUMÉE vers un autre hôte physique du
 *                                          MÊME cluster (live migration AHV réelle, voir
 *                                          services/nutanix.ts#migrateNutanixVm) — `{ targetHostUuid }`.
 *                                          Refuse explicitement un hôte cible = hôte actuel ou
 *                                          appartenant à un autre cluster (409 dans les deux cas).
 * DELETE /api/nutanix/vms/:uuid         — supprime définitivement une VM (services/nutanix.ts#
 *                                          deleteNutanixVm) — refuse (409) si la VM est allumée,
 *                                          garde-fou QUAI délibéré vu la sensibilité de l'action
 *                                          (voir JSDoc de la fonction). La confirmation "taper le
 *                                          nom de la VM" est portée par le frontend.
 * GET    /api/nutanix/subnets            — subnets réels (uuid/nom/VLAN) pour le sélecteur
 *                                          "Ajouter une carte réseau" du frontend — même source
 *                                          (/subnets/list) que la résolution VLAN du poll, []
 *                                          si non configuré/injoignable (services/nutanix.ts#
 *                                          getNutanixSubnets).
 * POST   /api/nutanix/vms/:uuid/disks    — ajoute un disque SCSI ({ sizeMib }) via le mécanisme
 *                                          PUT spec (services/nutanix.ts#addNutanixVmDisk —
 *                                          forme d'entrée reproduite d'un disque réel, storage
 *                                          container recopié d'un disque existant de la VM).
 * POST   /api/nutanix/vms/:uuid/nics     — ajoute une carte réseau ({ subnetUuid }) — subnet
 *                                          vérifié contre /subnets/list (404 sinon), voir
 *                                          services/nutanix.ts#addNutanixVmNic.
 * PATCH  /api/nutanix/vms/:uuid/compute  — met à jour vCPU/cœurs par vCPU/mémoire ({ numVcpus?,
 *                                          numCoresPerVcpu?, memoryMib? }) — un refus à-chaud de
 *                                          Prism Central remonte TEL QUEL (502 + message réel),
 *                                          jamais masqué (services/nutanix.ts#
 *                                          updateNutanixVmCompute).
 * GET    /api/nutanix/images             — images du catalogue (uuid/nom/taille/type), tout rôle authentifié.
 * POST   /api/nutanix/images             — crée une image DISK_IMAGE depuis une URL ({ name, sourceUri }).
 * POST   /api/nutanix/images/upload      — multipart (name + file) : upload direct d'un .iso/.qcow2/.img
 *                                          vers le catalogue, streamé (jamais en mémoire) → { ok, name, uuid }.
 * POST   /api/nutanix/vms                — crée une VM depuis une image ({ imageUuid }, + cloud-init optionnel)
 *                                          OU depuis un ISO ({ isoImageUuid, diskSizeMib } : disque vide + CDROM,
 *                                          boot CDROM puis DISK — installation via la console VNC) et la démarre
 *                                          (services/nutanix.ts#createNutanixVm — le body contient un SECRET,
 *                                          jamais loggé/échoïsé).
 * GET    /api/nutanix/tasks/:uuid        — suivi d'une tâche asynchrone ({ uuid, status, percentageComplete? }).
 * GET    /api/nutanix/vms/:uuid/console (WebSocket) — console VNC RÉELLE de la VM (clavier/souris,
 *                                          voir services/nutanix.ts#getNutanixVmConsoleTarget pour
 *                                          le mécanisme exact vérifié en conditions réelles) —
 *                                          QUAI proxifie bidirectionnellement le WebSocket vers
 *                                          Prism Central, le navigateur ne parle JAMAIS directement
 *                                          à l'infra Nutanix. ADMIN UNIQUEMENT (pas operator/admin
 *                                          comme les 5 actions ci-dessus) — voir rejectIfNotAdmin
 *                                          plus bas pour la justification de cette restriction
 *                                          supplémentaire. Refuse (code WS 4409) une VM éteinte —
 *                                          rien à afficher. Chaque ouverture est explicitement
 *                                          journalisée dans le registre d'audit (services/
 *                                          auditLog.ts) : ce n'est PAS une méthode mutante
 *                                          (POST/PUT/PATCH/DELETE), donc le hook générique
 *                                          plugins/audit.ts (limité à ces 4 méthodes) ne la capture
 *                                          jamais automatiquement.
 *
 * Ces 5 routes d'action mutent une VRAIE VM de production Nutanix — operator/admin requis (garde
 * globale plugins/auth.ts sur toute méthode mutante, même pattern que /api/containers/:id/{start,
 * stop,restart} et DELETE /api/containers/:id, voir routes/containers.ts) et auditées
 * automatiquement (plugins/audit.ts, même mécanisme générique que toute route mutante authentifiée
 * — rien à câbler ici). Toutes traduisent NutanixActionError (services/nutanix.ts) via son
 * `httpStatus` porté explicitement par l'erreur (voir sendNutanixActionError ci-dessous) plutôt
 * qu'un 502 générique fourre-tout : contrairement aux GET de listing ci-dessus (qui retombent
 * honnêtement sur []/injoignable sans distinction fine), une action doit échouer avec un
 * diagnostic exploitable par l'opérateur (VM déjà dans l'état demandé, hôte cible invalide, VM
 * introuvable...).
 *
 * Fichier dédié plutôt qu'ajouté à routes/environments.ts : GET /api/environments n'expose
 * qu'un nœud PAR CLUSTER PHYSIQUE (compteur de VMs agrégé, cf. nutanix.ts#getNutanixEnvironment),
 * jamais le détail par VM — c'est une ressource distincte (liste de VMs, pas de nœuds de cluster),
 * qui mérite son propre chemin `/api/nutanix/*` plutôt que de surcharger la route environnements.
 */

import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import WebSocket from "ws";
import { config } from "../config.js";
import { recordAuditEvent } from "../services/auditLog.js";
import {
  addNutanixVmDisk,
  addNutanixVmNic,
  createNutanixImage,
  createNutanixVm,
  deleteNutanixImageBestEffort,
  deleteNutanixVm,
  getNutanixImages,
  getNutanixSubnets,
  getNutanixTask,
  getNutanixVmConsoleTarget,
  getNutanixVms,
  migrateNutanixVm,
  NutanixActionError,
  restartNutanixVm,
  startNutanixVm,
  stopNutanixVm,
  testNutanixConnection,
  updateNutanixVmCompute,
  uploadNutanixImage,
} from "../services/nutanix.js";
import type { NutanixGuestCustomizationInput, NutanixUploadImageType } from "../services/nutanix.js";
import { clearNutanixConfig, getEffectiveNutanixConfig, setNutanixConfig } from "../services/setupStore.js";
import type { SetupNutanixConfig } from "../services/setupStore.js";
import type { NutanixConfig, NutanixStatus } from "../types.js";

/** Traduit une erreur d'action VM (services/nutanix.ts#{start,stop,restart,delete,migrate}NutanixVm)
 * en réponse HTTP — utilise `httpStatus` porté par NutanixActionError quand présent (diagnostic
 * précis : 400 non configuré, 404 VM/hôte introuvable, 409 garde-fou métier, 502 erreur Prism
 * Central, 504 timeout de convergence), 502 générique sinon (erreur inattendue non prévue par le
 * service, ex: panne réseau brute) — jamais un succès silencieux sur une action mutante. */
function sendNutanixActionError(reply: FastifyReply, err: unknown): void {
  if (err instanceof NutanixActionError) {
    reply.code(err.httpStatus).send({ error: err.message });
    return;
  }
  reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
}

/** true (et réponse 403 déjà envoyée) si la session n'a pas le rôle admin — même garde que
 * routes/adDns.ts/secrets.ts pour une intégration de sensibilité comparable (identifiants
 * Prism Central donnant un accès large à l'infra virtualisée). */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

/** Reconstruit l'URL WebSocket amont RÉELLE (`wss://<host Prism Central>/vnc/vm/{uuid}/proxy`)
 * depuis `prismCentralUrl` (base HTTPS déjà utilisée pour les appels REST, voir services/
 * nutanix.ts) et `wsPath` (voir getNutanixVmConsoleTarget) — même hôte/port que le reste de
 * l'intégration, seul le schéma change (wss:// au lieu de https://, cohérent avec le mécanisme
 * WebSocket confirmé en conditions réelles, voir JSDoc de getNutanixVmConsoleTarget). */
function buildNutanixConsoleWsUrl(prismCentralUrl: string, wsPath: string): string {
  const base = prismCentralUrl.endsWith("/") ? prismCentralUrl : `${prismCentralUrl}/`;
  const httpTarget = new URL(wsPath.replace(/^\//, ""), base);
  return `wss://${httpTarget.host}${httpTarget.pathname}`;
}

interface NutanixConfigBody {
  prismCentralUrl?: string;
  username?: string;
  password?: string;
}

function toPublicConfig(cfg: SetupNutanixConfig): NutanixConfig {
  return { prismCentralUrl: cfg.prismCentralUrl, username: cfg.username };
}

// Limite d'upload d'image : généreuse (ISO d'installation Windows/Linux) mais bornée — le fichier
// est STREAMÉ vers Prism (pipe), jamais chargé en mémoire (voir uploadNutanixImage).
const IMAGE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024 * 1024;

/** ISO_IMAGE/DISK_IMAGE selon l'extension du nom de fichier — undefined si inconnue (400 honnête,
 * jamais un type deviné). */
function imageTypeForFilename(filename: string): NutanixUploadImageType | undefined {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".iso")) return "ISO_IMAGE";
  if (lower.endsWith(".qcow2") || lower.endsWith(".img")) return "DISK_IMAGE";
  return undefined;
}

export default async function nutanixRoutes(fastify: FastifyInstance): Promise<void> {
  // Multipart scopé à ce plugin (seule la route /images/upload le consomme).
  await fastify.register(multipart, { limits: { fileSize: IMAGE_UPLOAD_MAX_BYTES, files: 1 } });

  fastify.get("/api/nutanix/vms", async (_request, reply) => {
    return reply.send(await getNutanixVms());
  });

  fastify.get("/api/nutanix/config", async (_request, reply) => {
    const current = await getEffectiveNutanixConfig();
    const status: NutanixStatus = current ? { configured: true, config: toPublicConfig(current) } : { configured: false };
    return reply.send(status);
  });

  fastify.put<{ Body: NutanixConfigBody }>("/api/nutanix/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const body = request.body ?? {};
    const existing = await getEffectiveNutanixConfig();
    const prismCentralUrl = body.prismCentralUrl?.trim();
    const username = body.username?.trim();
    // password vide/absent = conserver l'existant (même convention que PATCH /api/registries/:id
    // et PUT /api/ad-dns/config) — permet de changer l'URL/l'utilisateur sans ressaisir le mot de
    // passe à chaque fois.
    const password = body.password?.trim() || existing?.password || "";

    if (!prismCentralUrl || !username || !password) {
      return reply.code(400).send({ error: "prismCentralUrl, username and password are required" });
    }

    // Teste réellement la connexion avant d'enregistrer — jamais une config persistée à l'aveugle
    // (même discipline que l'assistant de premier lancement, POST /api/setup/test/nutanix).
    const test = await testNutanixConnection(prismCentralUrl, username, password);
    if (!test.ok) {
      return reply.code(400).send({ error: test.message });
    }

    const saved = await setNutanixConfig({ prismCentralUrl, username, password });
    return reply.send({ configured: true, config: toPublicConfig(saved.nutanix!) } satisfies NutanixStatus);
  });

  fastify.delete("/api/nutanix/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    await clearNutanixConfig();
    return reply.send({ ok: true });
  });

  // --- Cycle de vie + migration d'une VM (voir en-tête de fichier) — operator/admin (garde
  // globale plugins/auth.ts), audit automatique (plugins/audit.ts), aucun garde local
  // supplémentaire nécessaire (même niveau de sensibilité que /api/containers/:id/{start,stop,
  // restart}, PAS le niveau admin-only de GET .../files/hexdump). -----------------------------

  fastify.post<{ Params: { uuid: string } }>("/api/nutanix/vms/:uuid/start", async (request, reply) => {
    try {
      const result = await startNutanixVm(request.params.uuid);
      return reply.send(result);
    } catch (err) {
      sendNutanixActionError(reply, err);
    }
  });

  fastify.post<{ Params: { uuid: string } }>("/api/nutanix/vms/:uuid/stop", async (request, reply) => {
    try {
      const result = await stopNutanixVm(request.params.uuid);
      return reply.send(result);
    } catch (err) {
      sendNutanixActionError(reply, err);
    }
  });

  fastify.post<{ Params: { uuid: string } }>("/api/nutanix/vms/:uuid/restart", async (request, reply) => {
    try {
      const result = await restartNutanixVm(request.params.uuid);
      return reply.send(result);
    } catch (err) {
      sendNutanixActionError(reply, err);
    }
  });

  fastify.post<{ Params: { uuid: string }; Body: { targetHostUuid?: string } }>(
    "/api/nutanix/vms/:uuid/migrate",
    async (request, reply) => {
      const targetHostUuid = request.body?.targetHostUuid?.trim();
      if (!targetHostUuid) {
        return reply.code(400).send({ error: "targetHostUuid is required" });
      }
      try {
        const result = await migrateNutanixVm(request.params.uuid, targetHostUuid);
        return reply.send(result);
      } catch (err) {
        sendNutanixActionError(reply, err);
      }
    },
  );

  fastify.delete<{ Params: { uuid: string } }>("/api/nutanix/vms/:uuid", async (request, reply) => {
    try {
      const result = await deleteNutanixVm(request.params.uuid);
      return reply.send(result);
    } catch (err) {
      sendNutanixActionError(reply, err);
    }
  });

  // --- Configuration matérielle (disque/NIC/compute — voir en-tête de fichier) : mêmes gardes
  // (operator/admin via plugins/auth.ts, audit automatique plugins/audit.ts) que les actions de
  // cycle de vie ci-dessus, mêmes traductions d'erreur (sendNutanixActionError). -----------------

  fastify.get("/api/nutanix/subnets", async (_request, reply) => {
    return reply.send(await getNutanixSubnets());
  });

  fastify.post<{ Params: { uuid: string }; Body: { sizeMib?: number } }>("/api/nutanix/vms/:uuid/disks", async (request, reply) => {
    const sizeMib = request.body?.sizeMib;
    if (typeof sizeMib !== "number" || !Number.isFinite(sizeMib)) {
      return reply.code(400).send({ error: "sizeMib (number, MiB) is required" });
    }
    try {
      const result = await addNutanixVmDisk(request.params.uuid, { sizeMib });
      return reply.send(result);
    } catch (err) {
      sendNutanixActionError(reply, err);
    }
  });

  fastify.post<{ Params: { uuid: string }; Body: { subnetUuid?: string } }>("/api/nutanix/vms/:uuid/nics", async (request, reply) => {
    const subnetUuid = request.body?.subnetUuid?.trim();
    if (!subnetUuid) {
      return reply.code(400).send({ error: "subnetUuid is required" });
    }
    try {
      const result = await addNutanixVmNic(request.params.uuid, { subnetUuid });
      return reply.send(result);
    } catch (err) {
      sendNutanixActionError(reply, err);
    }
  });

  fastify.patch<{ Params: { uuid: string }; Body: { numVcpus?: number; numCoresPerVcpu?: number; memoryMib?: number } }>(
    "/api/nutanix/vms/:uuid/compute",
    async (request, reply) => {
      const body = request.body ?? {};
      for (const [key, value] of Object.entries({ numVcpus: body.numVcpus, numCoresPerVcpu: body.numCoresPerVcpu, memoryMib: body.memoryMib })) {
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
          return reply.code(400).send({ error: `${key} must be a number` });
        }
      }
      try {
        const result = await updateNutanixVmCompute(request.params.uuid, {
          ...(body.numVcpus !== undefined ? { numVcpus: body.numVcpus } : {}),
          ...(body.numCoresPerVcpu !== undefined ? { numCoresPerVcpu: body.numCoresPerVcpu } : {}),
          ...(body.memoryMib !== undefined ? { memoryMib: body.memoryMib } : {}),
        });
        return reply.send(result);
      } catch (err) {
        sendNutanixActionError(reply, err);
      }
    },
  );

  // --- Étage "déploiement" (images + création de VM cloud-init + suivi de tâche — voir
  // services/nutanix.ts, section du 18/08/2026) : GET ouverts à tout rôle authentifié (garde
  // globale plugins/auth.ts), mutations operator/admin + audit automatique. Le body de POST /vms
  // contient un SECRET (guestCustomization.password/clé) : jamais loggé/audité (l'audit ne
  // journalise que méthode+chemin, voir plugins/audit.ts), jamais échoïsé dans une erreur. -------

  fastify.get("/api/nutanix/images", async (_request, reply) => {
    return reply.send(await getNutanixImages());
  });

  fastify.post<{ Body: { name?: string; sourceUri?: string } }>("/api/nutanix/images", async (request, reply) => {
    const name = request.body?.name?.trim();
    const sourceUri = request.body?.sourceUri?.trim();
    if (!name || !sourceUri) {
      return reply.code(400).send({ error: "name and sourceUri are required" });
    }
    let parsed: URL;
    try {
      parsed = new URL(sourceUri);
    } catch {
      return reply.code(400).send({ error: "sourceUri must be a valid URL" });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return reply.code(400).send({ error: "sourceUri must be an http(s) URL" });
    }
    try {
      return reply.send(await createNutanixImage({ name, sourceUri }));
    } catch (err) {
      sendNutanixActionError(reply, err);
    }
  });

  // Upload direct d'un fichier image : multipart champ `name` (AVANT le champ `file` dans le corps)
  // + champ `file` streamé tel quel vers Prism — voir services/nutanix.ts#uploadNutanixImage.
  fastify.post("/api/nutanix/images/upload", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "multipart/form-data expected (fields: name, file)" });
    }
    const part = await request.file().catch(() => undefined);
    if (!part) {
      return reply.code(400).send({ error: "file field is required" });
    }
    const nameField = part.fields["name"];
    const rawName = !Array.isArray(nameField) && nameField?.type === "field" ? nameField.value : undefined;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name) {
      part.file.resume();
      return reply.code(400).send({ error: "name field is required (must appear before the file field in the multipart body)" });
    }
    const imageType = imageTypeForFilename(name) ?? imageTypeForFilename(part.filename ?? "");
    if (!imageType) {
      part.file.resume();
      return reply.code(400).send({ error: "unsupported file extension — expected .iso (ISO_IMAGE) or .qcow2/.img (DISK_IMAGE)" });
    }
    try {
      const result = await uploadNutanixImage({ name, imageType, stream: part.file });
      if (part.file.truncated) {
        // Fichier coupé par la limite : l'image partielle est retirée, jamais laissée comme valide.
        await deleteNutanixImageBestEffort(result.uuid);
        return reply.code(413).send({ error: `file exceeds the ${IMAGE_UPLOAD_MAX_BYTES} bytes upload limit — partial image removed` });
      }
      return reply.send({ ok: true, name: result.name, uuid: result.uuid });
    } catch (err) {
      // Draine le flux si le service a échoué avant de le consommer (no-op s'il l'a déjà lu).
      part.file.resume();
      sendNutanixActionError(reply, err);
    }
  });

  fastify.post<{
    Body: {
      name?: string;
      imageUuid?: string;
      isoImageUuid?: string;
      subnetUuid?: string;
      numVcpus?: number;
      numCoresPerVcpu?: number;
      memoryMib?: number;
      diskSizeMib?: number;
      guestCustomization?: { hostname?: string; username?: string; password?: string; sshAuthorizedKey?: string };
    };
  }>("/api/nutanix/vms", async (request, reply) => {
    const body = request.body ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const imageUuid = typeof body.imageUuid === "string" ? body.imageUuid.trim() : "";
    const isoImageUuid = typeof body.isoImageUuid === "string" ? body.isoImageUuid.trim() : "";
    const subnetUuid = typeof body.subnetUuid === "string" ? body.subnetUuid.trim() : "";
    if (!name || !subnetUuid) {
      return reply.code(400).send({ error: "name and subnetUuid are required" });
    }
    // Exclusivité imageUuid/isoImageUuid revalidée par le service — garde précoce pour un 400 clair.
    if ((imageUuid === "") === (isoImageUuid === "")) {
      return reply.code(400).send({ error: "exactly one of imageUuid or isoImageUuid is required" });
    }
    if (isoImageUuid && body.diskSizeMib === undefined) {
      return reply.code(400).send({ error: "diskSizeMib is required with isoImageUuid (size of the empty disk)" });
    }
    for (const [key, value] of Object.entries({
      numVcpus: body.numVcpus,
      numCoresPerVcpu: body.numCoresPerVcpu,
      memoryMib: body.memoryMib,
      diskSizeMib: body.diskSizeMib,
    })) {
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
        return reply.code(400).send({ error: `${key} must be a number` });
      }
    }
    if (body.numVcpus === undefined || body.memoryMib === undefined) {
      return reply.code(400).send({ error: "numVcpus and memoryMib are required" });
    }
    let guestCustomization: NutanixGuestCustomizationInput | undefined;
    if (body.guestCustomization !== undefined) {
      const gc = body.guestCustomization;
      if (typeof gc !== "object" || gc === null || typeof gc.username !== "string" || !gc.username) {
        return reply.code(400).send({ error: "guestCustomization.username is required when guestCustomization is provided" });
      }
      for (const [key, value] of Object.entries({ hostname: gc.hostname, password: gc.password, sshAuthorizedKey: gc.sshAuthorizedKey })) {
        if (value !== undefined && typeof value !== "string") {
          return reply.code(400).send({ error: `guestCustomization.${key} must be a string` });
        }
      }
      guestCustomization = {
        username: gc.username,
        ...(gc.hostname !== undefined ? { hostname: gc.hostname } : {}),
        ...(gc.password !== undefined ? { password: gc.password } : {}),
        ...(gc.sshAuthorizedKey !== undefined ? { sshAuthorizedKey: gc.sshAuthorizedKey } : {}),
      };
    }
    try {
      return reply.send(
        await createNutanixVm({
          name,
          ...(imageUuid ? { imageUuid } : {}),
          ...(isoImageUuid ? { isoImageUuid } : {}),
          subnetUuid,
          numVcpus: body.numVcpus,
          memoryMib: body.memoryMib,
          ...(body.numCoresPerVcpu !== undefined ? { numCoresPerVcpu: body.numCoresPerVcpu } : {}),
          ...(body.diskSizeMib !== undefined ? { diskSizeMib: body.diskSizeMib } : {}),
          ...(guestCustomization !== undefined ? { guestCustomization } : {}),
        }),
      );
    } catch (err) {
      sendNutanixActionError(reply, err);
    }
  });

  fastify.get<{ Params: { uuid: string } }>("/api/nutanix/tasks/:uuid", async (request, reply) => {
    try {
      return reply.send(await getNutanixTask(request.params.uuid));
    } catch (err) {
      sendNutanixActionError(reply, err);
    }
  });

  // --- Console VNC réelle d'une VM (voir en-tête de fichier + services/nutanix.ts#
  // getNutanixVmConsoleTarget pour le mécanisme). ADMIN UNIQUEMENT — restriction délibérément PLUS
  // STRICTE que les 5 actions ci-dessus (operator/admin) : un accès console donne un contrôle
  // clavier/souris CONTINU et INTERACTIF, quasi-physique, sur une VRAIE VM de production de la
  // mairie (voir garde-fou de prudence absolue de cette mission) — un risque qualitativement
  // différent d'une action bornée et auditée en un seul appel (démarrer/arrêter/migrer...). Même
  // niveau de sensibilité que PUT/DELETE /api/nutanix/config ci-dessus (identifiants Prism Central
  // donnant un accès large à l'infra virtualisée) : cohérent de restreindre l'accès CONSOLE au
  // même cercle que celui qui peut déjà reconfigurer entièrement l'intégration. -----------------
  fastify.addHook("preHandler", async (request, reply) => {
    // Le hook global (plugins/auth.ts) n'exige le rôle operator/admin QUE pour les méthodes
    // mutantes (POST/PUT/PATCH/DELETE) — cette requête d'upgrade WebSocket est un GET, donc le
    // hook global ne suffit pas ici (il a déjà, lui, garanti une session valide + peuplé
    // `request.authSession`, sinon 401 avant d'atteindre ce hook local). Un 403 classique à ce
    // stade empêche l'upgrade WebSocket lui-même — même mécanisme que routes/console.ts pour le
    // rôle operator/admin, ici restreint à admin seul (voir JSDoc de la route ci-dessus).
    if (!request.url.startsWith("/api/nutanix/vms/") || !request.url.endsWith("/console")) return;
    if (rejectIfNotAdmin(request, reply)) return reply;
  });

  fastify.get<{ Params: { uuid: string } }>(
    "/api/nutanix/vms/:uuid/console",
    { websocket: true },
    async (socket: WebSocket, request) => {
      const { uuid } = request.params;

      let target: Awaited<ReturnType<typeof getNutanixVmConsoleTarget>>;
      try {
        target = await getNutanixVmConsoleTarget(uuid);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const httpStatus = err instanceof NutanixActionError ? err.httpStatus : 502;
        request.log.warn({ err, uuid }, "nutanix console: failed to resolve console target");
        // Jamais de socket.send() ici : contrairement au terminal texte de routes/console.ts, ce
        // flux est un protocole BINAIRE (RFB/VNC) côté client noVNC — y injecter un message texte
        // avant la moindre trame RFB corromprait le parsing. Le code/la raison de fermeture WS
        // (métadonnée du close frame, jamais livrée comme un message de flux) suffit à informer
        // le frontend (voir VmConsole.tsx#handleDisconnect).
        socket.close(httpStatus === 404 ? 4404 : 4409, message.slice(0, 120));
        return;
      }

      // Audit AVANT la tentative de connexion amont — l'OUVERTURE de la console par l'opérateur
      // est l'événement à tracer (qui/quelle VM/quand, voir mission), indépendamment du succès
      // effectif de la poignée de main WebSocket vers Prism Central juste après. Jamais capturé
      // par le hook générique plugins/audit.ts (limité aux méthodes mutantes — cette requête est
      // un GET d'upgrade, voir en-tête de fichier).
      await recordAuditEvent({
        actor: request.authSession!.username,
        actorDisplayName: request.authSession!.displayName,
        method: "GET",
        path: `/api/nutanix/vms/${uuid}/console`,
        statusCode: 200,
        ok: true,
      });

      const upstreamUrl = buildNutanixConsoleWsUrl(target.effective.prismCentralUrl, target.wsPath);
      const auth = Buffer.from(`${target.effective.username}:${target.effective.password}`).toString("base64");
      const upstream = new WebSocket(upstreamUrl, "binary", {
        headers: { Authorization: `Basic ${auth}` },
        rejectUnauthorized: config.nutanix.tlsRejectUnauthorized,
        handshakeTimeout: config.nutanix.requestTimeoutMs,
      });

      let closed = false;
      function closeAll(code?: number, reason?: string) {
        if (closed) return;
        closed = true;
        try {
          upstream.terminate();
        } catch {
          // déjà fermé côté Prism Central.
        }
        try {
          if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
            if (code !== undefined) socket.close(code, reason);
            else socket.close();
          }
        } catch {
          // socket déjà fermé côté navigateur.
        }
      }

      // Prism Central -> navigateur (trames RFB/VNC réelles : mises à jour d'écran de la VM).
      upstream.on("open", () => {
        request.log.info({ uuid, vmName: target.vmName, actor: request.authSession?.username }, "nutanix console: upstream VNC proxy connected");
      });
      upstream.on("message", (data: WebSocket.RawData) => {
        if (socket.readyState === socket.OPEN) socket.send(data as Buffer);
      });
      upstream.on("close", () => closeAll());
      upstream.on("error", (err) => {
        request.log.warn({ err, uuid }, "nutanix console: upstream VNC proxy error");
        closeAll(4502, "Prism Central connection lost");
      });

      // navigateur -> Prism Central (trames RFB réelles : frappes clavier/mouvements souris/clics
      // RÉELS de l'opérateur — voir garde-fou de prudence absolue de cette mission : QUAI ne génère
      // ni n'injecte lui-même la moindre trame ici, pur relais bidirectionnel des octets reçus).
      socket.on("message", (data: Buffer) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
      });
      socket.on("close", () => closeAll());
      socket.on("error", () => closeAll());
    },
  );
}
