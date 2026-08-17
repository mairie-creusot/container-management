import { useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { fetchEnvironments } from "@/features/clusters/clustersSlice";
import { createRemoteEnvironment } from "@/features/remoteEnvironments/remoteEnvironmentsSlice";
import Modal from "@/components/Modal";
import type { RemoteDockerTransport } from "@/types";

/**
 * Modale de création d'un environnement Docker distant (TCP+TLS/SSH, identifiants/IP complets) —
 * EXTRAITE TELLE QUELLE d'EnvironmentsPage.tsx (Phase 2, 17/08/2026 : "Ajouter un environnement…"
 * depuis le menu du canevas de topologie doit ouvrir la VRAIE modale, jamais un formulaire
 * simplifié — et sans DUPLIQUER la modale, une seule source de vérité). Consommée par :
 *  - EnvironmentsPage.tsx (bouton "Nouvel environnement", comportement historique inchangé) ;
 *  - TopologyGraph.tsx#CreateSpotlight (entrée "Ajouter un environnement Docker distant…").
 * Les états/handlers du formulaire vivent ICI (plus dans la page) : chaque montage repart d'un
 * formulaire vierge, et la page ne garde que l'état d'ouverture. La modale d'ÉDITION, elle, reste
 * dans EnvironmentsPage.tsx (elle a besoin de la ligne du tableau/ses identifiants existants —
 * aucun autre appelant ne l'ouvre) mais partage les helpers TLS/SSH exportés ci-dessous.
 *
 * Création réservée admin côté API (routes gardées) — les appelants ne montent cette modale que
 * pour un admin (EnvironmentsPage masque déjà le bouton, CreateSpotlight masque l'entrée).
 */

/** État du bloc TLS partagé par le formulaire de création et celui d'édition — un objet vide
 * (`ca`/`cert`/`key` tous vides) avec `enabled: false` équivaut à "pas de TLS" ; `cert`/`key`
 * doivent être fournis ensemble (même règle que remoteDockerStore.ts#assertValidInput), vérifié
 * côté client pour un message d'erreur immédiat plutôt qu'un aller-retour serveur inutile.
 */
export interface RemoteTlsFormState {
  enabled: boolean;
  ca: string;
  cert: string;
  key: string;
}

export const EMPTY_TLS_FORM: RemoteTlsFormState = { enabled: false, ca: "", cert: "", key: "" };

/** true si le bloc TLS est dans un état soumissible (désactivé, ou cert+key fournis ensemble —
 * ca seul ou cert/key dépareillés bloquent la soumission côté client, en miroir de
 * remoteDockerStore.ts#assertValidInput côté serveur). */
export function isTlsFormValid(tls: RemoteTlsFormState): boolean {
  if (!tls.enabled) return true;
  const hasCert = tls.cert.trim().length > 0;
  const hasKey = tls.key.trim().length > 0;
  return hasCert === hasKey;
}

/** État du bloc SSH (transport "ssh" — VPS/hôte joignable uniquement par SSH, aucun port Docker
 * exposé, voir remoteDockerStore.ts en-tête). `authMethod` est un choix EXCLUSIF côté formulaire
 * (mot de passe OU clé privée) — le store accepte les deux en théorie mais un seul à la fois
 * garde le formulaire lisible ; l'autre champ est toujours vidé au changement de méthode. */
export interface RemoteSshFormState {
  username: string;
  authMethod: "password" | "privateKey";
  password: string;
  privateKey: string;
}

export const EMPTY_SSH_FORM: RemoteSshFormState = { username: "", authMethod: "password", password: "", privateKey: "" };

/** miroir de remoteDockerStore.ts#assertValidInput pour transport "ssh" : username requis, ET
 * (password OU privateKey) requis pour la méthode choisie. */
export function isSshFormValid(ssh: RemoteSshFormState): boolean {
  if (!ssh.username.trim()) return false;
  return ssh.authMethod === "password" ? ssh.password.trim().length > 0 : ssh.privateKey.trim().length > 0;
}

export const DEFAULT_PORT_BY_TRANSPORT: Record<RemoteDockerTransport, string> = { "tcp-tls": "2376", ssh: "22" };

interface RemoteEnvironmentCreateModalProps {
  open: boolean;
  onClose: () => void;
}

export default function RemoteEnvironmentCreateModal({ open, onClose }: RemoteEnvironmentCreateModalProps) {
  const dispatch = useAppDispatch();
  const creatingRemote = useAppSelector((s) => s.remoteEnvironments.creating);
  const [remoteForm, setRemoteForm] = useState({ name: "", host: "", port: "2376" });
  const [remoteTransport, setRemoteTransport] = useState<RemoteDockerTransport>("tcp-tls");
  const [remoteTlsForm, setRemoteTlsForm] = useState<RemoteTlsFormState>(EMPTY_TLS_FORM);
  const [remoteSshForm, setRemoteSshForm] = useState<RemoteSshFormState>(EMPTY_SSH_FORM);
  const [remoteCreateError, setRemoteCreateError] = useState<string | null>(null);

  /** Changement de transport dans le formulaire de création : ne réajuste le port au défaut du
   * nouveau transport QUE s'il portait encore le défaut de l'ANCIEN transport — un port saisi à la
   * main par l'utilisateur n'est jamais écrasé silencieusement. */
  function handleRemoteTransportChange(next: RemoteDockerTransport) {
    setRemoteTransport(next);
    setRemoteForm((f) =>
      f.port === DEFAULT_PORT_BY_TRANSPORT[remoteTransport] ? { ...f, port: DEFAULT_PORT_BY_TRANSPORT[next] } : f,
    );
  }

  function resetAndClose() {
    setRemoteForm({ name: "", host: "", port: "2376" });
    setRemoteTransport("tcp-tls");
    setRemoteTlsForm(EMPTY_TLS_FORM);
    setRemoteSshForm(EMPTY_SSH_FORM);
    setRemoteCreateError(null);
    onClose();
  }

  function handleCreateRemote(event: FormEvent) {
    event.preventDefault();
    const name = remoteForm.name.trim();
    const host = remoteForm.host.trim();
    const port = Number(remoteForm.port);
    if (!name || !host || !Number.isInteger(port) || port < 1 || port > 65535) return;
    if (remoteTransport === "tcp-tls" && !isTlsFormValid(remoteTlsForm)) return;
    if (remoteTransport === "ssh" && !isSshFormValid(remoteSshForm)) return;
    setRemoteCreateError(null);

    let payload: Parameters<typeof createRemoteEnvironment>[0];
    if (remoteTransport === "ssh") {
      const username = remoteSshForm.username.trim();
      const password = remoteSshForm.authMethod === "password" ? remoteSshForm.password.trim() : "";
      const privateKey = remoteSshForm.authMethod === "privateKey" ? remoteSshForm.privateKey.trim() : "";
      payload = {
        name,
        host,
        port,
        transport: "ssh",
        ssh: { username, ...(password ? { password } : {}), ...(privateKey ? { privateKey } : {}) },
      };
    } else {
      const ca = remoteTlsForm.ca.trim();
      const cert = remoteTlsForm.cert.trim();
      const key = remoteTlsForm.key.trim();
      const tls =
        remoteTlsForm.enabled && (ca || cert || key)
          ? { ...(ca ? { ca } : {}), ...(cert ? { cert } : {}), ...(key ? { key } : {}) }
          : undefined;
      payload = { name, host, port, transport: "tcp-tls", ...(tls ? { tls } : {}) };
    }

    dispatch(createRemoteEnvironment(payload)).then((action) => {
      if (createRemoteEnvironment.fulfilled.match(action)) {
        // Cet environnement devient sélectionnable dans le sélecteur du Topbar dès le prochain
        // rechargement de GET /api/environments (voir services/environments.ts#getRemoteDockerEnvironments).
        dispatch(fetchEnvironments());
        resetAndClose();
      } else {
        setRemoteCreateError(action.payload ?? "Impossible de créer cet environnement.");
      }
    });
  }

  return (
    <Modal open={open} onClose={resetAndClose} labelledBy="remote-env-create-title">
      <form className="confirm-dialog" onSubmit={handleCreateRemote}>
        <h2 id="remote-env-create-title" className="confirm-dialog__title">
          Nouvel environnement Docker distant
        </h2>
        <div className="field">
          <label htmlFor="remote-env-name">Nom</label>
          <input
            id="remote-env-name"
            value={remoteForm.name}
            onChange={(event) => setRemoteForm((f) => ({ ...f, name: event.target.value }))}
            placeholder="ex : Datacenter secours"
            disabled={creatingRemote}
            autoFocus
            required
          />
        </div>
        <div className="field">
          <label htmlFor="remote-env-host">Hôte</label>
          <input
            id="remote-env-host"
            value={remoteForm.host}
            onChange={(event) => setRemoteForm((f) => ({ ...f, host: event.target.value }))}
            placeholder="ex : docker-secours.lecreusot.priv"
            disabled={creatingRemote}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="remote-env-transport">Transport</label>
          <select
            id="remote-env-transport"
            className="topbar__env-select"
            value={remoteTransport}
            onChange={(event) => handleRemoteTransportChange(event.target.value as RemoteDockerTransport)}
            disabled={creatingRemote}
          >
            <option value="tcp-tls">TCP+TLS — démon Docker exposé sur le réseau</option>
            <option value="ssh">SSH — hôte joignable uniquement en SSH (ex : VPS)</option>
          </select>
          <p className="create-container-hint">
            {remoteTransport === "ssh"
              ? "Aucun port Docker exposé : QUAI se connecte au port SSH déjà ouvert pour l'administration de la machine, puis tunnelise Docker au travers."
              : "Le démon Docker distant expose directement son API TCP (voir docs.docker.com/engine/security/protect-access)."}
          </p>
        </div>
        <div className="field">
          <label htmlFor="remote-env-port">Port {remoteTransport === "ssh" ? "SSH" : "Docker"}</label>
          <input
            id="remote-env-port"
            type="number"
            min={1}
            max={65535}
            value={remoteForm.port}
            onChange={(event) => setRemoteForm((f) => ({ ...f, port: event.target.value }))}
            disabled={creatingRemote}
            required
          />
        </div>

        {remoteTransport === "tcp-tls" && (
          <>
            <label className="filter-toggle">
              <input
                type="checkbox"
                checked={remoteTlsForm.enabled}
                onChange={(event) =>
                  setRemoteTlsForm((f) => ({ ...f, enabled: event.target.checked }))
                }
                disabled={creatingRemote}
              />
              Activer TLS (démon exposé en TCP+TLS — recommandé)
            </label>
            {remoteTlsForm.enabled && (
              <>
                <div className="field">
                  <label htmlFor="remote-env-tls-ca">Certificat CA (PEM)</label>
                  <textarea
                    id="remote-env-tls-ca"
                    rows={3}
                    value={remoteTlsForm.ca}
                    onChange={(event) => setRemoteTlsForm((f) => ({ ...f, ca: event.target.value }))}
                    placeholder="-----BEGIN CERTIFICATE-----&#10;… (optionnel)"
                    disabled={creatingRemote}
                  />
                </div>
                <div className="field">
                  <label htmlFor="remote-env-tls-cert">Certificat client (PEM)</label>
                  <textarea
                    id="remote-env-tls-cert"
                    rows={3}
                    value={remoteTlsForm.cert}
                    onChange={(event) => setRemoteTlsForm((f) => ({ ...f, cert: event.target.value }))}
                    placeholder="-----BEGIN CERTIFICATE-----&#10;…"
                    disabled={creatingRemote}
                  />
                </div>
                <div className="field">
                  <label htmlFor="remote-env-tls-key">Clé privée client (PEM)</label>
                  <textarea
                    id="remote-env-tls-key"
                    rows={3}
                    value={remoteTlsForm.key}
                    onChange={(event) => setRemoteTlsForm((f) => ({ ...f, key: event.target.value }))}
                    placeholder="-----BEGIN PRIVATE KEY-----&#10;…"
                    disabled={creatingRemote}
                  />
                </div>
                {!isTlsFormValid(remoteTlsForm) && (
                  <p className="graph-popover__error">Certificat et clé doivent être fournis ensemble.</p>
                )}
                <p style={{ margin: 0, fontSize: "0.85em", opacity: 0.75 }}>
                  Chiffrés au repos (AES-256-GCM) ; jamais relus ni réaffichés une fois enregistrés.
                </p>
              </>
            )}
          </>
        )}

        {remoteTransport === "ssh" && (
          <>
            <div className="field">
              <label htmlFor="remote-env-ssh-username">Utilisateur SSH</label>
              <input
                id="remote-env-ssh-username"
                value={remoteSshForm.username}
                onChange={(event) => setRemoteSshForm((f) => ({ ...f, username: event.target.value }))}
                placeholder="ex : deploy"
                disabled={creatingRemote}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="remote-env-ssh-auth-method">Authentification</label>
              <select
                id="remote-env-ssh-auth-method"
                className="topbar__env-select"
                value={remoteSshForm.authMethod}
                onChange={(event) =>
                  setRemoteSshForm((f) => ({ ...f, authMethod: event.target.value as "password" | "privateKey" }))
                }
                disabled={creatingRemote}
              >
                <option value="password">Mot de passe</option>
                <option value="privateKey">Clé privée</option>
              </select>
            </div>
            {remoteSshForm.authMethod === "password" ? (
              <div className="field">
                <label htmlFor="remote-env-ssh-password">Mot de passe SSH</label>
                <input
                  id="remote-env-ssh-password"
                  type="password"
                  value={remoteSshForm.password}
                  onChange={(event) => setRemoteSshForm((f) => ({ ...f, password: event.target.value }))}
                  autoComplete="new-password"
                  disabled={creatingRemote}
                  required
                />
              </div>
            ) : (
              <div className="field">
                <label htmlFor="remote-env-ssh-private-key">Clé privée SSH (PEM)</label>
                <textarea
                  id="remote-env-ssh-private-key"
                  rows={3}
                  value={remoteSshForm.privateKey}
                  onChange={(event) => setRemoteSshForm((f) => ({ ...f, privateKey: event.target.value }))}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;…"
                  disabled={creatingRemote}
                  required
                />
              </div>
            )}
            <p style={{ margin: 0, fontSize: "0.85em", opacity: 0.75 }}>
              Chiffrés au repos (AES-256-GCM) ; jamais relus ni réaffichés une fois enregistrés.
            </p>
          </>
        )}

        {remoteCreateError && <p className="graph-popover__error">{remoteCreateError}</p>}
        <div className="confirm-dialog__actions">
          <button type="button" className="btn btn-ghost" onClick={resetAndClose} disabled={creatingRemote}>
            Annuler
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={
              creatingRemote ||
              !remoteForm.name.trim() ||
              !remoteForm.host.trim() ||
              (remoteTransport === "tcp-tls" ? !isTlsFormValid(remoteTlsForm) : !isSshFormValid(remoteSshForm))
            }
          >
            {creatingRemote ? "Test et création…" : "Créer"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
