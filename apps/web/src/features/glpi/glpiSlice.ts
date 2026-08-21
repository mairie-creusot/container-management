import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPut } from "@/api/client";
import type {
  GlpiAccount,
  GlpiAccountPage,
  GlpiBrowseScope,
  GlpiConfigFormInput,
  GlpiConfigStatus,
  GlpiCreateComputerOutcome,
  GlpiInventoryDiff,
  GlpiInventoryField,
  GlpiMyTickets,
  GlpiSearchOption,
  GlpiStatus,
  GlpiTestResult,
  GlpiTicketDetail,
  GlpiTicketPage,
  GlpiUpdateComputerOutcome,
} from "@/features/glpi/types";

type LoadStatus = "idle" | "loading" | "ready" | "error";

/** Lecture GLPI. Une 404 signifie "route absente de cette API" et doit produire un état
 * INDISPONIBLE honnête, jamais une page vide qui laisserait croire à une instance sans tickets.
 * Ces thunks se résolvent donc toujours : un rejet déclencherait en plus un toast à chaque
 * ouverture de page (errorNotificationMiddleware). */
export type GlpiFetchResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

/** Le 404 de GET /api/glpi/tickets/:id est un VERDICT (ticket inexistant ou utilisateur non
 * demandeur), pas une panne : il a son propre cas plutôt qu'un message d'erreur générique. */
export type GlpiTicketResult =
  | { kind: "ok"; data: GlpiTicketDetail }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

/** Le backend plafonne une page à 200 (GLPI_PAGE_LIMIT_MAX) : jamais « tout charger ». */
export const TICKETS_PAGE_SIZE = 50;
export const ACCOUNTS_PAGE_SIZE = 25;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

