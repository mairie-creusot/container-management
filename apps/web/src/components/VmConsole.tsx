import { useEffect, useRef, useState } from "react";
// @novnc/novnc n'expose qu'UN SEUL point d'entrée dans son package.json ("exports": "./core/
// rfb.js", une chaîne, pas une carte de sous-chemins) — importer "@novnc/novnc/core/rfb.js"
// directement échoue donc au runtime Vite ("Package subpath 'undefined' is not defined by
// exports", bug réel constaté le 14/08/2026 en vérification live) même si tsc ne le détecte
// jamais (résolution d'export map = un détail du bundler, hors du contrôle de types). Seul
// l'import du nom de paquet nu est valide.
import RFB from "@novnc/novnc";
import Modal from "@/components/Modal";
import { wsUrl } from "@/api/client";

interface VmConsoleProps {
  /** null = fermé (aucune connexion) ; sinon l'uuid Nutanix de la VM ciblée. */
  vmUuid: string | null;
  vmName: string;
  onClose: () => void;
}

interface VmConsoleBodyProps {
  /** Toujours renseigné ici : le corps n'est monté que lorsqu'une VM est réellement ciblée. */
  vmUuid: string;
  vmName: string;
  /** Absent quand la console est affichée EN LIGNE (onglet du sous-graphe) : il n'y a rien à fermer. */
  onClose?: (() => void) | undefined;
}

type ConnectionStatus = "connecting" | "connected" | "closed" | "error";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "Connexion…",
  connected: "Connecté",
  closed: "Session terminée",
  error: "Erreur",
};

/**
 * Console VNC RÉELLE d'une VM Nutanix — accès clavier/souris RÉEL à l'intérieur de la VM, PAS un
 * RDP authentifié séparé : l'utilisateur tape ses identifiants directement dans l'écran affiché,
 * exactement comme s'il était physiquement devant la VM (mission : "je pousse voir interieur des
 * vm comme en bureaux distance aussi"). Même squelette EXACT que ContainerConsole.tsx (connexion
 * WebSocket réelle vers QUAI, jamais directement vers Prism Central/l'hyperviseur — voir
 * routes/nutanix.ts#GET /api/nutanix/vms/:uuid/console) — noVNC/RFB à la place de xterm.js.
 */
/**
 * Le CONTENU de la console, sans fenêtre autour — même découpe que ContainerConsole.tsx#
 * ContainerConsoleBody, pour la même raison : cette console s'affiche aussi bien en modale que
 * comme onglet du sous-graphe d'une VM, à la place exacte où un conteneur a son Shell. Une seule
 * implémentation de la connexion RFB, jamais deux à garder d'accord.
 */
export function VmConsoleBody({ vmUuid, vmName, onClose }: VmConsoleBodyProps) {
  const screenHostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!screenHostRef.current) return;

    // Même garde-fou EXACT que ContainerConsole.tsx#ContainerConsoleBody (voir son commentaire de
    // tête d'effet) : un `disconnect` déclenché par le nettoyage ci-dessous arrive de façon
    // asynchrone, `active` évite qu'il n'écrase à tort le state d'une connexion suivante déjà
    // établie (double montage React.StrictMode en dev, ou re-render de ce composant monté inline).
    let active = true;

    setStatus("connecting");
    setErrorMessage(null);

    const rfb = new RFB(screenHostRef.current, wsUrl(`/nutanix/vms/${encodeURIComponent(vmUuid)}/console`));
    // Mise à l'échelle VISUELLE uniquement (canevas adapté à la taille de la modale) — jamais
    // `resizeSession` : changer la résolution vidéo RÉELLE d'une VM de production au gré du
    // redimensionnement d'une fenêtre de navigateur serait intrusif pour une machine en prod.
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.clipViewport = false;
    // Accès clavier/souris RÉEL — c'est tout le but de cette fonctionnalité, voir mission ("comme
    // en bureaux distance"). Jamais forcé à `true` ici : la vérification en LECTURE SEULE exigée
    // par la mission se fait en ne touchant simplement ni au clavier ni à la souris pendant le
    // test, pas en modifiant ce composant livré (voir garde-fou de prudence absolue de la mission).
    rfb.viewOnly = false;

    function handleConnect() {
      if (active) setStatus("connected");
    }
    function handleDisconnect(event: Event) {
      if (!active) return;
      const clean = (event as CustomEvent<{ clean?: boolean }>).detail?.clean;
      setStatus((current) => (current === "error" ? current : "closed"));
      if (clean === false) setErrorMessage("Connexion à la console interrompue.");
    }
    function handleSecurityFailure(event: Event) {
      if (!active) return;
      const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
      setStatus("error");
      setErrorMessage(reason ?? "Échec de sécurité de la connexion VNC.");
    }

    rfb.addEventListener("connect", handleConnect);
    rfb.addEventListener("disconnect", handleDisconnect);
    rfb.addEventListener("securityfailure", handleSecurityFailure);

    return () => {
      active = false;
      rfb.removeEventListener("connect", handleConnect);
      rfb.removeEventListener("disconnect", handleDisconnect);
      rfb.removeEventListener("securityfailure", handleSecurityFailure);
      rfb.disconnect();
    };
  }, [vmUuid]);

  return (
    <div className="vm-console-modal">
      <div className="vm-console-modal__header">
        <div>
          <div id="vm-console-title" className="vm-console-modal__title">
            Console — {vmName}
          </div>
          <div className="vm-console-modal__subtitle">Accès clavier/souris réel à la VM — comme en bureau à distance</div>
        </div>
        <div className={`vm-console-modal__status vm-console-modal__status--${status}`}>
          <span className="vm-console-modal__status-dot" />
          {STATUS_LABEL[status]}
        </div>
        {onClose && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Fermer
          </button>
        )}
      </div>
      <div className="vm-console-modal__screen" ref={screenHostRef} />
      {errorMessage && <div className="error-banner vm-console-modal__error">{errorMessage}</div>}
    </div>
  );
}

/**
 * Console VNC en MODALE — enveloppe seule, le contenu réel est VmConsoleBody ci-dessus (même
 * patron que ContainerConsole.tsx).
 */
export default function VmConsole({ vmUuid, vmName, onClose }: VmConsoleProps) {
  return (
    <Modal open={vmUuid !== null} onClose={onClose} labelledBy="vm-console-title">
      {vmUuid !== null && <VmConsoleBody vmUuid={vmUuid} vmName={vmName} onClose={onClose} />}
    </Modal>
  );
}
