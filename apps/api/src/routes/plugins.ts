/**
 * Routes GÉNÉRIQUES des greffons — celles par lesquelles l'interface configure, teste, active et
 * désactive n'importe quelle intégration, sans qu'une ligne de code soit écrite par intégration.
 *
 * GET    /api/plugins                       — greffons enregistrés : manifeste PUBLIC + état réel.
 * GET    /api/plugins/:id/config            — vue SÛRE de la configuration (jamais un secret).
 * PUT    /api/plugins/:id/config            — configure/remplace (admin) — teste AVANT d'enregistrer.
 * POST   /api/plugins/:id/config/test       — teste une configuration candidate (admin), ne persiste rien.
 * DELETE /api/plugins/:id/config            — retire la configuration (admin).
 * PUT    /api/plugins/:id/enabled           — active/désactive (admin), sans toucher à la configuration.
 * POST   /api/plugins/:id/actions/:actionId — EXÉCUTE une action déclarée par le greffon (admin).
 * Lecture ouverte à tout rôle authentifié, écriture réservée aux admins — même partage exact que
 * les routes de configuration dédiées (routes/hycu.ts, routes/nutanix.ts…).
 *
 * `enabled` = l'admin ne l'a pas mis en pause ; il vaut donc `true` tant qu'aucune désactivation
 * EXPLICITE n'a été enregistrée, y compris pour un greffon jamais configuré (voir
 * plugins/activation.ts) — c'est `configured` qui dit s'il a de quoi fonctionner. Confondre les
 * deux ferait disparaître de l'interface les pages des greffons pas encore configurés.
 *
 * AUCUN SECRET NE SORT : toutes ces routes renvoient la vue sûre du stockage générique, où chaque
 * champ déclaré secret par le manifeste est remplacé, à sa place, par un booléen `hasX`
 * (setupStore#getSafeIntegrationConfig). La configuration déchiffrée n'est lue que pour tester la
 * connexion et pour fusionner une saisie partielle : elle ne touche jamais une réponse.
 *
 * Les routes dédiées (/api/3cx/config…) restent inchangées et continuent de servir l'écran actuel.
 * Les deux voies écrivent au même endroit, par la même porte (plugins/configStore.ts).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { publicManifest, validateActionInput } from "@quai/plugin-contract";
import type { JSONSchema, Plugin, PluginActionSpec, PublicPluginManifest } from "@quai/plugin-contract";
import { isPluginDisabled } from "../plugins/activation.js";
import { BUILTIN_PLUGINS, isBuiltinPluginId } from "../plugins/builtins.js";
import { configStoreOf, mergeKeepingSecrets } from "../plugins/configStore.js";
import { getPlugin, listPlugins } from "../plugins/registry.js";
import { loadPluginForAdmin } from "../plugins/loader.js";
import { getSafeIntegrationConfig, setIntegrationEnabled } from "../services/setupStore.js";

/** Clés de pilotage du corps de requête : elles ne font pas partie de la configuration. */
const CONTROL_KEYS = new Set(["skipTest"]);
/** Idem pour l'exécution d'une action : `nodeId` désigne la cible, il n'est pas une saisie. */
const ACTION_CONTROL_KEYS = new Set(["nodeId", "input"]);
/** Une action DÉCRITE mais sans schéma d'entrée n'attend rien : tout champ envoyé est refusé comme
 * inconnu, plutôt qu'écarté en silence avant d'atteindre une intégration mutante. */
const NO_INPUT_SCHEMA: JSONSchema = { type: "object", properties: {} };

interface ConfigBody {
  config?: unknown;
  /** Échappatoire EXPLICITE : enregistrer sans tester. Absente/false = la connexion est testée. */
  skipTest?: unknown;
}

interface EnabledBody {
  enabled?: unknown;
}

interface ActionBody {
  /** Identifiant de la ressource visée (uuid de VM…), tel que le manifeste le déclare dans
   * `actions.<nom>.target.field` — jamais un chemin ni un id de nœud préfixé. */
  nodeId?: unknown;
  input?: unknown;
}

/**
 * Statut HTTP porté par l'erreur d'un greffon quand elle en porte un (NutanixActionError#httpStatus
 * : 400 non configuré, 404 introuvable, 409 garde-fou métier, 502 Prism, 504 timeout). Lu par
 * canard-typage : la route générique ne connaît aucune intégration. 502 sinon — jamais un succès
 * silencieux sur une action mutante.
 */
