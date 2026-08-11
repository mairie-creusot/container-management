import { useAppDispatch, useAppSelector } from "@/hooks";
import { setCurrentStep, WIZARD_STEPS, type WizardStepId } from "@/features/setup/setupSlice";
import Brand from "@/components/Brand";
import WelcomeStep from "@/features/setup/WelcomeStep";
import LdapStep from "@/features/setup/LdapStep";
import OrchestratorsStep from "@/features/setup/OrchestratorsStep";
import RegistriesStep from "@/features/setup/RegistriesStep";
import SummaryStep from "@/features/setup/SummaryStep";

const STEP_COMPONENTS: Record<WizardStepId, () => JSX.Element> = {
  welcome: WelcomeStep,
  ldap: LdapStep,
  orchestrators: OrchestratorsStep,
  registries: RegistriesStep,
  summary: SummaryStep,
};

// Assistant plein écran (pas de Sidebar/Topbar) affiché tant que
// GET /api/setup/status renvoie completed: false. Chaque étape sauvegarde
// son état dans setupSlice au fur et à mesure (pas de perte de saisie en
// changeant d'étape) — voir ARCHITECTURE.md § Conventions UI : aucune
// interception via `beforeunload`, uniquement via ConfirmDialog pour les
// éventuels liens de sortie internes (il n'y en a pas dans ce premier
// lancement : rien ne permet de quitter l'assistant avant la fin).
export default function SetupWizard() {
  const dispatch = useAppDispatch();
  const currentStep = useAppSelector((s) => s.setup.currentStep);
  const ldapTest = useAppSelector((s) => s.setup.ldap.test);
  const currentIndex = WIZARD_STEPS.findIndex((step) => step.id === currentStep);
  const StepComponent = STEP_COMPONENTS[currentStep];

  const canGoNext = currentStep === "ldap" ? ldapTest === "ok" : true;

  function goTo(index: number) {
    const step = WIZARD_STEPS[index];
    if (step) dispatch(setCurrentStep(step.id));
  }

  return (
    <div className="setup-screen">
      <div className="setup-shell">
        <div className="setup-header">
          <Brand size="lg" />
          <div>
            <div className="setup-header__title">Configuration de QUAI</div>
            <div className="setup-header__subtitle">
              Premier lancement — l'application n'est pas encore utilisable.
            </div>
          </div>
        </div>

        <ol className="setup-steps">
          {WIZARD_STEPS.map((step, index) => {
            const state = index < currentIndex ? "done" : index === currentIndex ? "active" : "upcoming";
            return (
              <li key={step.id} className={`setup-step setup-step--${state}`}>
                <span className="setup-step__index">{index < currentIndex ? "✓" : index + 1}</span>
                <span className="setup-step__label">{step.label}</span>
              </li>
            );
          })}
        </ol>

        <div className="setup-body">
          <StepComponent />
        </div>

        <div className="setup-footer">
          {currentIndex > 0 && (
            <button type="button" className="btn btn-ghost" onClick={() => goTo(currentIndex - 1)}>
              Précédent
            </button>
          )}
          <span className="setup-footer__spacer" />
          {currentStep !== "summary" && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canGoNext}
              onClick={() => goTo(currentIndex + 1)}
            >
              {currentStep === "welcome" ? "Commencer" : "Suivant"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
