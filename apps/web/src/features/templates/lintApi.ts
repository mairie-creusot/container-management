// Appels de vérification serveur du studio (lint shell + packer validate) — module autonome,
// AUCUN ajout dans templatesSlice/types.ts (contrat backend à venir, types locaux ici).
import { ApiError, apiPost } from "@/api/client";

export interface ShellLintError {
  line?: number;
  message: string;
}

export type ShellLintResult =
  | { state: "ok" }
  | { state: "errors"; errors: ShellLintError[] }
  | { state: "unavailable" }
  | { state: "failed"; message: string };

export const LINT_UNAVAILABLE_MESSAGE = "Vérification serveur pas encore disponible.";

/** POST /api/iac/lint — 404 = backend pas encore là ("unavailable"), jamais une fausse réussite. */
export async function lintShell(content: string): Promise<ShellLintResult> {
  try {
    const res = await apiPost<{ ok: boolean; errors?: ShellLintError[] }>("/iac/lint", { kind: "shell", content });
    if (res.ok) return { state: "ok" };
    const errors = res.errors ?? [];
    return { state: "errors", errors: errors.length > 0 ? errors : [{ message: "Erreur signalée par le serveur sans détail." }] };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { state: "unavailable" };
    return { state: "failed", message: err instanceof Error ? err.message : "Échec de la vérification du script." };
  }
}

export type TemplateValidateResult =
  | { state: "ok"; output: string }
  | { state: "errors"; output: string }
  | { state: "unavailable" }
  | { state: "failed"; message: string };

/** POST /api/templates/:id/validate — packer validate réel côté serveur, sortie brute affichée. */
export async function validateTemplate(id: string): Promise<TemplateValidateResult> {
  try {
    const res = await apiPost<{ ok: boolean; output: string }>(`/templates/${encodeURIComponent(id)}/validate`);
    return res.ok ? { state: "ok", output: res.output ?? "" } : { state: "errors", output: res.output ?? "" };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { state: "unavailable" };
    return { state: "failed", message: err instanceof Error ? err.message : "Échec de la vérification de la recette." };
  }
}
