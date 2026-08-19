import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import Modal from "@/components/Modal";
import { apiGet, apiPost, ApiError } from "@/api/client";
import { pushNotification } from "@/features/notifications/notificationsSlice";
import { fetchTopology } from "@/features/topology/topologySlice";
import { fetchNutanixImages, fetchNutanixSubnets } from "@/features/nutanix/nutanixSlice";
import {
  VM_DEPLOY_DEFAULTS,
  isValidGuestAccount,
  isValidVmName,
  nutanixTaskOutcome,
  nutanixTaskPercent,
} from "@/features/templates/templateCatalog";
import { KIND_ICON } from "@/components/topologyGraphShared";
import type { NutanixTaskStatus, NutanixVmCreateInput } from "@/types";

const TASK_POLL_MS = 2000;

export interface DeployVmModalProps {
  /** Nom du template source — affichage uniquement. */
  templateName: string;
  /** Référence de l'artifact "nutanix-image" du dernier build (uuid ou nom d'image Prism) — utilisée
   * aussi pour un template base "iso" en installation AUTOMATISÉE (l'image a été construite). */
  artifactReference?: string;
  /** Base "iso" en installation MANUELLE uniquement : POST { isoImageUuid, diskSizeMib } sans
   * imageUuid ni guestCustomization (l'OS n'est pas installé — console VNC après création). */
  isoImageUuid?: string;
  onClose: () => void;
}

/** Réponse de POST /api/nutanix/vms — le contrat ne fige que le body : on lit le taskUuid sous ses
 * deux formes plausibles, et on reste honnête s'il manque (pas de suivi possible). */
interface CreateVmResponse {
  taskUuid?: string;
  task_uuid?: string;
}

/**
 * Modale "Déployer en VM" (objectif "prêt en 2 min") : pré-remplie depuis le template (image =
 * artifact du dernier build, défauts vCPU/RAM/disque raisonnables) — ne demande QUE le nom de la
 * VM/hostname, le compte à créer (username + mot de passe OU clé SSH) et le subnet réel. POST
 * /api/nutanix/vms puis suivi de tâche (GET /api/nutanix/tasks/:uuid) avec progression + toast.
 * Le mot de passe reste dans ce composant et le body du POST — jamais dans Redux/log/notification.
 */