function actionErrorStatus(err: unknown): number {
  const status = (err as { httpStatus?: unknown } | null | undefined)?.httpStatus;
  return typeof status === "number" && status >= 400 && status <= 599 ? status : 502;
}

interface PluginState {
  configured: boolean;
  enabled: boolean;
  config: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Même garde locale admin que routes/hycu.ts#rejectIfNotAdmin : ces routes portent les
 * identifiants de toutes les intégrations de la production. */
function rejectIfNotAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authSession!.roles.includes("admin")) {
    reply.code(403).send({ error: "Insufficient role: admin required" });
    return true;
  }
  return false;
}

function notFound(reply: FastifyReply, id: string): FastifyReply {
  return reply.code(404).send({ error: `Greffon inconnu : "${id}"` });
}

/**
 * État d'un greffon, tel que TOUTES ces routes le renvoient. Les deux booléens ne disent pas la
 * même chose : `enabled` dit si l'admin l'a mis en PAUSE (faux uniquement après une désactivation
 * explicite — un greffon jamais configuré est actif, simplement sans rien à faire), `configured`
 * dit s'il a de quoi fonctionner.
 *
 * `load()` est appelé pour deux raisons : il dit si le greffon est réellement configuré (une entrée
 * incomplète ne l'est pas), et il reprend au passage la configuration restée dans un champ typé
 * hérité — la vue générique montre donc exactement ce que montre la route dédiée. Sa valeur porte
 * les secrets EN CLAIR : seule sa nullité est utilisée ici.
 */
async function stateOf(plugin: Plugin): Promise<PluginState> {
  let loaded: Record<string, unknown> | null = null;
  let readable = true;
  try {
    loaded = await configStoreOf(plugin).load();
  } catch {
    // Secret indéchiffrable (CONFIG_ENCRYPTION_KEY changée depuis l'écriture) : l'écran doit rester
    // consultable pour pouvoir ressaisir la configuration, et un greffon fâché ne doit pas emporter
    // la liste entière. L'entrée existe, on le dit, sans prétendre l'avoir lue.
    readable = false;
  }
  const safe = await getSafeIntegrationConfig(plugin.manifest.id);
  return {
    configured: readable ? loaded !== null : safe !== null,
    // Une seule définition d'« actif » dans tout le socle, celle que lisent les greffons eux-mêmes.
    enabled: !(await isPluginDisabled(plugin.manifest.id)),
    config: safe?.config ?? {},
  };
}

/**
 * Configuration soumise. Forme canonique `{ config: { … } }` ; un corps qui porte directement les
 * champs du formulaire est accepté tel quel, clés de pilotage retirées. `null` = corps inutilisable.
 */
