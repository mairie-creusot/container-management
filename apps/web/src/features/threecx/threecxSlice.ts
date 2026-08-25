import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPost, apiPut, ApiError } from "@/api/client";
import type { RootState } from "@/store";
import type {
  ThreecxAccess,
  ThreecxActiveCall,
  ThreecxAuthMode,
  ThreecxCallParticipant,
  ThreecxConfigStatus,
  ThreecxExtension,
  ThreecxListState,
  ThreecxLoadStatus,
  ThreecxPollOutcome,
  ThreecxPublicConfig,
  ThreecxQueue,
  ThreecxStatusSummary,
  ThreecxSystemStatus,
  ThreecxTestResult,
} from "@/features/threecx/types";

/** Corps de PUT/POST /api/3cx/config — `clientSecret`/`password` vides sont OMIS, jamais envoyés
 * vides : côté serveur, absent = conserver le secret existant (même convention que HYCU).
 * `authMode` est TOUJOURS envoyé : c'est lui que le serveur teste. */
export interface ThreecxConfigFormInput {
  baseUrl: string;
  authMode: ThreecxAuthMode;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  tlsRejectUnauthorized?: boolean;
}

/** Une lecture ne REJETTE jamais. Une 404 signifie "route absente de cette
 * API" et doit produire un état indisponible honnête, pas un écran vide qui ressemblerait à un PBX
 * sans appels. */
export type ThreecxFetchResult<T> = { kind: "ok"; data: T } | { kind: "unavailable" } | { kind: "error"; message: string };

async function readOrDescribe<T>(path: string, fallback: string, normalize: (raw: unknown) => T): Promise<ThreecxFetchResult<T>> {
  try {
    return { kind: "ok", data: normalize(await apiGet<unknown>(path)) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { kind: "unavailable" };
    return { kind: "error", message: error instanceof ApiError ? error.message : fallback };
  }
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

function optString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function keep<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

/** Enveloppe commune { configured, reachable?, accessError?, pbxError? } — les cinq états du
 * backend dépendent entièrement de ces champs, jamais de la longueur de la liste. */
function normalizeAccess(raw: unknown): ThreecxAccess {
  const wire = asRecord(raw);
  return {
    configured: wire.configured === true,
    ...keep("reachable", optBoolean(wire.reachable)),
    ...keep("accessError", optString(wire.accessError)),
    ...keep("pbxError", optString(wire.pbxError)),
  };
}

function normalizeParticipant(raw: unknown): ThreecxCallParticipant | null {
  const wire = asRecord(raw);
  const number = optString(wire.number);
  if (!number) return null;
  const direction = wire.direction === "callee" ? "callee" : "caller";
  return { number, direction, ...keep("name", optString(wire.name)) };
}

function normalizeCall(raw: unknown): ThreecxActiveCall | null {
  const wire = asRecord(raw);
  const id = optString(wire.id) ?? (optNumber(wire.id) !== undefined ? String(wire.id) : undefined);
  if (!id) return null;
  const participants = Array.isArray(wire.participants)
    ? wire.participants.map(normalizeParticipant).filter((p): p is ThreecxCallParticipant => p !== null)
    : [];
  return {
    id,
    participants,
    ...keep("startedAt", optString(wire.startedAt)),
    ...keep("durationSeconds", optNumber(wire.durationSeconds)),
    ...keep("status", optString(wire.status)),
    ...keep("lastChangeAt", optString(wire.lastChangeAt)),
  };
}

function normalizeExtension(raw: unknown): ThreecxExtension | null {
  const wire = asRecord(raw);
  const id = optNumber(wire.id);
  const number = optString(wire.number);
  if (id === undefined || !number) return null;
  return {
    id,
    number,
    ...keep("displayName", optString(wire.displayName)),
    ...keep("firstName", optString(wire.firstName)),
    ...keep("lastName", optString(wire.lastName)),
    ...keep("registered", optBoolean(wire.registered)),
    ...keep("enabled", optBoolean(wire.enabled)),
    ...keep("internal", optBoolean(wire.internal)),
    ...keep("currentProfileName", optString(wire.currentProfileName)),
    ...keep("queueStatus", optString(wire.queueStatus)),
  };
}

function normalizeQueue(raw: unknown): ThreecxQueue | null {
  const wire = asRecord(raw);
  const id = optNumber(wire.id);
  const number = optString(wire.number);
  if (id === undefined || !number) return null;
  return {
    id,
    number,
    ...keep("name", optString(wire.name)),
    ...keep("registered", optBoolean(wire.registered)),
    ...keep("pollingStrategy", optString(wire.pollingStrategy)),
    ...keep("maxCallersInQueue", optNumber(wire.maxCallersInQueue)),
  };
}

/** Les routes renomment `items` en `calls`/`extensions`/`queues` (voir routes/threecx.ts) — les
 * deux noms sont acceptés, aucun élément n'est fabriqué si aucun n'est présent. */
function normalizeList<T>(raw: unknown, key: string, map: (item: unknown) => T | null): { access: ThreecxAccess; items: T[] } {
  const wire = asRecord(raw);
  const candidate = wire[key] ?? wire.items;
  const items = Array.isArray(candidate) ? candidate.map(map).filter((item): item is T => item !== null) : [];
  return { access: normalizeAccess(raw), items };
}

function normalizeSystem(raw: unknown): ThreecxSystemStatus | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const wire = asRecord(raw);
  const system: ThreecxSystemStatus = {
    ...keep("version", optString(wire.version)),
    ...keep("fqdn", optString(wire.fqdn)),
    ...keep("activated", optBoolean(wire.activated)),
    ...keep("callsActive", optNumber(wire.callsActive)),
    ...keep("maxSimCalls", optNumber(wire.maxSimCalls)),
    ...keep("extensionsRegistered", optNumber(wire.extensionsRegistered)),
    ...keep("extensionsTotal", optNumber(wire.extensionsTotal)),
    ...keep("trunksRegistered", optNumber(wire.trunksRegistered)),
    ...keep("trunksTotal", optNumber(wire.trunksTotal)),
  };
  return Object.keys(system).length > 0 ? system : undefined;
}

function normalizePoll(raw: unknown): ThreecxPollOutcome | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const wire = asRecord(raw);
  const at = optString(wire.at);
  if (!at) return undefined;
  return { at, reachable: wire.reachable === true };
}