export default function DeployVmModal({ templateName, artifactReference = "", isoImageUuid, onClose }: DeployVmModalProps) {
  const isoMode = typeof isoImageUuid === "string" && isoImageUuid !== "";
  const dispatch = useAppDispatch();
  const VmIcon = KIND_ICON["nutanix-vm"];
  const subnets = useAppSelector((s) => s.nutanix.subnets);
  const images = useAppSelector((s) => s.nutanix.images);
  const imagesStatus = useAppSelector((s) => s.nutanix.imagesStatus);

  const [vmName, setVmName] = useState("");
  const [username, setUsername] = useState("");
  const [authMethod, setAuthMethod] = useState<"password" | "ssh-key">("password");
  const [password, setPassword] = useState("");
  const [sshKey, setSshKey] = useState("");
  const [subnetUuid, setSubnetUuid] = useState("");
  const [imageUuid, setImageUuid] = useState("");
  // Ressources : défauts raisonnables, ajustables sans quitter la modale.
  const [showResources, setShowResources] = useState(false);
  const [numVcpus, setNumVcpus] = useState(String(VM_DEPLOY_DEFAULTS.numVcpus));
  const [memoryMib, setMemoryMib] = useState(String(VM_DEPLOY_DEFAULTS.memoryMib));
  const [diskGib, setDiskGib] = useState(String(VM_DEPLOY_DEFAULTS.diskSizeGib));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState<NutanixTaskStatus | null>(null);
  const taskRunningRef = useRef(false);

  useEffect(() => {
    dispatch(fetchNutanixSubnets());
    dispatch(fetchNutanixImages());
  }, [dispatch]);

  useEffect(() => {
    if (!subnetUuid && subnets.length > 0) setSubnetUuid(subnets[0]!.uuid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subnets.length]);

  // Résolution de l'artifact vers une image réelle du catalogue (uuid OU nom) — si introuvable,
  // l'utilisateur choisit manuellement dans la liste réelle plutôt qu'un uuid envoyé à l'aveugle.
  const matchedImage = images.find((i) => i.uuid === artifactReference || i.name === artifactReference) ?? null;
  useEffect(() => {
    if (!isoMode && matchedImage && !imageUuid) setImageUuid(matchedImage.uuid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedImage?.uuid]);

  // Mode ISO : l'ISO est fixé par le template, seul son nom est résolu depuis le catalogue.
  const isoImage = isoMode ? images.find((i) => i.uuid === isoImageUuid) ?? null : null;

  const trimmedName = vmName.trim();
  const nameValid = trimmedName.length === 0 || isValidVmName(trimmedName);
  const accountValid =
    isoMode || isValidGuestAccount(username.trim(), authMethod === "password" ? password : "", authMethod === "ssh-key" ? sshKey : "");
  const vcpus = Number(numVcpus);
  const memory = Number(memoryMib);
  const disk = Number(diskGib);
  const resourcesValid =
    Number.isInteger(vcpus) && vcpus >= 1 && vcpus <= 64 && Number.isInteger(memory) && memory >= 256 && Number.isInteger(disk) && disk >= 1;
  const canSubmit = trimmedName.length > 0 && nameValid && accountValid && !!subnetUuid && (isoMode || !!imageUuid) && resourcesValid;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || busy || task) return;
    setBusy(true);
    setError(null);
    // Mode ISO : { isoImageUuid, diskSizeMib } au lieu d'imageUuid, JAMAIS de guestCustomization
    // (l'OS n'est pas encore installé — installation manuelle via la console VNC).
    const body: NutanixVmCreateInput = isoMode
      ? {
          name: trimmedName,
          isoImageUuid: isoImageUuid as string,
          subnetUuid,
          numVcpus: vcpus,
          numCoresPerVcpu: VM_DEPLOY_DEFAULTS.numCoresPerVcpu,
          memoryMib: memory,
          diskSizeMib: disk * 1024,
        }
      : {
          name: trimmedName,
          imageUuid,
          subnetUuid,
          numVcpus: vcpus,
          numCoresPerVcpu: VM_DEPLOY_DEFAULTS.numCoresPerVcpu,
          memoryMib: memory,
          diskSizeMib: disk * 1024,
          guestCustomization: {
            hostname: trimmedName,
            username: username.trim(),
            ...(authMethod === "password" ? { password } : { sshAuthorizedKey: sshKey.trim() }),
          },
        };
    try {
      const response = await apiPost<CreateVmResponse>("/nutanix/vms", body);
      const taskUuid = response.taskUuid ?? response.task_uuid;
      if (!taskUuid) {
        // Pas de tâche à suivre : succès honnête sans progression, le poll de topologie fera le reste.
        dispatch(pushNotification({ level: "success", message: `Création de la VM « ${trimmedName} » lancée.` }));
        dispatch(fetchTopology());
        onClose();
        return;
      }
      setTask({ uuid: taskUuid, status: "RUNNING" });
      taskRunningRef.current = true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setError("Le backend de création de VM n'est pas encore disponible.");
      } else {
        setError(err instanceof ApiError ? err.message : "Échec de la création de la VM.");
      }
    } finally {
      setBusy(false);
    }
  }

  // Suivi de la tâche Prism — GET /api/nutanix/tasks/:uuid toutes les 2s jusqu'à SUCCEEDED/FAILED.
  useEffect(() => {
    if (!task || nutanixTaskOutcome(task) !== "running") return;
    const interval = setInterval(async () => {
      try {
        const next = await apiGet<NutanixTaskStatus>(`/nutanix/tasks/${task.uuid}`);
        setTask(next);
        const outcome = nutanixTaskOutcome(next);
        if (outcome === "succeeded") {
          taskRunningRef.current = false;
          dispatch(pushNotification({ level: "success", message: `VM « ${trimmedName} » créée et prête.` }));
          dispatch(fetchTopology());
          onClose();
        } else if (outcome === "failed") {
          taskRunningRef.current = false;
          dispatch(pushNotification({ level: "error", message: `Création de la VM « ${trimmedName} » en échec (statut Prism : ${next.status}).` }));
        }
      } catch {
        // Erreur de poll transitoire : on retentera au prochain tick, jamais conclu à tort.
      }
    }, TASK_POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.uuid, task?.status, task?.percentageComplete]);

  function handleClose() {
    if (taskRunningRef.current) {
      dispatch(
        pushNotification({ level: "info", message: `La création de « ${trimmedName} » continue côté Nutanix (tâche ${task?.uuid ?? "?"}).` }),
      );
    }
    onClose();
  }

  const taskOutcome = task ? nutanixTaskOutcome(task) : null;
  const percent = task ? nutanixTaskPercent(task) : 0;

  return (
    <Modal open onClose={handleClose} labelledBy="deploy-vm-title">
      <div className="template-modal">
        <div className="template-modal__head">
          <h3 id="deploy-vm-title">
            <VmIcon className="inline-icon" /> Déployer en VM — {templateName}
          </h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={handleClose}>
            Fermer
          </button>
        </div>

        {task ? (
          <div className="template-modal__body">
            <p className="template-modal__hint">
              {taskOutcome === "failed"
                ? `La tâche Prism a échoué (statut : ${task.status}).`
                : `Création de « ${trimmedName} » en cours sur le cluster…`}
            </p>
            <div
              className={`template-deploy-progress${taskOutcome === "failed" ? " template-deploy-progress--failed" : ""}`}
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="template-deploy-progress__bar" style={{ width: `${percent}%` }} />
            </div>
            <p className="template-modal__hint">
              {percent}% — tâche {task.uuid}
            </p>
            <div className="template-modal__actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={handleClose}>
                {taskOutcome === "failed" ? "Fermer" : "Fermer (la création continue)"}
              </button>
            </div>
          </div>
        ) : (
          <form className="template-modal__body" onSubmit={handleSubmit}>
            {isoMode ? (
              <div className="field">
                <label>ISO d'installation (base du template)</label>
                {isoImage ? (
                  <p className="template-modal__resolved cell-mono" title={isoImage.uuid}>
                    {isoImage.name}
                  </p>
                ) : (
                  <p className="template-modal__resolved cell-mono">{isoImageUuid}</p>
                )}
                <span className="template-modal__hint">
                  La VM démarrera sur cet ISO avec un disque système vide — l'installation de l'OS se fera à la main via la
                  console VNC après la création.
                </span>
              </div>
            ) : (
            <div className="field">
              <label>Image (artifact du dernier build)</label>
              {imagesStatus === "unavailable" && (
                <p className="template-modal__hint">
                  Le catalogue d'images Nutanix n'est pas encore disponible côté API (backend en cours) — impossible de résoudre
                  l'artifact « {artifactReference} » pour l'instant.
                </p>
              )}
              {imagesStatus === "ready" && matchedImage && imageUuid === matchedImage.uuid ? (
                <p className="template-modal__resolved cell-mono" title={matchedImage.uuid}>
                  {matchedImage.name}
                </p>
              ) : imagesStatus === "ready" ? (
                <>
                  {images.length === 0 ? (
                    <p className="template-modal__hint">Aucune image dans le catalogue Prism Central.</p>
                  ) : (
                    <>
                      <select value={imageUuid} onChange={(e) => setImageUuid(e.target.value)} disabled={busy} required>
                        <option value="">— sélectionner —</option>
                        {images.map((i) => (
                          <option key={i.uuid} value={i.uuid}>
                            {i.name}
                          </option>
                        ))}
                      </select>
                      <span className="template-modal__hint">
                        L'artifact « {artifactReference} » n'a pas été retrouvé tel quel dans le catalogue — choisissez l'image
                        correspondante.
                      </span>
                    </>
                  )}
                </>
              ) : imagesStatus === "error" ? (
                <p className="graph-popover__error">Échec du chargement du catalogue d'images.</p>
              ) : (
                <p className="template-modal__hint">Chargement du catalogue d'images…</p>
              )}
            </div>
            )}

            <div className="field">
              <label htmlFor="deploy-vm-name">Nom de la VM / hostname</label>
              <input
                id="deploy-vm-name"
                type="text"
                autoFocus
                className="cell-mono"
                value={vmName}
                onChange={(e) => setVmName(e.target.value)}
                placeholder="ex : app-prod-01"
                disabled={busy}
                required
              />
              {!nameValid && (
                <span className="template-modal__field-error">
                  Lettres/chiffres/tirets uniquement (max 63), jamais de tiret en tête/queue.
                </span>
              )}
            </div>

            {isoMode && (
              <p className="template-modal__hint">
                Pas de compte ni de cloud-init à renseigner : l'OS n'est pas encore installé, tout se configurera pendant
                l'installation manuelle via la console VNC.
              </p>
            )}

            {!isoMode && (
              <>
            <div className="field">
              <label htmlFor="deploy-vm-username">Compte à créer — utilisateur</label>
              <input
                id="deploy-vm-username"
                type="text"
                className="cell-mono"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="ex : admin"
                autoComplete="off"
                disabled={busy}
                required
              />
              <span className="template-modal__hint">
                Créé au premier démarrage via cloud-init — il s'ajoute aux comptes définis dans la recette du template.
              </span>
            </div>

            <div className="field">
              <label htmlFor="deploy-vm-auth">Authentification</label>
              <select
                id="deploy-vm-auth"
                value={authMethod}
                onChange={(e) => setAuthMethod(e.target.value as "password" | "ssh-key")}
                disabled={busy}
              >
                <option value="password">Mot de passe</option>
                <option value="ssh-key">Clé SSH publique</option>
              </select>
            </div>

            {authMethod === "password" && (
              <div className="field">
                <label htmlFor="deploy-vm-password">Mot de passe</label>
                <input
                  id="deploy-vm-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  disabled={busy}
                  required
                />
                <span className="template-modal__hint">Transmis uniquement à l'API pour la création — jamais stocké ni affiché.</span>
              </div>
            )}
            {authMethod === "ssh-key" && (
              <div className="field">
                <label htmlFor="deploy-vm-sshkey">Clé SSH publique autorisée</label>
                <textarea
                  id="deploy-vm-sshkey"
                  className="iac-editor"
                  style={{ minHeight: 60 }}
                  value={sshKey}
                  onChange={(e) => setSshKey(e.target.value)}
                  placeholder="ssh-ed25519 AAAA… user@poste"
                  spellCheck={false}
                  disabled={busy}
                  required
                />
              </div>
            )}
              </>
            )}

            <div className="field">
              <label htmlFor="deploy-vm-subnet">Subnet / VLAN</label>
              {subnets.length === 0 ? (
                <p className="template-modal__hint">Aucun subnet Nutanix disponible (Prism Central injoignable, ou aucun subnet).</p>
              ) : (
                <select id="deploy-vm-subnet" value={subnetUuid} onChange={(e) => setSubnetUuid(e.target.value)} disabled={busy} required>
                  {subnets.map((s) => (
                    <option key={s.uuid} value={s.uuid}>
                      {s.name}
                      {s.vlanId !== undefined ? ` (VLAN ${s.vlanId})` : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {isoMode && (
              <div className="field">
                <label htmlFor="deploy-vm-disk-iso">Taille du disque système (Gio) — requis</label>
                <input
                  id="deploy-vm-disk-iso"
                  type="number"
                  min={1}
                  value={diskGib}
                  onChange={(e) => setDiskGib(e.target.value)}
                  disabled={busy}
                  required
                />
                <span className="template-modal__hint">Disque vide sur lequel l'OS sera installé depuis l'ISO.</span>
              </div>
            )}

            <div className="field">
              <button type="button" className="template-modal__resources-toggle" onClick={() => setShowResources((v) => !v)}>
                Ressources : {numVcpus} vCPU · {memoryMib} Mio RAM{isoMode ? "" : ` · disque ${diskGib} Gio`} —{" "}
                {showResources ? "replier" : "ajuster"}
              </button>
              {showResources && (
                <div className="template-modal__resources">
                  <label htmlFor="deploy-vm-vcpus">
                    vCPU
                    <input
                      id="deploy-vm-vcpus"
                      type="number"
                      min={1}
                      max={64}
                      value={numVcpus}
                      onChange={(e) => setNumVcpus(e.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <label htmlFor="deploy-vm-memory">
                    Mémoire (Mio)
                    <input
                      id="deploy-vm-memory"
                      type="number"
                      min={256}
                      value={memoryMib}
                      onChange={(e) => setMemoryMib(e.target.value)}
                      disabled={busy}
                    />
                  </label>
                  {!isoMode && (
                    <label htmlFor="deploy-vm-disk">
                      Disque (Gio)
                      <input
                        id="deploy-vm-disk"
                        type="number"
                        min={1}
                        value={diskGib}
                        onChange={(e) => setDiskGib(e.target.value)}
                        disabled={busy}
                      />
                    </label>
                  )}
                </div>
              )}
              {!resourcesValid && <span className="template-modal__field-error">Valeurs de ressources invalides.</span>}
            </div>

            {error && <p className="graph-popover__error">{error}</p>}

            <div className="template-modal__actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={handleClose} disabled={busy}>
                Annuler
              </button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !canSubmit}>
                {busy ? "Création…" : "Créer la VM"}
              </button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
