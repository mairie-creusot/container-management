import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import Modal from "@/components/Modal";
import { apiGet, wsUrl, ApiError } from "@/api/client";
import type { ContainerLogsSnapshot } from "@/types";

interface ContainerLogsProps {
  /** null = fermé (aucune connexion) ; sinon l'id du conteneur ciblé. */
  containerId: string | null;
  containerName: string;
  onClose: () => void;
}

type ConnectionStatus = "connecting" | "connected" | "closed" | "error";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "Connexion…",
  connected: "En direct",
  closed: "Flux terminé",
  error: "Erreur",
};

/** Nombre de lignes de logs conservées côté client pour le filtre de recherche — une garde
 * simple, pas une vraie fenêtre glissante : ce premier lot ne fait aucune indexation côté
 * serveur (voir mission), un tampon borné suffit à éviter une fuite mémoire sur un conteneur
 * très bavard laissé ouvert longtemps. */
const MAX_BUFFERED_LINES = 3000;
const INITIAL_TAIL = 200;

interface ContainerLogsBodyProps {
  containerId: string;
  containerName: string;
  /** Affiché seulement en contexte Modal (bouton "Fermer") — absent en usage inline
   * (TopologySubGraphPanel.tsx § onglet "Logs"), où la fermeture est déjà gérée par l'onglet
   * parent. */
  onClose?: () => void;
}

/**
 * Visualiseur de logs en direct (équivalent `docker logs -f`), même pattern xterm.js que
 * ContainerConsole.tsx — mais LECTURE SEULE (rien n'est jamais envoyé au serveur) et avec un
 * filtre de recherche texte simple appliqué côté client sur les lignes déjà reçues.
 *
 * Deux temps, comme documenté côté API (routes/containerLogs.ts) : un snapshot instantané
 * (GET /api/containers/:id/logs) affiché immédiatement, puis le flux WebSocket
 * (GET /api/containers/:id/logs/stream?tail=0 — 0 pour ne pas dupliquer les lignes du snapshot)
 * qui prend le relais pour les nouvelles lignes.
 *
 * Extrait du wrapper Modal (voir ContainerConsoleBody dans ContainerConsole.tsx pour le même
 * principe) : réutilisable inline dans TopologySubGraphPanel.tsx sans fenêtre superposée.
 */