function normalizeStatus(raw: unknown): ThreecxStatusSummary {
  const wire = asRecord(raw);
  return {
    ...normalizeAccess(raw),
    ...keep("activeCallCount", optNumber(wire.activeCallCount)),
    ...keep("extensionCount", optNumber(wire.extensionCount)),
    ...keep("reachableExtensionCount", optNumber(wire.reachableExtensionCount)),
    ...keep("queueCount", optNumber(wire.queueCount)),
    ...keep("system", normalizeSystem(wire.system)),
    ...keep("lastPoll", normalizePoll(wire.lastPoll)),
  };
}

/** Une valeur inconnue ou absente vaut "client-credentials" — c'est le mode d'une config
 * enregistrée avant l'ajout du choix (le serveur applique la même migration à la lecture). */
function normalizeAuthMode(value: unknown): ThreecxAuthMode {
  return value === "user" ? "user" : "client-credentials";
}

function normalizeConfig(raw: unknown): ThreecxConfigStatus {
  const wire = asRecord(raw);
  const inner = asRecord(wire.config);
  const baseUrl = optString(inner.baseUrl);
  if (wire.configured !== true || !baseUrl) return { configured: wire.configured === true };
  const config: ThreecxPublicConfig = {
    baseUrl,
    authMode: normalizeAuthMode(inner.authMode),
    ...keep("clientId", optString(inner.clientId)),
    ...keep("username", optString(inner.username)),
    ...keep("tlsRejectUnauthorized", optBoolean(inner.tlsRejectUnauthorized)),
  };
  return { configured: true, config };
}

function normalizeTestResult(raw: unknown): ThreecxTestResult {
  const wire = asRecord(raw);
  return {
    ok: wire.ok === true,
    message: optString(wire.message) ?? (wire.ok === true ? "Le PBX 3CX répond." : "Le PBX 3CX n'a pas répondu."),
    ...keep("activeCallCount", optNumber(wire.activeCallCount)),
  };
}

export interface ThreecxState {
  status: ThreecxStatusSummary | null;
  statusLoad: ThreecxLoadStatus;
  statusError: string | null;
  /** Routes absentes de cette API (404) — intégration pas déployée, distinct d'une erreur. */
  backendUnavailable: boolean;
  calls: ThreecxListState<ThreecxActiveCall>;
  /** Date.now() de la réception des appels — origine du compteur de durée qui s'incrémente. */
  callsReceivedAt: number | null;
  extensions: ThreecxListState<ThreecxExtension>;
  queues: ThreecxListState<ThreecxQueue>;
  configured: boolean;
  config: ThreecxPublicConfig | null;
  configLoad: ThreecxLoadStatus;
  configSaving: boolean;
  configError: string | null;
  clearing: boolean;
  testing: boolean;
  testResult: ThreecxTestResult | null;
}

function emptyList<T>(): ThreecxListState<T> {
  return { access: { configured: false }, items: [], load: "idle", error: null };
}