async function readOrDescribe<T>(
  path: string,
  fallback: string,
  normalize: (raw: unknown) => T,
): Promise<GlpiFetchResult<T>> {
  try {
    return { kind: "ok", data: normalize(await apiGet<unknown>(path)) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { kind: "unavailable" };
    return { kind: "error", message: errorMessage(error, fallback) };
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeStatus(raw: unknown): GlpiStatus {
  const wire = (raw ?? {}) as Partial<GlpiStatus>;
  return {
    configured: wire.configured === true,
    ...(typeof wire.reachable === "boolean" ? { reachable: wire.reachable } : {}),
    ...(wire.apiUrl ? { apiUrl: wire.apiUrl } : {}),
    ...(wire.authMode ? { authMode: wire.authMode } : {}),
    ...(wire.serviceAccount ? { serviceAccount: wire.serviceAccount } : {}),
    ...(wire.lastPoll?.at ? { lastPoll: { at: wire.lastPoll.at, reachable: wire.lastPoll.reachable === true } } : {}),
  };
}

function normalizeMyTickets(raw: unknown): GlpiMyTickets {
  const wire = (raw ?? {}) as Partial<GlpiMyTickets>;
  return {
    configured: wire.configured === true,
    ...(typeof wire.reachable === "boolean" ? { reachable: wire.reachable } : {}),
    ...(wire.account ? { account: wire.account } : {}),
    ...(typeof wire.candidateCount === "number" ? { candidateCount: wire.candidateCount } : {}),
    ...(wire.error ? { error: wire.error } : {}),
    tickets: asArray(wire.tickets),
  };
}

function normalizeAccountPage(raw: unknown): GlpiAccountPage {
  const wire = (raw ?? {}) as Partial<GlpiAccountPage>;
  return {
    users: asArray<GlpiAccount>(wire.users),
    offset: typeof wire.offset === "number" ? wire.offset : 0,
    limit: typeof wire.limit === "number" ? wire.limit : ACCOUNTS_PAGE_SIZE,
    ...(typeof wire.total === "number" ? { total: wire.total } : {}),
    ...(wire.error ? { error: wire.error } : {}),
  };
}

function normalizeTicketPage(raw: unknown): GlpiTicketPage {
  const wire = (raw ?? {}) as Partial<GlpiTicketPage>;
  return {
    scope: wire.scope === "all" ? "all" : "requester",
    ...(typeof wire.requesterId === "number" ? { requesterId: wire.requesterId } : {}),
    tickets: asArray(wire.tickets),
    offset: typeof wire.offset === "number" ? wire.offset : 0,
    limit: typeof wire.limit === "number" ? wire.limit : TICKETS_PAGE_SIZE,
    ...(typeof wire.total === "number" ? { total: wire.total } : {}),
    ...(wire.error ? { error: wire.error } : {}),
  };
}

function normalizeConfig(raw: unknown): GlpiConfigStatus {
  const wire = (raw ?? {}) as Partial<GlpiConfigStatus>;
  return {
    configured: wire.configured === true,
    ...(wire.config ? { config: wire.config } : {}),
  };
}

/** `GET /listSearchOptions/Ticket` renvoie un objet indexé par NUMÉRO d'option (plus une clé
 * "common" non numérique, écartée ici). */
function normalizeSearchOptions(raw: unknown): GlpiSearchOption[] {
  const wire = (raw ?? {}) as Record<string, unknown>;
  return Object.entries(wire)
    .filter(([key]) => /^\d+$/.test(key))
    .map(([option, value]) => {
      const row = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
      const text = (key: string): string | undefined => (typeof row[key] === "string" ? (row[key] as string) : undefined);
      return {
        option,
        ...(text("name") ? { name: text("name")! } : {}),
        ...(text("uid") ? { uid: text("uid")! } : {}),
        ...(text("table") ? { table: text("table")! } : {}),
        ...(text("field") ? { field: text("field")! } : {}),
      };
    })
    .sort((a, b) => Number(a.option) - Number(b.option));
}

const EMPTY_COUNTS: GlpiInventoryDiff["counts"] = {
  real: 0,
  glpiComputers: 0,
  matched: 0,
  inSync: 0,
  drifted: 0,
  missingInGlpi: 0,
  staleInGlpi: 0,
  ambiguous: 0,
  outOfScopeGlpi: 0,
};

function normalizeDiff(raw: unknown): GlpiInventoryDiff {
  const wire = (raw ?? {}) as Partial<GlpiInventoryDiff>;
  return {
    generatedAt: wire.generatedAt ?? "",
    glpi: wire.glpi ?? { configured: false, reachable: false, computerCount: 0 },
    nutanix: wire.nutanix ?? { configured: false, reachable: false, resourceCount: 0 },
    enrichment: wire.enrichment ?? { virtualMachines: "skipped", ipAddresses: "skipped", operatingSystems: "skipped" },
    counts: wire.counts ?? EMPTY_COUNTS,
    conclusive: wire.conclusive === true,
    missingInGlpi: asArray(wire.missingInGlpi),
    drifted: asArray(wire.drifted),
    inSync: asArray(wire.inSync),
    staleInGlpi: asArray(wire.staleInGlpi),
    ambiguous: asArray(wire.ambiguous),
    outOfScopeGlpiCount: wire.outOfScopeGlpiCount ?? 0,
  };
}

export interface GlpiState {
  status: GlpiStatus | null;
  statusLoad: LoadStatus;
  statusError: string | null;
  /** Routes GLPI absentes de cette API (404) — intégration pas déployée, distinct d'une erreur. */
  backendUnavailable: boolean;
  configured: boolean;

  myTickets: GlpiMyTickets | null;
  ticketsLoad: LoadStatus;
  ticketsError: string | null;

  selectedTicketId: number | null;
  ticket: GlpiTicketDetail | null;
  ticketLoad: LoadStatus;
  ticketError: string | null;
  ticketNotFound: boolean;
  followupSaving: boolean;
  followupError: string | null;

  /** `null` = « Mes tickets », le périmètre par défaut. Sinon on consulte quelqu'un d'autre. */
  browseScope: GlpiBrowseScope | null;
  browseAccount: GlpiAccount | null;
  browseOffset: number;
  browseTickets: GlpiTicketPage | null;
  browseLoad: LoadStatus;
  browseError: string | null;

  accountQuery: string;
  accounts: GlpiAccountPage | null;
  accountsLoad: LoadStatus;
  accountsError: string | null;

  inventory: GlpiInventoryDiff | null;
  inventoryLoad: LoadStatus;
  inventoryError: string | null;
  /** Clé de l'action d'inventaire en cours (`create:<resourceId>` / `align:<computerId>`). */
  inventoryActionKey: string | null;
  inventoryActionError: string | null;
  inventoryActionMessage: string | null;

  config: GlpiConfigStatus | null;
  configLoad: LoadStatus;
  configSaving: boolean;
  configError: string | null;
  clearing: boolean;
  testing: boolean;
  testResult: GlpiTestResult | null;

  searchOptions: GlpiSearchOption[] | null;
  searchOptionsLoading: boolean;
  searchOptionsError: string | null;
}

const initialState: GlpiState = {
  status: null,
  statusLoad: "idle",
  statusError: null,
  backendUnavailable: false,
  configured: false,

  myTickets: null,
  ticketsLoad: "idle",
  ticketsError: null,

  selectedTicketId: null,
  ticket: null,
  ticketLoad: "idle",
  ticketError: null,
  ticketNotFound: false,
  followupSaving: false,
  followupError: null,

  browseScope: null,
  browseAccount: null,
  browseOffset: 0,
  browseTickets: null,
  browseLoad: "idle",
  browseError: null,

  accountQuery: "",
  accounts: null,
  accountsLoad: "idle",
  accountsError: null,

  inventory: null,
  inventoryLoad: "idle",
  inventoryError: null,
  inventoryActionKey: null,
  inventoryActionError: null,
  inventoryActionMessage: null,

  config: null,
  configLoad: "idle",
  configSaving: false,
  configError: null,
  clearing: false,
  testing: false,
  testResult: null,

  searchOptions: null,
  searchOptionsLoading: false,
  searchOptionsError: null,
};

export const fetchGlpiStatus = createAsyncThunk<GlpiFetchResult<GlpiStatus>>("glpi/fetchStatus", async () =>
  readOrDescribe("/glpi/status", "Impossible de lire l'état de l'intégration GLPI.", normalizeStatus),
);

/** GET /api/glpi/my-tickets — un 502 porte le contrat complet (`reachable: false`) : on l'affiche
 * comme un verdict "injoignable" plutôt que comme une erreur anonyme. */
export const fetchGlpiMyTickets = createAsyncThunk<GlpiFetchResult<GlpiMyTickets>>("glpi/fetchMyTickets", async () => {
  try {
    return { kind: "ok", data: normalizeMyTickets(await apiGet<unknown>("/glpi/my-tickets")) };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404) return { kind: "unavailable" };
      const body = error.details;
      if (body && typeof body["configured"] === "boolean") {
        return { kind: "ok", data: normalizeMyTickets({ ...body, error: error.message }) };
      }
      return { kind: "error", message: error.message };
    }
    return { kind: "error", message: "Impossible de lire vos tickets GLPI." };
  }
});

/** `browse: true` passe par la route privilégiée (ticket d'un autre compte) — jamais par défaut. */
export const fetchGlpiTicket = createAsyncThunk<GlpiTicketResult, { id: number; browse?: boolean }>(
  "glpi/fetchTicket",
  async ({ id, browse }) => {
    const path = browse ? `/glpi/browse/tickets/${id}` : `/glpi/tickets/${id}`;
    try {
      const data = await apiGet<GlpiTicketDetail>(path);
      return { kind: "ok", data: { ...data, followups: asArray(data.followups) } };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { kind: "not-found" };
      return { kind: "error", message: errorMessage(error, `Impossible de lire le ticket ${id}.`) };
    }
  },
);

/** Recherche de comptes GLPI — LECTURE SEULE, réservée par le backend aux rôles operator/admin. */
export const fetchGlpiAccounts = createAsyncThunk<
  GlpiFetchResult<GlpiAccountPage>,
  { query: string; offset?: number; limit?: number }
>("glpi/fetchAccounts", async ({ query, offset = 0, limit = ACCOUNTS_PAGE_SIZE }) => {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (query.trim()) params.set("q", query.trim());
  return readOrDescribe(
    `/glpi/browse/accounts?${params.toString()}`,
    "Impossible de lire les comptes GLPI.",
    normalizeAccountPage,
  );
});

/** Tickets d'un compte donné (`requesterId`) ou de toute l'instance — même garde côté backend. */
export const fetchGlpiBrowseTickets = createAsyncThunk<
  GlpiFetchResult<GlpiTicketPage>,
  { requesterId?: number; offset?: number; limit?: number }
>("glpi/fetchBrowseTickets", async ({ requesterId, offset = 0, limit = TICKETS_PAGE_SIZE }) => {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (requesterId !== undefined) params.set("requesterId", String(requesterId));
  try {
    return { kind: "ok", data: normalizeTicketPage(await apiGet<unknown>(`/glpi/browse/tickets?${params.toString()}`)) };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404) return { kind: "unavailable" };
      // Un 502 porte le contrat complet : « GLPI injoignable » est un verdict, pas une erreur muette.
      const body = error.details;
      if (body && typeof body["configured"] === "boolean") {
        return { kind: "ok", data: normalizeTicketPage({ ...body, error: error.message }) };
      }
      return { kind: "error", message: error.message };
    }
    return { kind: "error", message: "Impossible de lire ces tickets GLPI." };
  }
});

