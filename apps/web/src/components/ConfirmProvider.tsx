import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import ConfirmDialog, { type ConfirmVariant } from "@/components/ConfirmDialog";

export interface ConfirmOptions {
  title: string;
  description?: string;
  /** Jamais « OK » générique — libellé explicite de l'action réelle. */
  confirmLabel: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingRequest {
  options: ConfirmOptions;
  resolve: (result: boolean) => void;
}

/**
 * Fournit `useConfirm()` à tout l'arbre sans prop-drilling : une seule boîte
 * de dialogue montée ici, pilotée par une promesse résolue au clic sur
 * confirmer/annuler. Remplace `window.confirm` partout dans l'app.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingRequest | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      setPending({ options, resolve });
    });
  }, []);

  function settle(result: boolean) {
    pending?.resolve(result);
    setPending(null);
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        title={pending?.options.title ?? ""}
        description={pending?.options.description}
        confirmLabel={pending?.options.confirmLabel ?? "Confirmer"}
        cancelLabel={pending?.options.cancelLabel ?? "Annuler"}
        variant={pending?.options.variant ?? "default"}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm() doit être utilisé sous <ConfirmProvider>.");
  }
  return ctx;
}
