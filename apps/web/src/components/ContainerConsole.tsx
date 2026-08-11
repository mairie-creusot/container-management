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

/**
 * Terminal interactif réel dans un conteneur (docker exec, voir GET (WS) /api/console/:id) —
 * xterm.js affiché dans un Modal. Monté en permanence par ContainersPage.tsx ; `containerId`
 * pilote l'ouverture/fermeture de la connexion WebSocket (voir useEffect ci-dessous).
 */
export default function ContainerConsole({ containerId, containerName, onClose }: ContainerConsoleProps) {
  const open = containerId !== null;
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!containerId || !terminalHostRef.current) return;

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

    socket.onopen = () => setStatus("connected");
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        terminal.write(event.data);
      } else {
        terminal.write(new Uint8Array(event.data as ArrayBuffer));
      }
    };
    socket.onerror = () => {
      setStatus("error");
      setErrorMessage("Connexion au conteneur interrompue.");
    };
    socket.onclose = (event) => {
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
      resizeObserver.disconnect();
      dataDisposable.dispose();
      socket.close();
      terminal.dispose();
    };
  }, [containerId]);

  return (
    <Modal open={open} onClose={onClose} labelledBy="container-console-title">
      {open && (
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
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Fermer
            </button>
          </div>
          <div className="container-console-modal__terminal" ref={terminalHostRef} />
          {errorMessage && <div className="error-banner container-console-modal__error">{errorMessage}</div>}
        </div>
      )}
    </Modal>
  );
}
