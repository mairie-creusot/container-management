import { useEffect, useState } from "react";
import Modal from "@/components/Modal";

interface TypeToConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string | undefined;
  /**
   * Valeur EXACTE que l'utilisateur doit retaper pour activer le bouton de confirmation (ex: le
   * nom réel de la VM à supprimer) — confirmation "lourde" pour les actions les plus sensibles du
   * dépôt (mission : suppression d'une VRAIE VM Nutanix de production), au-delà du simple
   * `ConfirmDialog`/`useConfirm` (titre + description + un clic) déjà utilisé partout ailleurs
   * pour les autres suppressions (workspace IaC, cron job, sauvegarde, volume/network...). Même
   * squelette visuel que ConfirmDialog.tsx (Modal + classes `.confirm-dialog*`) — étendu d'un
   * champ texte, pas un mécanisme de confirmation réinventé de zéro.
   */
  expectedValue: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function TypeToConfirmDialog({
  open,
  title,
  description,
  expectedValue,
  confirmLabel,
  cancelLabel = "Annuler",
  onConfirm,
  onCancel,
}: TypeToConfirmDialogProps) {
  const [value, setValue] = useState("");
  // Réinitialise la saisie à CHAQUE ouverture — une confirmation refermée puis rouverte (ex:
  // l'utilisateur a annulé puis relance l'action) ne doit jamais réutiliser une saisie précédente.
  useEffect(() => {
    if (open) setValue("");
  }, [open]);

  const titleId = "type-to-confirm-dialog-title";
  const descriptionId = "type-to-confirm-dialog-description";
  const matches = value.length > 0 && value === expectedValue;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      dismissible={false}
      labelledBy={titleId}
      describedBy={description ? descriptionId : undefined}
    >
      <div className="confirm-dialog">
        <h2 id={titleId} className="confirm-dialog__title">
          {title}
        </h2>
        {description && (
          <p id={descriptionId} className="confirm-dialog__description">
            {description}
          </p>
        )}
        <div className="field">
          <label htmlFor="type-to-confirm-dialog-input">
            Tapez <strong>{expectedValue}</strong> pour confirmer
          </label>
          <input
            id="type-to-confirm-dialog-input"
            type="text"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches) onConfirm();
            }}
          />
        </div>
        <div className="confirm-dialog__actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={!matches}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