const initialState: ThreecxState = {
  status: null,
  statusLoad: "idle",
  statusError: null,
  backendUnavailable: false,
  calls: emptyList<ThreecxActiveCall>(),
  callsReceivedAt: null,
  extensions: emptyList<ThreecxExtension>(),
  queues: emptyList<ThreecxQueue>(),
  configured: false,
  config: null,
  configLoad: "idle",
  configSaving: false,
  configError: null,
  clearing: false,
  testing: false,
  testResult: null,
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export const fetchThreecxStatus = createAsyncThunk<ThreecxFetchResult<ThreecxStatusSummary>>("threecx/fetchStatus", async () =>
  readOrDescribe("/3cx/status", "Impossible de lire l'état du PBX 3CX.", normalizeStatus),
);

export const fetchThreecxActiveCalls = createAsyncThunk<ThreecxFetchResult<{ access: ThreecxAccess; items: ThreecxActiveCall[] }>>(
  "threecx/fetchActiveCalls",
  async () => readOrDescribe("/3cx/active-calls", "Impossible de lire les appels en cours.", (raw) => normalizeList(raw, "calls", normalizeCall)),
);

export const fetchThreecxExtensions = createAsyncThunk<ThreecxFetchResult<{ access: ThreecxAccess; items: ThreecxExtension[] }>>(
  "threecx/fetchExtensions",
  async () => readOrDescribe("/3cx/extensions", "Impossible de lire les postes.", (raw) => normalizeList(raw, "extensions", normalizeExtension)),
);

export const fetchThreecxQueues = createAsyncThunk<ThreecxFetchResult<{ access: ThreecxAccess; items: ThreecxQueue[] }>>(
  "threecx/fetchQueues",
  async () => readOrDescribe("/3cx/queues", "Impossible de lire les files d'attente.", (raw) => normalizeList(raw, "queues", normalizeQueue)),
);

export const fetchThreecxConfig = createAsyncThunk<ThreecxFetchResult<ThreecxConfigStatus>>("threecx/fetchConfig", async () =>
  readOrDescribe("/3cx/config", "Impossible de lire la configuration 3CX.", normalizeConfig),
);

/** PUT /api/3cx/config — le serveur teste RÉELLEMENT le PBX avant de persister. */
export const saveThreecxConfig = createAsyncThunk<ThreecxConfigStatus, ThreecxConfigFormInput, { rejectValue: string }>(
  "threecx/saveConfig",
  async (input, { rejectWithValue }) => {
    try {
      return normalizeConfig(await apiPut<unknown>("/3cx/config", input));
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Impossible d'enregistrer la configuration 3CX."));
    }
  },
);

/** POST /api/3cx/config/test — teste une config candidate SANS persister. */
export const testThreecxConfig = createAsyncThunk<ThreecxTestResult, ThreecxConfigFormInput, { rejectValue: string }>(
  "threecx/testConfig",
  async (input, { rejectWithValue }) => {
    try {
      return normalizeTestResult(await apiPost<unknown>("/3cx/config/test", input));
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Impossible de tester la connexion au PBX 3CX."));
    }
  },
);

export const disableThreecx = createAsyncThunk<void, void, { rejectValue: string }>("threecx/disable", async (_arg, { rejectWithValue }) => {
  try {
    await apiDelete<{ ok: boolean }>("/3cx/config");
  } catch (error) {
    return rejectWithValue(errorMessage(error, "Impossible de retirer la configuration 3CX."));
  }
});

/** Nouvel état d'une liste — aucun élément n'est conservé si la lecture a échoué, et l'enveloppe
 * d'accès n'est jamais devinée : seule une réponse réelle la renseigne. */
function nextList<T>(result: ThreecxFetchResult<{ access: ThreecxAccess; items: T[] }>, configured: boolean): ThreecxListState<T> {
  if (result.kind === "ok") return { access: result.data.access, items: result.data.items, load: "ready", error: null };
  return { access: { configured }, items: [], load: "error", error: result.kind === "unavailable" ? null : result.message };
}

const threecxSlice = createSlice({
  name: "threecx",
  initialState,
  reducers: {
    clearThreecxTestResult(state) {
      state.testResult = null;
    },
    /** Force le rechargement complet (changement de config, bouton Actualiser). */
    invalidateThreecx(state) {
      state.statusLoad = "idle";
      state.calls.load = "idle";
      state.extensions.load = "idle";
      state.queues.load = "idle";
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchThreecxStatus.pending, (state) => {
        state.statusLoad = "loading";
      })
      .addCase(fetchThreecxStatus.fulfilled, (state, action) => {
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
        if (result.kind === "unavailable") {
          state.backendUnavailable = true;
          state.statusError = null;
        } else {
          state.backendUnavailable = false;
          state.statusError = result.message;
        }
      })
      .addCase(fetchThreecxStatus.rejected, (state, action) => {
        state.statusLoad = "error";
        state.statusError = action.error.message ?? "Impossible de lire l'état du PBX 3CX.";
      })
      .addCase(fetchThreecxActiveCalls.pending, (state) => {
        state.calls.load = "loading";
      })
      .addCase(fetchThreecxActiveCalls.fulfilled, (state, action) => {
        state.calls = nextList(action.payload, state.configured);
        if (action.payload.kind === "unavailable") state.backendUnavailable = true;
        // Origine du compteur affiché : les durées du PBX datent de CETTE réponse.
        state.callsReceivedAt = action.payload.kind === "ok" ? Date.now() : null;
      })
      .addCase(fetchThreecxActiveCalls.rejected, (state, action) => {
        state.calls.load = "error";
        state.calls.error = action.error.message ?? "Impossible de lire les appels en cours.";
      })
      .addCase(fetchThreecxExtensions.pending, (state) => {
        state.extensions.load = "loading";
      })
      .addCase(fetchThreecxExtensions.fulfilled, (state, action) => {
        state.extensions = nextList(action.payload, state.configured);
        if (action.payload.kind === "unavailable") state.backendUnavailable = true;
      })
      .addCase(fetchThreecxExtensions.rejected, (state, action) => {
        state.extensions.load = "error";
        state.extensions.error = action.error.message ?? "Impossible de lire les postes.";
      })
      .addCase(fetchThreecxQueues.pending, (state) => {
        state.queues.load = "loading";
      })
      .addCase(fetchThreecxQueues.fulfilled, (state, action) => {
        state.queues = nextList(action.payload, state.configured);
        if (action.payload.kind === "unavailable") state.backendUnavailable = true;
      })
      .addCase(fetchThreecxQueues.rejected, (state, action) => {
        state.queues.load = "error";
        state.queues.error = action.error.message ?? "Impossible de lire les files d'attente.";
      })
      .addCase(fetchThreecxConfig.pending, (state) => {
        state.configLoad = "loading";
      })
      .addCase(fetchThreecxConfig.fulfilled, (state, action) => {
        const result = action.payload;
        if (result.kind === "ok") {
          state.configLoad = "ready";
          state.configured = result.data.configured;
          state.config = result.data.config ?? null;
          return;
        }
        state.configLoad = "error";
        state.config = null;
        if (result.kind === "unavailable") state.backendUnavailable = true;
      })
      .addCase(fetchThreecxConfig.rejected, (state) => {
        state.configLoad = "error";
      })
      .addCase(saveThreecxConfig.pending, (state) => {
        state.configSaving = true;
        state.configError = null;
      })
      .addCase(saveThreecxConfig.fulfilled, (state, action) => {
        state.configSaving = false;
        state.configLoad = "ready";
        state.configured = action.payload.configured;
        state.config = action.payload.config ?? null;
        state.backendUnavailable = false;
        // Tout ce qui est affiché vient peut-être de l'ancien PBX : à recharger.
        state.statusLoad = "idle";
        state.calls.load = "idle";
        state.extensions.load = "idle";
        state.queues.load = "idle";
      })
      .addCase(saveThreecxConfig.rejected, (state, action) => {
        state.configSaving = false;
        state.configError = action.payload ?? "Impossible d'enregistrer la configuration 3CX.";
      })
      .addCase(testThreecxConfig.pending, (state) => {
        state.testing = true;
        state.testResult = null;
      })
      .addCase(testThreecxConfig.fulfilled, (state, action) => {
        state.testing = false;
        state.testResult = action.payload;
      })
      .addCase(testThreecxConfig.rejected, (state, action) => {
        state.testing = false;
        state.testResult = { ok: false, message: action.payload ?? "Impossible de tester la connexion au PBX 3CX." };
      })
      .addCase(disableThreecx.pending, (state) => {
        state.clearing = true;
      })
      .addCase(disableThreecx.fulfilled, (state) => {
        state.clearing = false;
        state.configured = false;
        state.config = null;
        state.configLoad = "ready";
        state.status = { configured: false };
        state.statusLoad = "ready";
        state.statusError = null;
        state.testResult = null;
        state.calls = emptyList<ThreecxActiveCall>();
        state.callsReceivedAt = null;
        state.extensions = emptyList<ThreecxExtension>();
        state.queues = emptyList<ThreecxQueue>();
      })
      .addCase(disableThreecx.rejected, (state, action) => {
        state.clearing = false;
        state.configError = action.payload ?? "Impossible de retirer la configuration 3CX.";
      });
  },
});

/** Sélecteur tolérant : le réducteur est câblé dans store.ts par ailleurs — tant qu'il ne l'est
 * pas, la page lit l'état initial au lieu de faire échouer la compilation. */
export function selectThreecx(state: RootState): ThreecxState {
  return (state as RootState & { threecx?: ThreecxState }).threecx ?? initialState;
}

export const { clearThreecxTestResult, invalidateThreecx } = threecxSlice.actions;
export default threecxSlice.reducer;
