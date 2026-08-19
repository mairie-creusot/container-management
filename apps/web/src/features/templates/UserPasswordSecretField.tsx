import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchSecrets } from "@/features/secrets/secretsSlice";
import { USER_PASSWORD_SECRET_HINT } from "@/features/templates/templateCatalog";
import type { TemplateStep } from "@/types";

type UserStep = Extract<TemplateStep, { type: "user" }>;

/** Mot de passe d'une étape "utilisateur" : NOM d'un secret QUAI existant (GET /api/secrets), sa
 * valeur n'est jamais lue ici. Partagé par le studio et le popover du sous-graphe recette. */
export default function UserPasswordSecretField({
  id,
  step,
  busy,
  onChange,
}: {
  id: string;
  step: UserStep;
  busy?: boolean;
  onChange: (next: UserStep) => void;
}) {
  const dispatch = useAppDispatch();
  const secrets = useAppSelector((s) => s.secrets.items);
  const secretsStatus = useAppSelector((s) => s.secrets.status);

  useEffect(() => {
    if (secretsStatus === "idle") dispatch(fetchSecrets());
  }, [dispatch, secretsStatus]);

  const selected = step.passwordSecretName ?? "";
  // Secret référencé mais absent de la liste (supprimé/renommé) : conservé et signalé, jamais effacé
  // en douce.
  const missing = selected !== "" && secretsStatus === "ready" && !secrets.some((s) => s.name === selected);

  return (
    <div className="field">
      <label htmlFor={id}>Mot de passe — secret QUAI existant (optionnel)</label>
      {secretsStatus === "loading" && <span className="template-modal__hint">Chargement des secrets…</span>}
      {secretsStatus === "error" && <span className="template-modal__field-error">Échec du chargement des secrets.</span>}
      <select
        id={id}
        value={selected}
        onChange={(e) => {
          const v = e.target.value;
          const { passwordSecretName: _omit, ...rest } = step;
          onChange(v === "" ? rest : { ...rest, passwordSecretName: v });
        }}
        disabled={busy}
      >
        <option value="">— aucun (mot de passe jetable généré) —</option>
        {missing && <option value={selected}>{selected} (introuvable)</option>}
        {secrets.map((s) => (
          <option key={s.id} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>
      {secretsStatus === "ready" && secrets.length === 0 && (
        <span className="template-modal__hint">Aucun secret enregistré — créez-en un dans « Secrets » pour le référencer ici.</span>
      )}
      <span className="template-modal__hint">
        Seul le NOM du secret est enregistré dans la recette, jamais sa valeur. {USER_PASSWORD_SECRET_HINT}
      </span>
      {missing && (
        <span className="template-modal__field-error">
          Le secret « {selected} » n'existe plus — le build échouera tant qu'il n'est pas recréé ou remplacé.
        </span>
      )}
    </div>
  );
}