function submittedConfig(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  if (Object.hasOwn(body, "config")) return isRecord(body.config) ? { ...body.config } : null;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!CONTROL_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Entrée soumise à une action. Forme canonique `{ nodeId, input: { … } }` ; un corps qui porte
 * directement les champs de l'action est accepté tel quel, `nodeId` retiré. `null` = corps
 * inutilisable (jamais deviné).
 */
function submittedInput(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  if (Object.hasOwn(body, "input")) {
    if (body.input === undefined || body.input === null) return {};
    return isRecord(body.input) ? { ...body.input } : null;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!ACTION_CONTROL_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Un greffon EN PAUSE n'est pas dans le registre : le chercher là renverrait 404 et il deviendrait
 * impossible à réactiver ou à reconfigurer. On le charge donc à la demande pour l'administration —
 * ce chargement ne le remet pas dans le graphe, le cycle suivant l'en retire.
 */
async function resolvePlugin(id: string) {
  const known = getPlugin(id);
  if (known) return known;
  if (!isBuiltinPluginId(id)) return undefined;
  return (await loadPluginForAdmin(id)) ? getPlugin(id) : undefined;
}

export default async function pluginsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/plugins", async (_request, reply) => {
    // Séquentiel volontairement : `load()` peut REPRENDRE un champ typé hérité, donc écrire. Quatre
    // reprises menées en parallèle se marcheraient dessus (lecture/écriture du même config.json).
    const plugins: Array<{ manifest: PublicPluginManifest; enabled: boolean; configured: boolean }> = [];
    // Les greffons en pause ne sont pas chargés : sans ce rattrapage ils disparaîtraient de la
    // liste, donc de l'écran des Réglages, et plus rien ne permettrait de les réactiver.
    const registered = new Set(listPlugins().map((p) => p.manifest.id));
    for (const entry of BUILTIN_PLUGINS) {
      if (!registered.has(entry.id)) await loadPluginForAdmin(entry.id);
    }
    for (const plugin of listPlugins()) {
      const { configured, enabled } = await stateOf(plugin);
      plugins.push({ manifest: publicManifest(plugin.manifest), enabled, configured });
    }
    return reply.send({ plugins });
  });

  fastify.get<{ Params: { id: string } }>("/api/plugins/:id/config", async (request, reply) => {
    const plugin = await resolvePlugin(request.params.id);
    if (!plugin) return notFound(reply, request.params.id);
    return reply.send(await stateOf(plugin));
  });

  /**
   * La configuration soumise REMPLACE l'ancienne, à une exception près : un champ secret laissé
   * vide conserve celui déjà enregistré (le formulaire ne le réaffiche jamais). La connexion est
   * testée RÉELLEMENT avant d'écrire — un échec ne persiste rien et renvoie le message du greffon.
   */
  fastify.put<{ Params: { id: string }; Body: ConfigBody }>("/api/plugins/:id/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const plugin = await resolvePlugin(request.params.id);
    if (!plugin) return notFound(reply, request.params.id);

    const submitted = submittedConfig(request.body ?? {});
    if (!submitted) return reply.code(400).send({ error: "config doit être un objet" });

    const store = configStoreOf(plugin);
    const merged = mergeKeepingSecrets(submitted, await store.load(), plugin.manifest.secretFields);

    if (request.body?.skipTest !== true) {
      const result = await plugin.test(merged);
      if (!result.ok) return reply.code(400).send({ error: result.message });
    }

    try {
      await store.save(merged);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    return reply.send(await stateOf(plugin));
  });

  /** Ne persiste RIEN. Une saisie partielle est complétée par la configuration enregistrée : on
   * teste le PBX déjà configuré sans avoir à ressaisir son mot de passe. */
  fastify.post<{ Params: { id: string }; Body: ConfigBody }>("/api/plugins/:id/config/test", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const plugin = await resolvePlugin(request.params.id);
    if (!plugin) return notFound(reply, request.params.id);

    const submitted = submittedConfig(request.body ?? {});
    if (!submitted) return reply.code(400).send({ error: "config doit être un objet" });

    const existing = await configStoreOf(plugin).load();
    const candidate = mergeKeepingSecrets({ ...(existing ?? {}), ...submitted }, existing, plugin.manifest.secretFields);

    const result = await plugin.test(candidate);
    return reply.send({ ok: result.ok, message: result.message });
  });

  /** Idempotent : retirer une configuration absente n'est pas une erreur. */
  fastify.delete<{ Params: { id: string } }>("/api/plugins/:id/config", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const plugin = await resolvePlugin(request.params.id);
    if (!plugin) return notFound(reply, request.params.id);

    await configStoreOf(plugin).remove();
    return reply.send({ ok: true });
  });

  /** Bascule SEULE : la configuration, secrets compris, n'est ni relue ni réécrite. */
  fastify.put<{ Params: { id: string }; Body: EnabledBody }>("/api/plugins/:id/enabled", async (request, reply) => {
    if (rejectIfNotAdmin(request, reply)) return;

    const plugin = await resolvePlugin(request.params.id);
    if (!plugin) return notFound(reply, request.params.id);

    const body = request.body ?? {};
    if (typeof body.enabled !== "boolean") return reply.code(400).send({ error: "enabled doit être un booléen" });
    const enabled = body.enabled;

    // Reprend d'abord un éventuel champ typé hérité, sinon activer une intégration configurée
    // avant la migration échouerait faute d'entrée générique à basculer.
    await configStoreOf(plugin).load();

    const updated = await setIntegrationEnabled(plugin.manifest.id, enabled);
    if (!updated) {
      return reply.code(409).send({
        error: `Le greffon "${plugin.manifest.id}" n'a aucune configuration : configurez-le avant de l'activer.`,
      });
    }
    return reply.send(await stateOf(plugin));
  });

  /**
   * CANAL D'EXÉCUTION générique — la seule route par laquelle une action de greffon s'exécute,
   * quelle que soit l'intégration. Rien n'est deviné : chaque refus dit ce qui manque.
   *
   *  404 greffon inconnu        — aucun greffon de cet identifiant n'est enregistré.
   *  409 greffon désactivé      — l'admin l'a mis en pause (plugins/activation.ts) : le socle ne le
   *                               consomme plus, ses actions ne s'exécutent pas davantage.
   *  403 greffon en LECTURE SEULE — sans `permissions.mutates`, aucune action n'est admise.
   *  404 action inconnue        — ce greffon n'implémente pas cette action.
   *  400 entrée refusée         — l'entrée ne satisfait pas le schéma déclaré par le manifeste, ou
   *                               la cible manque alors que l'action en exige une.
   *
   * L'audit est celui du socle (plugins/audit.ts, hook onResponse) : méthode, chemin, statut, acteur
   * — JAMAIS le corps, qui peut porter un mot de passe cloud-init (voir nutanix "vm.create"). C'est
   * l'interface qui traduit le chemin en phrase, avec le libellé du manifeste
   * (apps/web/src/features/audit/auditMessage.ts).
   */
  fastify.post<{ Params: { id: string; actionId: string }; Body: ActionBody }>(
    "/api/plugins/:id/actions/:actionId",
    async (request, reply) => {
      if (rejectIfNotAdmin(request, reply)) return;

      const { id, actionId } = request.params;
      const plugin = await resolvePlugin(id);
      // Un greffon mis en pause n'est PLUS dans le registre (son module n'est même pas chargé, voir
      // plugins/loader.ts) : sans cette distinction, une intégration simplement désactivée se dirait
      // « inconnue » et l'admin chercherait un greffon disparu au lieu de le réactiver.
      if ((await isPluginDisabled(id)) && (plugin !== undefined || isBuiltinPluginId(id))) {
        return reply.code(409).send({
          error: `Le greffon "${plugin?.manifest.name ?? id}" est désactivé : réactivez-le avant d'exécuter une de ses actions.`,
        });
      }
      if (!plugin) return notFound(reply, id);
      if (plugin.manifest.permissions.mutates !== true) {
        return reply.code(403).send({
          error: `Le greffon "${plugin.manifest.name}" est déclaré en lecture seule : il n'expose aucune action.`,
        });
      }

      const action = plugin.actions?.[actionId];
      if (!action) {
        return reply.code(404).send({ error: `Action inconnue : "${actionId}" pour le greffon "${plugin.manifest.name}"` });
      }

      const submitted = submittedInput(request.body ?? {});
      if (!submitted) return reply.code(400).send({ error: "input doit être un objet" });

      const spec: PluginActionSpec | undefined = plugin.manifest.actions?.[actionId];
      const rawNodeId: unknown = request.body?.nodeId;
      const nodeId = typeof rawNodeId === "string" ? rawNodeId.trim() : "";

      // Action NON décrite (greffon d'avant cette description, voir PluginManifest#actions) :
      // l'entrée passe telle quelle, comme avant — le socle n'invente aucune règle qu'il ignore.
      let input: Record<string, unknown> = submitted;
      if (spec) {
        const validated = validateActionInput(spec.input ?? NO_INPUT_SCHEMA, submitted);
        if (!validated.ok) {
          return reply.code(400).send({ error: validated.issues.map((issue) => issue.message).join(" ; ") });
        }
        input = validated.input;

        const target = spec.target;
        if (target) {
          if (!nodeId) {
            return reply.code(400).send({ error: `nodeId est obligatoire : l'action "${actionId}" s'exécute sur un nœud précis.` });
          }
          // La cible vient TOUJOURS de `nodeId` : une valeur du même nom dans l'entrée aurait été
          // refusée plus haut (champ inconnu), l'action ne peut pas être jouée sur une autre machine.
          input[target.field] = nodeId;
        }
      }

      try {
        const result = await action(input);
        return reply.send({ ok: true, result: result ?? null });
      } catch (err) {
        return reply.code(actionErrorStatus(err)).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
