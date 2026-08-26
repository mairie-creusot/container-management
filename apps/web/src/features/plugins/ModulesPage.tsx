import ModulesSection from "@/features/settings/ModulesSection";

/** Page « Modules » du menu latéral — même contenu que la section des Réglages : les modules se
 * gèrent au même endroit qu'on les installe, il n'y a pas deux vérités à tenir. */
export default function ModulesPage() {
  return (
    <div className="workspace">
      <div className="page-content">
        <ModulesSection />
      </div>
    </div>
  );
}