export const addGlpiFollowup = createAsyncThunk<number, { ticketId: number; content: string }, { rejectValue: string }>(
  "glpi/addFollowup",
  async ({ ticketId, content }, { rejectWithValue }) => {
    try {
      const created = await apiPost<{ id: number }>(`/glpi/tickets/${ticketId}/followup`, { content });
      return created.id;
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Impossible d'ajouter ce commentaire au ticket."));
    }
  },
);

export const fetchGlpiInventoryDiff = createAsyncThunk<GlpiFetchResult<GlpiInventoryDiff>>(
  "glpi/fetchInventoryDiff",
  async () => readOrDescribe("/glpi/inventory/diff", "Impossible de lire l'écart d'inventaire.", normalizeDiff),
);

export const createGlpiComputer = createAsyncThunk<GlpiCreateComputerOutcome, string, { rejectValue: string }>(
  "glpi/createComputer",
  async (resourceId, { rejectWithValue }) => {
    try {
      return await apiPost<GlpiCreateComputerOutcome>("/glpi/inventory/computers", { resourceId });
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Impossible de créer la fiche GLPI."));
    }
  },
);

export const alignGlpiComputer = createAsyncThunk<
  GlpiUpdateComputerOutcome,
  { computerId: number; resourceId: string; fields?: GlpiInventoryField[] },
  { rejectValue: string }