export function ContainerLogsBody({ containerId, containerName, onClose }: ContainerLogsBodyProps) {
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  function appendLines(newLines: string[]) {
    if (newLines.length === 0) return;
    setLines((current) => {
      const merged = [...current, ...newLines];
      return merged.length > MAX_BUFFERED_LINES ? merged.slice(merged.length - MAX_BUFFERED_LINES) : merged;
    });
  }

  useEffect(() => {
    if (!containerId || !terminalHostRef.current) return;

    setStatus("connecting");
    setErrorMessage(null);
    setLines([]);

    const terminal = new Terminal({
      convertEol: true,
      disableStdin: true,
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      theme: { background: "#0a0e14", foreground: "#d4d9e0" },
      cursorBlink: false,
      cursorStyle: "bar",
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalHostRef.current);
    try {
      fitAddon.fit();
    } catch {
      // le conteneur DOM peut être à taille nulle au tout premier rendu du Modal (animation).
    }
    terminalRef.current = terminal;

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // idem ci-dessus : ignoré, un prochain resize corrigera l'affichage.
      }
    });
    resizeObserver.observe(terminalHostRef.current);

    // Même garde que ContainerConsole.tsx#ContainerConsoleBody (voir son commentaire détaillé) :
    // `cancelled` protège les handlers du WebSocket — un `socket.close()` déclenché par le
    // nettoyage (démontage/remontage, ex sous React.StrictMode en dev) appelle quand même
    // `onclose`/`onerror` de façon asynchrone, pouvant écraser à tort le statut d'une connexion
    // suivante déjà établie.
    let cancelled = false;
    const decoder = new TextDecoder();
    let partialLine = "";
    // Bug réel corrigé le 13/08/2026 (retour utilisateur : le statut restait bloqué sur
    // "Connexion…", jamais de logs affichés une fois imbriqué dans le sous-graphe d'un groupe) —
    // la socket s'ouvrait auparavant seulement APRÈS l'attente (`await`) du fetch du snapshot, ce
    // qui l'exposait à une fenêtre de course avec le double-montage React.StrictMode (l'instance
    // "jetable" du double-montage pouvait être démontée — `cancelled = true` — AVANT que son
    // `await` n'ait résolu, empêchant alors `openStream()` de jamais s'exécuter pour cette
    // instance ; un remontage supplémentaire avant la résolution du fetch reproduisait le même
    // blocage indéfiniment). ContainerConsole.tsx#ContainerConsoleBody n'a jamais ce problème
    // car sa socket s'ouvre de façon SYNCHRONE dès le début de l'effet — même principe appliqué
    // ici : la socket s'ouvre immédiatement, en PARALLÈLE du fetch du snapshot (plus après), les
    // deux se rejoignant sans jamais dépendre l'un de l'autre pour démarrer. Les lignes live
    // reçues avant que le snapshot n'ait fini de charger sont mises en attente (`pendingLiveLines`)
    // puis ajoutées à leur tour une fois le snapshot appliqué, pour ne jamais les afficher AVANT
    // l'historique qu'elles suivent chronologiquement.
    let snapshotApplied = false;
    let pendingLiveLines: string[] = [];

    function flushChunk(text: string) {
      partialLine += text;
      const parts = partialLine.split("\n");
      partialLine = parts.pop() ?? "";
      if (parts.length === 0) return;
      if (snapshotApplied) appendLines(parts);
      else pendingLiveLines.push(...parts);
    }

    // tail=0 : on ne veut ici QUE les nouvelles lignes écrites après l'ouverture du flux (voir
    // routes/containerLogs.ts#parseTail — "0" est accepté explicitement, contrairement à un
    // paramètre absent qui retomberait sur le tail par défaut et dupliquerait des lignes déjà
    // affichées par le snapshot ci-dessous) — l'historique récent reste entièrement à la charge
    // du snapshot, jamais du flux temps réel.
    const socket = new WebSocket(wsUrl(`/containers/${encodeURIComponent(containerId)}/logs/stream?tail=0`));
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      if (!cancelled) setStatus("connected");
    };
    socket.onmessage = (event) => {
      const text = typeof event.data === "string" ? event.data : decoder.decode(event.data as ArrayBuffer);
      flushChunk(text);
    };
    socket.onerror = () => {
      if (cancelled) return;
      setStatus("error");
      setErrorMessage("Connexion au flux de logs interrompue.");
    };
    socket.onclose = (event) => {
      if (cancelled) return; // fermeture volontaire par le nettoyage, voir le commentaire de tête d'effet
      setStatus((current) => (current === "error" ? current : "closed"));
      // Même remarque que ContainerConsole.tsx : un rejet avant l'upgrade (401, conteneur
      // introuvable...) n'expose pas de `reason` exploitable ici ; seul le cas "conteneur
      // introuvable/injoignable" (code 4404, voir routes/containerLogs.ts) porte un message
      // clair après un upgrade réussi.
      if (event.reason) setErrorMessage(event.reason);
    };

    // Snapshot instantané EN PARALLÈLE du flux ci-dessus (plus avant lui, voir commentaire de tête
    // d'effet) — premier affichage dès qu'il arrive, sans jamais bloquer l'ouverture du flux.
    void (async () => {
      try {
        const snapshot = await apiGet<ContainerLogsSnapshot>(
          `/containers/${encodeURIComponent(containerId)}/logs?tail=${INITIAL_TAIL}`,
        );
        if (cancelled) return;
        const initialLines = snapshot.logs.replace(/\n$/, "");
        if (initialLines.length > 0) appendLines(initialLines.split("\n"));
      } catch (err) {
        if (cancelled) return;
        setErrorMessage(err instanceof ApiError ? err.message : "Impossible de charger les logs récents.");
      } finally {
        if (!cancelled) {
          snapshotApplied = true;
          if (pendingLiveLines.length > 0) appendLines(pendingLiveLines);
          pendingLiveLines = [];
        }
      }
    })();

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      socket.close();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [containerId]);

  const filteredLines = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? lines.filter((line) => line.toLowerCase().includes(query)) : lines;
  }, [lines, search]);

  // Ré-écrit tout le contenu visible à chaque changement de tampon/filtre — simple et correct
  // pour ce premier lot (pas d'indexation serveur, voir mission), le tampon est borné
  // (MAX_BUFFERED_LINES) pour garder ce ré-affichage bon marché.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.clear();
    for (const line of filteredLines) terminal.writeln(line);
  }, [filteredLines]);

  return (
    <div className="container-console-modal">
      <div className="container-console-modal__header">
        <div>
          <div id="container-logs-title" className="container-console-modal__title">
            Logs — {containerName}
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

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <input
          type="text"
          placeholder="Rechercher dans les logs affichés…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1 }}
          aria-label="Rechercher dans les logs"
        />
        {search && (
          <span className="container-console-modal__subtitle">
            {filteredLines.length} / {lines.length} ligne(s)
          </span>
        )}
      </div>

      <div className="container-console-modal__terminal" ref={terminalHostRef} />
      {errorMessage && <div className="error-banner container-console-modal__error">{errorMessage}</div>}
    </div>
  );
}

/** Version Modal (ContainersPage.tsx) — inchangée pour ses appelants existants, délègue tout le
 * contenu réel à ContainerLogsBody ci-dessus. */
export default function ContainerLogs({ containerId, containerName, onClose }: ContainerLogsProps) {
  const open = containerId !== null;
  return (
    <Modal open={open} onClose={onClose} labelledBy="container-logs-title">
      {open && <ContainerLogsBody containerId={containerId} containerName={containerName} onClose={onClose} />}
    </Modal>
  );
}
