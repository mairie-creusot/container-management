/**
 * Catalogue de templates d'images (voir services/templates.ts).
 *
 * GET    /api/templates             — liste (statuts réconciliés avec les runs réels).
 * POST   /api/templates             — { name, kind, baseVersion, components } (operator/admin,
 *                                     garanti par le plugin auth comme toute mutation).
 * GET    /api/templates/:id         — détail.
 * DELETE /api/templates/:id         — supprime le template ET son workspace IaC.
 * POST   /api/templates/:id/build   — lance le build réel via services/iac/runner.ts.
 * GET    /api/templates/:id/builds  — historique des runs du workspace du template.
 */

import type { FastifyInstance } from "fastify";
import {
  buildTemplate,
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplateBuilds,
  listTemplates,
  NutanixNotConfiguredError,
  TemplateNotFoundError,
  TemplateValidationError,
} from "../services/templates.js";
import type { ImageTemplateKind } from "../types.js";

interface CreateTemplateBody {
  name?: string;
  kind?: string;
  baseVersion?: string;
  components?: unknown;
}

export default async function templatesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/templates", async (_request, reply) => {
    return reply.send(await listTemplates());
  });

  fastify.post<{ Body: CreateTemplateBody }>("/api/templates", async (request, reply) => {
    const { name, kind, baseVersion, components } = request.body ?? {};
    if (typeof name !== "string" || !name.trim()) return reply.code(400).send({ error: "name is required" });
    if (typeof kind !== "string") return reply.code(400).send({ error: "kind is required" });
    if (baseVersion !== undefined && typeof baseVersion !== "string") {
      return reply.code(400).send({ error: "baseVersion must be a string" });
    }
    if (components !== undefined && !(Array.isArray(components) && components.every((c) => typeof c === "string"))) {
      return reply.code(400).send({ error: "components must be an array of strings" });
    }
    try {
      const template = await createTemplate(
        {
          name,
          kind: kind as ImageTemplateKind,
          baseVersion: baseVersion ?? "",
          components: (components as string[] | undefined) ?? [],
        },
        request.authSession!.username,
      );
      return reply.code(201).send(template);
    } catch (err) {
      if (err instanceof TemplateValidationError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  fastify.get<{ Params: { id: string } }>("/api/templates/:id", async (request, reply) => {
    const template = await getTemplate(request.params.id);
    if (!template) return reply.code(404).send({ error: `Template "${request.params.id}" not found` });
    return reply.send(template);
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
}