>("glpi/alignComputer", async ({ computerId, resourceId, fields }, { rejectWithValue }) => {
  try {
    return await apiPatch<GlpiUpdateComputerOutcome>(`/glpi/inventory/computers/${computerId}`, {
      resourceId,
      ...(fields?.length ? { fields } : {}),
    });
  } catch (error) {
    return rejectWithValue(errorMessage(error, "Impossible d'aligner la fiche GLPI sur le réel."));
  }
});

export const fetchGlpiConfig = createAsyncThunk<GlpiFetchResult<GlpiConfigStatus>>("glpi/fetchConfig", async () =>
  readOrDescribe("/glpi/config", "Impossible de lire la configuration GLPI.", normalizeConfig),
);

/** PUT /api/glpi/config — le serveur ouvre RÉELLEMENT une session GLPI avant de persister. */
export const saveGlpiConfig = createAsyncThunk<GlpiConfigStatus, GlpiConfigFormInput, { rejectValue: string }>(
  "glpi/saveConfig",
  async (input, { rejectWithValue }) => {
    try {
      return normalizeConfig(await apiPut<unknown>("/glpi/config", input));
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Impossible d'enregistrer la configuration GLPI."));
    }
  },
);

/** POST /api/glpi/config/test — teste une config candidate SANS la persister. */
export const testGlpiConfig = createAsyncThunk<GlpiTestResult, GlpiConfigFormInput, { rejectValue: string }>(
  "glpi/testConfig",
  async (input, { rejectWithValue }) => {
    try {
      return await apiPost<GlpiTestResult>("/glpi/config/test", input);
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Impossible de tester la connexion à GLPI."));
    }
  },
);

export const disableGlpi = createAsyncThunk<void, void, { rejectValue: string }>(
  "glpi/disable",
  async (_arg, { rejectWithValue }) => {
    try {
      await apiDelete<{ ok: boolean }>("/glpi/config");
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Impossible de retirer la configuration GLPI."));
    }
  },
);

export const fetchGlpiSearchOptions = createAsyncThunk<GlpiFetchResult<GlpiSearchOption[]>>(
  "glpi/fetchSearchOptions",
  async () =>
    readOrDescribe(
      "/glpi/search-options",
      "Impossible de lire les options de recherche de cette instance GLPI.",
      normalizeSearchOptions,
    ),
);

