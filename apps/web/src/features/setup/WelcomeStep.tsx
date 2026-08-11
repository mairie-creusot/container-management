const UPCOMING = [
  "Annuaire LDAP — mécanisme d'authentification principal (obligatoire).",
  "Orchestrateurs — Docker/Swarm et Kubernetes (facultatif, configurable plus tard).",
  "Registries — Docker Hub, GHCR, GitLab, Harbor (facultatif).",
  "Récapitulatif — vérification de tout ce qui a été testé avant de terminer.",
];

export default function WelcomeStep() {
  return (
    <div>
      <div className="setup-step-title">Bienvenue sur QUAI</div>
      <p className="setup-step-subtitle">
        Aucune configuration n'a encore été enregistrée. Ces quelques étapes préparent l'annuaire
        LDAP, les orchestrateurs et les registries avant de pouvoir se connecter à l'application.
      </p>
      <div className="setup-welcome-list">
        {UPCOMING.map((label, index) => (
          <div className="setup-welcome-list__item" key={label}>
            <span className="setup-welcome-list__index">{index + 1}</span>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
