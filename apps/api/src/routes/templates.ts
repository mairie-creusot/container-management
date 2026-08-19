// Moteur de recettes de templates d'images (voir services/templates.ts).
//
// GET    /api/templates                  — liste (statuts réconciliés avec les runs réels).
// POST   /api/templates                  — { name, base, steps } (operator/admin via plugin auth).
// GET    /api/templates/presets          — recettes pré-remplies (simples valeurs de départ).
// GET    /api/templates/artifact-sources — templates à artefact exploitable (picker frontend).
// GET    /api/templates/:id              — détail.
// PUT    /api/templates/:id              — { name?, base?, steps? } : met à jour la recette ET
//                                          régénère les fichiers du workspace (409 si build en cours).
// DELETE /api/templates/:id              — supprime le template ET son workspace IaC.
// POST   /api/templates/:id/build        — lance le build réel via services/iac/runner.ts.
// GET    /api/templates/:id/builds       — historique des runs du workspace du template.

import type { FastifyInstance } from "fastify";
import {
  buildTemplate,
  createTemplate,
  deleteTemplate,
  getTemplate,
  listArtifactSources,
  listTemplateBuilds,
  listTemplates,
  MkosiUnavailableError,
  NutanixNotConfiguredError,
  TEMPLATE_PRESETS,
  TemplateBuildInProgressError,
  TemplateNotFoundError,
  TemplateValidationError,
  resolveBuildPlacement,
  updateTemplate,
  validateTemplate,
} from "../services/templates.js";
import { getBuildDefaults, setBuildDefaults } from "../services/templateBuildDefaultsStore.js";
import type { TemplateBase, TemplateStep } from "../types.js";

interface CreateTemplateBody {
  name?: string;
  base?: unknown;
  steps?: unknown;
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null);
}

export default async function templatesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/templates", async (_request, reply) => {
    return reply.send(await listTemplates());
  });

  fastify.get("/api/templates/presets", async (_request, reply) => {
    return reply.send(TEMPLATE_PRESETS);
  });

  fastify.get("/api/templates/artifact-sources", async (_request, reply) => {
    return reply.send(await listArtifactSources());
  });

  fastify.post<{ Body: CreateTemplateBody }>("/api/templates", async (request, reply) => {
    const { name, base, steps } = request.body ?? {};
    if (typeof name !== "string" || !name.trim()) return reply.code(400).send({ error: "name is required" });
    if (typeof base !== "object" || base === null || typeof (base as { type?: unknown }).type !== "string") {
      return reply.code(400).send({ error: "base is required ({ type, ... })" });
    }
    if (steps !== undefined && !isRecordArray(steps)) {
      return reply.code(400).send({ error: "steps must be an array of step objects" });
    }
    try {
      const template = await createTemplate(
        {
          name,
          base: base as TemplateBase,
          steps: (steps as TemplateStep[] | undefined) ?? [],
        },
        request.authSession!.username,
      );
      return reply.code(201).send(template);
    } catch (err) {
      if (err instanceof TemplateValidationError) return reply.code(400).send({ error: err.message });
      if (err instanceof MkosiUnavailableError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  // Cluster/subnet de la VM temporaire des builds Packer — valeurs enregistrées + déduction sûre.
  fastify.get("/api/templates/build-defaults", async (_request, reply) => {
    const [saved, resolved] = await Promise.all([getBuildDefaults(), resolveBuildPlacement()]);
    return reply.send({ saved, resolved });
  });

  fastify.put<{ Body: { clusterName?: unknown; subnetName?: unknown } }>("/api/templates/build-defaults", async (request, reply) => {
    const { clusterName, subnetName } = request.body ?? {};
    for (const [field, value] of [
      ["clusterName", clusterName],
      ["subnetName", subnetName],
    ] as const) {
      if (value !== undefined && value !== null && typeof value !== "string") {
        return reply.code(400).send({ error: `${field} must be a string` });
      }
    }
    const saved = await setBuildDefaults({
      ...(typeof clusterName === "string" && clusterName.trim() ? { clusterName: clusterName.trim() } : {}),
      ...(typeof subnetName === "string" && subnetName.trim() ? { subnetName: subnetName.trim() } : {}),
    });
    return reply.send({ saved, resolved: await resolveBuildPlacement() });
  });

  fastify.get<{ Params: { id: string } }>("/api/templates/:id", async (request, reply) => {
    const template = await getTemplate(request.params.id);
    if (!template) return reply.code(404).send({ error: `Template "${request.params.id}" not found` });
    return reply.send(template);
  });

  fastify.put<{ Params: { id: string }; Body: CreateTemplateBody }>("/api/templates/:id", async (request, reply) => {
    const { name, base, steps } = request.body ?? {};
    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return reply.code(400).send({ error: "name must be a non-empty string" });
    }
    if (base !== undefined && (typeof base !== "object" || base === null || typeof (base as { type?: unknown }).type !== "string")) {
      return reply.code(400).send({ error: "base must be an object ({ type, ... })" });
    }
    if (steps !== undefined && !isRecordArray(steps)) {
      return reply.code(400).send({ error: "steps must be an array of step objects" });
    }
    try {
      const template = await updateTemplate(
        request.params.id,
        {
          ...(name !== undefined ? { name } : {}),
          ...(base !== undefined ? { base: base as TemplateBase } : {}),
          ...(steps !== undefined ? { steps: steps as TemplateStep[] } : {}),
        },
        request.authSession!.username,
      );
      return reply.send(template);
    } catch (err) {
      if (err instanceof TemplateNotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof TemplateValidationError) return reply.code(400).send({ error: err.message });
      if (err instanceof TemplateBuildInProgressError) return reply.code(409).send({ error: err.message });
      if (err instanceof MkosiUnavailableError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  fastify.delete<{ Params: { id: string } }>("/api/templates/:id", async (request, reply) => {
    try {
      await deleteTemplate(request.params.id);
      return reply.send({ ok: true });
    } catch (err) {
      if (err instanceof TemplateNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  fastify.post<{ Params: { id: string } }>("/api/templates/:id/build", async (request, reply) => {
    try {
      const template = await buildTemplate(request.params.id, request.authSession!.username);
      return reply.code(201).send(template);
    } catch (err) {
      if (err instanceof TemplateNotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof MkosiUnavailableError) return reply.code(409).send({ error: err.message });
      if (err instanceof NutanixNotConfiguredError) return reply.code(400).send({ error: err.message });
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  fastify.get<{ Params: { id: string } }>("/api/templates/:id/builds", async (request, reply) => {
    try {
      return reply.send(await listTemplateBuilds(request.params.id));
    } catch (err) {
      if (err instanceof TemplateNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  // Vérification réelle sans build (sh -n + packer validate factice) — voir services/templates.ts.
  fastify.post<{ Params: { id: string } }>("/api/templates/:id/validate", async (request, reply) => {
    try {
      return reply.send(await validateTemplate(request.params.id));
    } catch (err) {
      if (err instanceof TemplateNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });
}