const glpiSlice = createSlice({
  name: "glpi",
  initialState,
  reducers: {
    selectGlpiTicket(state, action: PayloadAction<number | null>) {
      state.selectedTicketId = action.payload;
      state.ticket = null;
      state.ticketError = null;
      state.ticketNotFound = false;
      state.followupError = null;
      state.ticketLoad = action.payload === null ? "idle" : "loading";
    },
    /** Bascule le périmètre consulté. `null` = « Mes tickets » : la liste d'autrui est jetée. */
    setGlpiBrowseTarget(state, action: PayloadAction<{ scope: GlpiBrowseScope; account?: GlpiAccount } | null>) {
      state.browseScope = action.payload?.scope ?? null;
      state.browseAccount = action.payload?.account ?? null;
      state.browseOffset = 0;
      state.browseTickets = null;
      state.browseError = null;
      // « Un compte GLPI » sans compte encore choisi n'interroge rien : on attend la sélection.
      state.browseLoad = action.payload?.scope === "all" || action.payload?.account ? "loading" : "idle";
      state.selectedTicketId = null;
      state.ticket = null;
      state.ticketLoad = "idle";
      state.ticketError = null;
      state.ticketNotFound = false;
    },
    setGlpiBrowseOffset(state, action: PayloadAction<number>) {
      state.browseOffset = Math.max(0, action.payload);
    },
    setGlpiAccountQuery(state, action: PayloadAction<string>) {
      state.accountQuery = action.payload;
    },
    clearGlpiTestResult(state) {
      state.testResult = null;
    },
    clearGlpiInventoryFeedback(state) {
      state.inventoryActionError = null;
      state.inventoryActionMessage = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchGlpiStatus.pending, (state) => {
        state.statusLoad = "loading";
      })
      .addCase(fetchGlpiStatus.fulfilled, (state, action) => {
        const result = action.payload;
        if (result.kind === "ok") {
          state.statusLoad = "ready";
          state.statusError = null;
          state.backendUnavailable = false;
          state.status = result.data;
          state.configured = result.data.configured;
          return;
        }
        state.statusLoad = "error";
        state.status = null;
        state.backendUnavailable = result.kind === "unavailable";
        state.statusError = result.kind === "error" ? result.message : null;
      })
      .addCase(fetchGlpiStatus.rejected, (state, action) => {
        state.statusLoad = "error";
        state.statusError = action.error.message ?? "Impossible de lire l'état de l'intégration GLPI.";
      })

      .addCase(fetchGlpiMyTickets.pending, (state) => {
        state.ticketsLoad = "loading";
      })
      .addCase(fetchGlpiMyTickets.fulfilled, (state, action) => {
        const result = action.payload;
        if (result.kind === "ok") {
          state.ticketsLoad = "ready";
          state.ticketsError = null;
          state.myTickets = result.data;
          return;
        }
        state.ticketsLoad = "error";
        state.myTickets = null;
        if (result.kind === "unavailable") state.backendUnavailable = true;
        state.ticketsError = result.kind === "error" ? result.message : null;
      })
      .addCase(fetchGlpiMyTickets.rejected, (state, action) => {
        state.ticketsLoad = "error";
        state.ticketsError = action.error.message ?? "Impossible de lire vos tickets GLPI.";
      })

      .addCase(fetchGlpiTicket.pending, (state, action) => {
        state.ticketLoad = "loading";
        state.selectedTicketId = action.meta.arg.id;
        state.ticketError = null;
        state.ticketNotFound = false;
      })
      .addCase(fetchGlpiTicket.fulfilled, (state, action) => {
        const result = action.payload;
        if (result.kind === "ok") {
          state.ticketLoad = "ready";
          state.ticket = result.data;
          state.ticketError = null;
          state.ticketNotFound = false;
          return;
        }
        state.ticketLoad = "error";
        state.ticket = null;
        state.ticketNotFound = result.kind === "not-found";
        state.ticketError = result.kind === "error" ? result.message : null;
      })
      .addCase(fetchGlpiTicket.rejected, (state, action) => {
        state.ticketLoad = "error";
        state.ticketError = action.error.message ?? "Impossible de lire ce ticket.";
      })

      .addCase(addGlpiFollowup.pending, (state) => {
        state.followupSaving = true;
        state.followupError = null;
      })
      .addCase(addGlpiFollowup.fulfilled, (state) => {
        state.followupSaving = false;
      })
      .addCase(addGlpiFollowup.rejected, (state, action) => {
        state.followupSaving = false;
        state.followupError = action.payload ?? "Impossible d'ajouter ce commentaire au ticket.";
      })

      .addCase(fetchGlpiAccounts.pending, (state) => {
        state.accountsLoad = "loading";
        state.accountsError = null;
      })
      .addCase(fetchGlpiAccounts.fulfilled, (state, action) => {
        const result = action.payload;
        if (result.kind === "ok") {
          state.accountsLoad = "ready";
          state.accounts = result.data;
          state.accountsError = null;
          return;
        }
        state.accountsLoad = "error";
        state.accounts = null;
        state.accountsError =
          result.kind === "unavailable"
            ? "Cette API QUAI n'expose pas la recherche de comptes GLPI."
            : result.message;
      })
      .addCase(fetchGlpiAccounts.rejected, (state, action) => {
        state.accountsLoad = "error";
        state.accountsError = action.error.message ?? "Impossible de lire les comptes GLPI.";
      })

      .addCase(fetchGlpiBrowseTickets.pending, (state) => {
        state.browseLoad = "loading";
        state.browseError = null;
      })
      .addCase(fetchGlpiBrowseTickets.fulfilled, (state, action) => {
        const result = action.payload;
        if (result.kind === "ok") {
          state.browseLoad = "ready";
          state.browseTickets = result.data;
          state.browseError = null;
          return;
        }
        state.browseLoad = "error";
        state.browseTickets = null;
        if (result.kind === "unavailable") state.backendUnavailable = true;
        state.browseError = result.kind === "error" ? result.message : null;
      })
      .addCase(fetchGlpiBrowseTickets.rejected, (state, action) => {
        state.browseLoad = "error";
        state.browseError = action.error.message ?? "Impossible de lire ces tickets GLPI.";
      })

      .addCase(fetchGlpiInventoryDiff.pending, (state) => {
        state.inventoryLoad = "loading";
      })
      .addCase(fetchGlpiInventoryDiff.fulfilled, (state, action) => {
        const result = action.payload;
        if (result.kind === "ok") {
          state.inventoryLoad = "ready";
          state.inventoryError = null;
          state.inventory = result.data;
          return;
        }
        state.inventoryLoad = "error";
        state.inventory = null;
        if (result.kind === "unavailable") state.backendUnavailable = true;
        state.inventoryError = result.kind === "error" ? result.message : null;
      })
      .addCase(fetchGlpiInventoryDiff.rejected, (state, action) => {
        state.inventoryLoad = "error";
        state.inventoryError = action.error.message ?? "Impossible de lire l'écart d'inventaire.";
      })

      .addCase(createGlpiComputer.pending, (state, action) => {
        state.inventoryActionKey = `create:${action.meta.arg}`;
        state.inventoryActionError = null;
        state.inventoryActionMessage = null;
      })
      .addCase(createGlpiComputer.fulfilled, (state, action) => {
        state.inventoryActionKey = null;
        state.inventoryActionMessage = `Fiche GLPI #${action.payload.computerId} créée pour « ${action.payload.resource.name} ».`;
        // L'écart affiché date d'avant l'écriture — la page relance la réconciliation.
        state.inventoryLoad = "idle";
      })
      .addCase(createGlpiComputer.rejected, (state, action) => {
        state.inventoryActionKey = null;
        state.inventoryActionError = action.payload ?? "Impossible de créer la fiche GLPI.";
      })

      .addCase(alignGlpiComputer.pending, (state, action) => {
        state.inventoryActionKey = `align:${action.meta.arg.computerId}`;
        state.inventoryActionError = null;
        state.inventoryActionMessage = null;
      })
      .addCase(alignGlpiComputer.fulfilled, (state, action) => {
        state.inventoryActionKey = null;
        const applied = action.payload.appliedFields.join(", ");
        state.inventoryActionMessage = `Fiche GLPI #${action.payload.computerId} alignée sur le réel${applied ? ` (${applied})` : ""}.`;
        state.inventoryLoad = "idle";
      })
      .addCase(alignGlpiComputer.rejected, (state, action) => {
        state.inventoryActionKey = null;
        state.inventoryActionError = action.payload ?? "Impossible d'aligner la fiche GLPI sur le réel.";
      })

      .addCase(fetchGlpiConfig.pending, (state) => {
        state.configLoad = "loading";
      })
      .addCase(fetchGlpiConfig.fulfilled, (state, action) => {
        const result = action.payload;
        if (result.kind === "ok") {
          state.configLoad = "ready";
          state.config = result.data;
          state.configured = result.data.configured;
          return;
        }
        state.configLoad = "error";
        state.config = null;
        if (result.kind === "unavailable") state.backendUnavailable = true;
      })
      .addCase(fetchGlpiConfig.rejected, (state) => {
        state.configLoad = "error";
      })

      .addCase(saveGlpiConfig.pending, (state) => {
        state.configSaving = true;
        state.configError = null;
      })
      .addCase(saveGlpiConfig.fulfilled, (state, action) => {
        state.configSaving = false;
        state.configLoad = "ready";
        state.config = action.payload;
        state.configured = action.payload.configured;
        state.backendUnavailable = false;
        // Tickets, inventaire et état venaient de l'ancienne configuration : tout est rejoué.
        state.statusLoad = "idle";
        state.ticketsLoad = "idle";
        state.inventoryLoad = "idle";
        state.searchOptions = null;
        state.browseScope = null;
        state.browseAccount = null;
        state.browseTickets = null;
        state.browseLoad = "idle";
        state.accounts = null;
        state.accountsLoad = "idle";
      })
      .addCase(saveGlpiConfig.rejected, (state, action) => {
        state.configSaving = false;
        state.configError = action.payload ?? "Impossible d'enregistrer la configuration GLPI.";
      })

      .addCase(testGlpiConfig.pending, (state) => {
        state.testing = true;
        state.testResult = null;
      })
      .addCase(testGlpiConfig.fulfilled, (state, action) => {
        state.testing = false;
        state.testResult = action.payload;
      })
      .addCase(testGlpiConfig.rejected, (state, action) => {
        state.testing = false;
        state.testResult = { ok: false, message: action.payload ?? "Impossible de tester la connexion à GLPI." };
      })

      .addCase(disableGlpi.pending, (state) => {
        state.clearing = true;
      })
      .addCase(disableGlpi.fulfilled, (state) => {
        state.clearing = false;
        state.configured = false;
        state.config = { configured: false };
        state.status = { configured: false };
        state.statusLoad = "ready";
        state.statusError = null;
        state.testResult = null;
        state.myTickets = { configured: false, tickets: [] };
        state.ticketsLoad = "ready";
        state.ticket = null;
        state.selectedTicketId = null;
        state.browseScope = null;
        state.browseAccount = null;
        state.browseTickets = null;
        state.browseLoad = "idle";
        state.accounts = null;
        state.accountsLoad = "idle";
        state.inventory = null;
        state.inventoryLoad = "idle";
        state.searchOptions = null;
      })
      .addCase(disableGlpi.rejected, (state, action) => {
        state.clearing = false;
        state.configError = action.payload ?? "Impossible de retirer la configuration GLPI.";
      })

      .addCase(fetchGlpiSearchOptions.pending, (state) => {
        state.searchOptionsLoading = true;
        state.searchOptionsError = null;
      })
      .addCase(fetchGlpiSearchOptions.fulfilled, (state, action) => {
        state.searchOptionsLoading = false;
        const result = action.payload;
        if (result.kind === "ok") {
          state.searchOptions = result.data;
          state.searchOptionsError = null;
          return;
        }
        state.searchOptions = null;
        state.searchOptionsError =
          result.kind === "unavailable"
            ? "Cette API QUAI n'expose pas la route des options de recherche GLPI."
            : result.message;
      })
      .addCase(fetchGlpiSearchOptions.rejected, (state, action) => {
        state.searchOptionsLoading = false;
        state.searchOptionsError = action.error.message ?? "Impossible de lire les options de recherche GLPI.";
      });
  },
});

export const {
  selectGlpiTicket,
  setGlpiAccountQuery,
  setGlpiBrowseOffset,
  setGlpiBrowseTarget,
  clearGlpiTestResult,
  clearGlpiInventoryFeedback,
} = glpiSlice.actions;

/** Sélecteur tolérant au câblage : tant que `glpi` n'est pas monté dans store.ts, la page affiche
 * son état initial au lieu de planter. */
export function selectGlpiState(state: unknown): GlpiState {
  return (state as { glpi?: GlpiState }).glpi ?? initialState;
}

export default glpiSlice.reducer;
