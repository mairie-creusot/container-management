/**
 * Déclaration de types AMBIANTE minimale pour @novnc/novnc — ce paquet ne fournit aucun typage
 * TypeScript officiel exploitable ici (`@types/novnc` est déprécié au profit de `@types/novnc-core`,
 * dont le mapping de module n'est pas garanti coller à l'import réellement utilisé, voir
 * VmConsole.tsx) : on déclare ici UNIQUEMENT la surface d'API RFB effectivement consommée par ce
 * dépôt (constructeur, propriétés de mise à l'échelle/lecture seule, déconnexion) plutôt que de
 * retaper l'intégralité de l'API noVNC — un typage exhaustif mais jamais exercé serait plus
 * trompeur qu'utile ici. Les événements ('connect'/'disconnect'/'securityfailure') sont consommés
 * via `CustomEvent` casté à l'usage (voir VmConsole.tsx) plutôt que typés ici :
 * `EventTarget#addEventListener` natif attend un `EventListener` générique (paramètre `Event`),
 * pas un `CustomEvent<T>` précis (incompatible avec `strictFunctionTypes`).
 *
 * Module déclaré sous le nom de paquet NU ("@novnc/novnc"), PAS "@novnc/novnc/core/rfb.js" — bug
 * réel constaté le 14/08/2026 en vérification live (voir VmConsole.tsx) : le package.json réel de
 * ce paquet installé a `"exports": "./core/rfb.js"` (une chaîne = un SEUL point d'entrée, celui du
 * nom de paquet lui-même) — aucun sous-chemin profond n'est exposé, Vite refuse de le résoudre au
 * runtime ("Package subpath 'undefined' is not defined by exports") même si tsc ne le détecte
 * jamais (résolution d'export map = un détail du bundler, hors du contrôle de types).
 */
declare module "@novnc/novnc" {
  export interface RFBCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export interface RFBOptions {
    shared?: boolean;
    credentials?: RFBCredentials;
    wsProtocols?: string[];
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string, options?: RFBOptions);
    /** true = lecture seule (aucune frappe/clic transmis à la VM) — JAMAIS activé par défaut pour
     * la fonctionnalité livrée (le clavier/souris réel est tout le but, voir mission "comme en
     * bureaux distance"), mais peut être forcé à `true` explicitement pour une vérification
     * lecture-seule (voir garde-fou de prudence absolue de cette mission). */
    viewOnly: boolean;
    /** Redimensionne visuellement le canevas à la taille du conteneur SANS changer la résolution
     * réelle de la VM (contrairement à `resizeSession`, jamais activé ici — modifier le mode vidéo
     * d'une VRAIE VM de production depuis un simple redimensionnement de fenêtre serait intrusif). */
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    disconnect(): void;
  }
}
