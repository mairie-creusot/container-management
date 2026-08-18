// Détection PURE du langage d'un fichier pour CodeEditor.tsx — aucun import CodeMirror ici
// (testée par codeLanguage.test.ts en environnement node).

/** "hcl" est approximé par le mode ruby (chaînes/commentaires #/nombres — pas de mode HCL propre
 * dans legacy-modes) ; "text" désactive toute coloration. */
export type CodeLanguage = "shell" | "yaml" | "dockerfile" | "hcl" | "properties" | "text";

/** Langage déduit du nom/chemin d'un fichier — "text" quand rien de fiable n'est reconnu. */
export function languageForPath(path: string): CodeLanguage {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile";
  if (name.endsWith(".sh") || name.endsWith(".bash")) return "shell";
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";
  if (name.endsWith(".hcl") || name.endsWith(".tf") || name.endsWith(".tfvars")) return "hcl";
  if (name.endsWith(".conf") || name.endsWith(".ini") || name.endsWith(".properties") || name.endsWith(".toml") || name === ".env" || name.endsWith(".env")) return "properties";
  return "text";
}
