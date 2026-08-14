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
export default function VmConsole({ vmUuid, vmName, onClose }: VmConsoleProps) {
  const open = vmUuid !== null;
  const screenHostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!vmUuid || !screenHostRef.current) return;

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
    <Modal open={open} onClose={onClose} labelledBy="vm-console-title">
      {open && (
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
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Fermer
            </button>
          </div>
          <div className="vm-console-modal__screen" ref={screenHostRef} />
          {errorMessage && <div className="error-banner vm-console-modal__error">{errorMessage}</div>}
        </div>
      )}
    </Modal>
  );
}
