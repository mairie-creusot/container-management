import { useState } from "react";
import { LINT_UNAVAILABLE_MESSAGE, validateTemplate, type TemplateValidateResult } from "@/features/templates/lintApi";

/** Bouton "Vérifier la recette" (packer validate serveur) + sortie brute — utilisé par l'écran
 * "créé" du studio et le panneau de détail d'un nœud image-template. */
export default function RecipeVerification({ templateId }: { templateId: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TemplateValidateResult | null>(null);

  async function handleVerify() {
    setBusy(true);
    setResult(await validateTemplate(templateId));
    setBusy(false);
  }

  const unavailable = result?.state === "unavailable";

  return (
    <div className="recipe-verify">
      <div className="recipe-verify__bar">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void handleVerify()}
          disabled={busy}
          title={unavailable ? LINT_UNAVAILABLE_MESSAGE : "packer validate exécuté côté serveur"}
        >
          {busy ? "Vérification…" : "Vérifier la recette"}
        </button>
        {result?.state === "ok" && <span className="code-lint__ok">vérifiée ✓</span>}
        {result?.state === "errors" && <span className="code-lint__badge">échec</span>}
      </div>
      {unavailable && <p className="template-modal__hint">{LINT_UNAVAILABLE_MESSAGE}</p>}
      {result?.state === "failed" && <p className="template-modal__field-error">{result.message}</p>}
      {(result?.state === "ok" || result?.state === "errors") && result.output.trim() !== "" && (
        <pre className={result.state === "errors" ? "recipe-verify__output recipe-verify__output--errors" : "recipe-verify__output"}>
          {result.output}
        </pre>
      )}
    </div>
  );
}
