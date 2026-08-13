import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import Modal from "@/components/Modal";
import { wsUrl } from "@/api/client";

interface ContainerConsoleProps {
  /** null = fermé (aucune connexion) ; sinon l'id du conteneur ciblé. */
  containerId: string | null;
  containerName: string;
  onClose: () => void;
}

type ConnectionStatus = "connecting" | "connected" | "closed" | "error";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "Connexion…",
  connected: "Connecté",
  closed: "Session terminée",
  error: "Erreur",
};

interface ContainerConsoleBodyProps {
  containerId: string;
  containerName: string;
  /** Affiché seulement en contexte Modal (bouton "Fermer" + titre porté par le header) — absent en
   * usage inline (TopologySubGraphPanel.tsx), où le titre/la fermeture sont déjà gérés par l'onglet
   * parent, un second en-tête ferait doublon. */
  onClose?: () => void;
}

/**
 * Contenu RÉEL du terminal (connexion WebSocket + xterm.js) — extrait de ContainerConsole ci-
 * dessous pour être réutilisable SANS le wrapper Modal (voir TopologySubGraphPanel.tsx § onglet
 * "Shell", qui l'affiche inline dans le sous-graphe plutôt que dans une fenêtre superposée). Même
 * connexion RÉELLE (GET (WS) /api/console/:id) dans les deux cas, aucune logique dupliquée.
 */
export function ContainerConsoleBody({ containerId, containerName, onClose }: ContainerConsoleBodyProps) {
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!containerId || !terminalHostRef.current) return;

    // Garde-fou contre la fermeture d'UNE ANCIENNE connexion qui écrase le state d'une NOUVELLE
    // déjà en place — un effet React est démonté/remonté plus souvent qu'il n'y paraît (double
    // montage de développement sous React.StrictMode, voir main.tsx ; ou ce composant réutilisé
    // inline dans un onglet qui se re-rend, TopologySubGraphPanel.tsx) : le nettoyage ci-dessous
    // appelle `socket.close()`, ce qui déclenche quand même `onclose`/`onerror` de FAÇON
    // ASYNCHRONE — sans cette garde, ce close "normal" (fermeture volontaire par le nettoyage)
    // pouvait arriver APRÈS qu'un nouvel effet ait déjà ouvert une connexion suivante, écrasant à
    // tort son statut "connecté" par "Connexion interrompue" (constaté en conditions réelles le
    // 13/08/2026 : invite affichée puis bandeau d'erreur alors que la session restait utilisable).
    let active = true;

    setStatus("connecting");
    setErrorMessage(null);

    const terminal = new Terminal({
      convertEol: true,
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      theme: { background: "#0a0e14", foreground: "#d4d9e0" },
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalHostRef.current);
    try {
      fitAddon.fit();
    } catch {
      // le conteneur DOM peut être à taille nulle au tout premier rendu du Modal (animation).
    }
    terminal.focus();

    const socket = new WebSocket(wsUrl(`/console/${encodeURIComponent(containerId)}`));
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      if (active) setStatus("connected");
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        terminal.write(event.data);
      } else {
        terminal.write(new Uint8Array(event.data as ArrayBuffer));
      }
    };
    socket.onerror = () => {
      if (!active) return;
      setStatus("error");
      setErrorMessage("Connexion au conteneur interrompue.");
    };
    socket.onclose = (event) => {
      if (!active) return; // fermeture volontaire par le nettoyage ci-dessous, voir le commentaire de tête d'effet
      setStatus((current) => (current === "error" ? current : "closed"));
      // Un rejet d'authentification/rôle (401/403) empêche l'upgrade WebSocket lui-même —
      // il se manifeste ici comme un onerror/onclose générique du navigateur (pas de `reason`
      // exploitable), pas comme un code personnalisé. Seul le cas "conteneur non exécutable"
      // (code 4404, voir routes/console.ts) arrive après un upgrade réussi et porte un message
      // clair, déjà écrit dans le terminal en plus d'ici via `event.reason`.
      if (event.reason) setErrorMessage(event.reason);
    };

    const dataDisposable = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    });

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // idem ci-dessus : ignoré, un prochain resize corrigera l'affichage.
      }
    });
    resizeObserver.observe(terminalHostRef.current);

    return () => {
      active = false;
      resizeObserver.disconnect();
      dataDisposable.dispose();
      socket.close();
      terminal.dispose();
    };
  }, [containerId]);

  return (
    <div className="container-console-modal">
      <div className="container-console-modal__header">
        <div>
          <div id="container-console-title" className="container-console-modal__title">
            Console — {containerName}
          </div>
          <div className="container-console-modal__subtitle">{containerId.slice(0, 12)}</div>
        </div>
        <div className={`container-console-modal__status container-console-modal__status--${status}`}>
          <span className="container-console-modal__status-dot" />
          {STATUS_LABEL[status]}
        </div>
        {onClose && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Fermer
          </button>
        )}
      </div>
      <div className="container-console-modal__terminal" ref={terminalHostRef} />
      {errorMessage && <div className="error-banner container-console-modal__error">{errorMessage}</div>}
    </div>
  );
}

/**
 * Version Modal (ContainersPage.tsx) — inchangée pour ses appelants existants, délègue tout le
 * contenu réel à ContainerConsoleBody ci-dessus.
 */
export default function ContainerConsole({ containerId, containerName, onClose }: ContainerConsoleProps) {
  const open = containerId !== null;
  return (
    <Modal open={open} onClose={onClose} labelledBy="container-console-title">
      {open && <ContainerConsoleBody containerId={containerId} containerName={containerName} onClose={onClose} />}
    </Modal>
  );
}
