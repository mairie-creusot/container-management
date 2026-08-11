import Modal from "@/components/Modal";

export type ConfirmVariant = "default" | "danger";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string | undefined;
  /** Jamais « OK » générique — libellé explicite de l'action réelle. */
  confirmLabel: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Annuler",
  variant = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = "confirm-dialog-title";
  const descriptionId = "confirm-dialog-description";

  return (
    <Modal
      open={open}
      onClose={onCancel}
      dismissible={variant !== "danger"}
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
        <div className="confirm-dialog__actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={variant === "danger" ? "btn btn-danger" : "btn btn-primary"}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
