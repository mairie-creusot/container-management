import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPost, apiPut, ApiError } from "@/api/client";
import type {
  ExagridAlarmState,
  ExagridAuthProtocol,
  ExagridCapacityZone,
  ExagridConfigStatus,
  ExagridEndpoint,
  ExagridPendingWork,
  ExagridPollOutcome,
  ExagridPrivProtocol,
  ExagridReadings,
  ExagridSecurityLevel,
  ExagridSnmpVersion,
  ExagridStatusSummary,
  ExagridTrap,
  ExagridTestResult,
} from "@/types";

/** Corps de PUT /api/exagrid/config — les champs secrets vides sont OMIS, pas envoyés vides :
 * côté serveur, absent = conserver l'existant (même convention que HYCU/Nutanix/AD DNS). */
export interface ExagridConfigFormInput {
  host: string;
  port?: number;
  version: ExagridSnmpVersion;
  community?: string;
  username?: string;
  securityLevel?: ExagridSecurityLevel;
  authProtocol?: ExagridAuthProtocol;
  authKey?: string;
  privProtocol?: ExagridPrivProtocol;
  privKey?: string;
  /** Enregistre l'appliance sans exiger une interrogation réussie : elle ne fait qu'émettre des
   * traps. Les jauges de capacité resteront vides, seules les alarmes reçues seront exploitables. */
  trapsOnly?: boolean;
}

type LoadStatus = "idle" | "loading" | "ready" | "error";

/** Résultat d'une lecture ExaGrid. Le backend SNMP est développé en parallèle : une 404 signifie
 * "route pas encore déployée" et doit produire un état INDISPONIBLE honnête, jamais un écran vide
 * qui laisserait croire à une appliance sans données. D'où un thunk qui se résout toujours au lieu
 * de rejeter — un rejet déclencherait en plus un toast d'erreur à chaque ouverture de page. */
export type ExagridFetchResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

async function readOrDescribe<T>(
  path: string,
  fallback: string,
  normalize: (raw: unknown) => T,
): Promise<ExagridFetchResult<T>> {
  try {
    return { kind: "ok", data: normalize(await apiGet<unknown>(path)) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { kind: "unavailable" };
    return { kind: "error", message: error instanceof ApiError ? error.message : fallback };
  }
}

/** Forme à plat de /status qui a circulé dans les spécifications, servie ici en repli de la forme
 * `readings` réellement renvoyée par apps/api/src/routes/exagrid.ts — aucune valeur n'est inventée
 * dans un cas comme dans l'autre, seuls les champs présents sont repris. */
interface FlatExagridStatus {
  capacity?: {
    landingConfiguredBytes?: number;
    landingAvailableBytes?: number;
    landingUsagePercent?: number;
    retentionConfiguredBytes?: number;
    retentionAvailableBytes?: number;
    retentionUsagePercent?: number;
    backupDataAvailableBytes?: number;
    backupDataConsumedBytes?: number;
  };
  pending?: {
    deduplicationBytes?: number;
    deduplicationAgeSeconds?: number;
    replicationBytes?: number;
    replicationAgeSeconds?: number;
  };
  alarm?: ExagridAlarmState;
  alarmRaw?: number;
}

type WireExagridStatus = ExagridStatusSummary & FlatExagridStatus & { lastPoll?: { at: string; ok?: boolean } };

function keepNumber(value: number | undefined, key: string): Record<string, number> {
  return value !== undefined && Number.isFinite(value) ? { [key]: value } : {};
}

function flatZone(configuredBytes?: number, availableBytes?: number, usedPct?: number): ExagridCapacityZone {
  return {
    ...keepNumber(configuredBytes, "configuredBytes"),
    ...keepNumber(availableBytes, "availableBytes"),
    ...keepNumber(usedPct, "usedPct"),
  };
}

function flatPending(bytes?: number, ageSeconds?: number): ExagridPendingWork {
  return { ...keepNumber(bytes, "bytes"), ...keepNumber(ageSeconds, "ageSeconds") };
}

function flatReadings(wire: WireExagridStatus): ExagridReadings | undefined {
  const capacity = wire.capacity;
  const pending = wire.pending;
  const hasAlarm = wire.alarm !== undefined || wire.alarmRaw !== undefined;
  if (!capacity && !pending && !hasAlarm) return undefined;
  return {
    landing: flatZone(capacity?.landingConfiguredBytes, capacity?.landingAvailableBytes, capacity?.landingUsagePercent),
    retention: flatZone(
      capacity?.retentionConfiguredBytes,
      capacity?.retentionAvailableBytes,
      capacity?.retentionUsagePercent,
    ),
    backupData: {
      ...keepNumber(capacity?.backupDataAvailableBytes, "availableForRestoreBytes"),
      ...keepNumber(capacity?.backupDataConsumedBytes, "retentionConsumedBytes"),
    },
    pendingDeduplication: flatPending(pending?.deduplicationBytes, pending?.deduplicationAgeSeconds),
    pendingReplication: flatPending(pending?.replicationBytes, pending?.replicationAgeSeconds),
    ...(hasAlarm
      ? { alarm: { ...keepNumber(wire.alarmRaw, "raw"), ...(wire.alarm ? { state: wire.alarm } : {}) } }
      : {}),
  };
}

function normalizeStatus(raw: unknown): ExagridStatusSummary {
  const wire = (raw ?? {}) as WireExagridStatus;
  const poll: ExagridPollOutcome | undefined = wire.lastPoll
    ? {
        at: wire.lastPoll.at,
        reachable: typeof wire.lastPoll.reachable === "boolean" ? wire.lastPoll.reachable : wire.lastPoll.ok === true,
      }
    : undefined;
  const readings = wire.readings ?? flatReadings(wire);
  return {
    configured: wire.configured === true,
    ...(typeof wire.reachable === "boolean" ? { reachable: wire.reachable } : {}),
    ...(wire.endpoint ? { endpoint: wire.endpoint } : {}),
    ...(readings ? { readings } : {}),
    ...(poll ? { lastPoll: poll } : {}),
  };
}

/** GET /config renvoie `{ configured, config }` ; une forme à plat a aussi circulé — les deux sont
 * ramenées à `config`. */
function normalizeConfig(raw: unknown): ExagridConfigStatus {
  const wire = (raw ?? {}) as ExagridConfigStatus & Partial<ExagridEndpoint>;
  if (wire.config) return { configured: wire.configured === true, config: wire.config };
  if (wire.configured === true && wire.host) {
    return {
      configured: true,
      config: {
        host: wire.host,
        port: wire.port ?? 161,
        version: wire.version ?? "2c",
        ...(wire.username ? { username: wire.username } : {}),
        ...(wire.securityLevel ? { securityLevel: wire.securityLevel } : {}),
        ...(wire.authProtocol ? { authProtocol: wire.authProtocol } : {}),
        ...(wire.privProtocol ? { privProtocol: wire.privProtocol } : {}),
      },
    };
  }
  return { configured: wire.configured === true };
}

interface ExagridState {
  status: ExagridStatusSummary | null;
  traps: ExagridTrap[];
  statusLoad: LoadStatus;
  statusError: string | null;
  /** Route absente côté API (404) — intégration pas encore déployée, distinct d'une erreur. */
  backendUnavailable: boolean;
  configured: boolean;
  config: ExagridConfigStatus | null;
  configLoad: LoadStatus;
  configSaving: boolean;
  configError: string | null;
  clearing: boolean;
  testing: boolean;
  testResult: ExagridTestResult | null;
}

const initialState: ExagridState = {
  status: null,
  traps: [],
  statusLoad: "idle",
  statusError: null,
  backendUnavailable: false,
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

export const fetchExagridStatus = createAsyncThunk<ExagridFetchResult<ExagridStatusSummary>>(
  "exagrid/fetchStatus",
  async () => readOrDescribe("/exagrid/status", "Impossible de lire l'état de l'appliance ExaGrid.", normalizeStatus),
);

/** GET /api/exagrid/traps — alarmes poussées par l'appliance, seule source réelle tant que son
 * agent SNMP interrogeable n'est pas activé. */
export const fetchExagridTraps = createAsyncThunk<ExagridTrap[]>("exagrid/fetchTraps", async () => {
  const body = await apiGet<{ traps?: ExagridTrap[] }>("/exagrid/traps");
  return body.traps ?? [];
});

export const fetchExagridConfig = createAsyncThunk<ExagridFetchResult<ExagridConfigStatus>>(
  "exagrid/fetchConfig",
  async () => readOrDescribe("/exagrid/config", "Impossible de lire la configuration ExaGrid.", normalizeConfig),
);

/** PUT /api/exagrid/config — le serveur teste la connexion SNMP avant de persister. */
export const saveExagridConfig = createAsyncThunk<ExagridConfigStatus, ExagridConfigFormInput, { rejectValue: string }>(
  "exagrid/saveConfig",
  async (input, { rejectWithValue }) => {
    try {
      return normalizeConfig(await apiPut<unknown>("/exagrid/config", input));
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Impossible d'enregistrer la configuration ExaGrid."));
    }
  },
);

/** POST /api/exagrid/config/test — teste une config candidate SANS persister. */
export const testExagridConfig = createAsyncThunk<ExagridTestResult, ExagridConfigFormInput, { rejectValue: string }>(
  "exagrid/testConfig",
  async (input, { rejectWithValue }) => {
    try {
      return await apiPost<ExagridTestResult>("/exagrid/config/test", input);
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Impossible de tester la connexion SNMP à l'appliance ExaGrid."));
    }
  },
);

export const disableExagrid = createAsyncThunk<void, void, { rejectValue: string }>(
  "exagrid/disable",
  async (_arg, { rejectWithValue }) => {
    try {
      await apiDelete<{ ok: boolean }>("/exagrid/config");
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Impossible de retirer la configuration ExaGrid."));
    }
  },
);

const exagridSlice = createSlice({
  name: "exagrid",
  initialState,
  reducers: {
    clearExagridTestResult(state) {
      state.testResult = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchExagridStatus.pending, (state) => {
        state.statusLoad = "loading";
      })
      .addCase(fetchExagridStatus.fulfilled, (state, action) => {
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
      .addCase(fetchExagridStatus.rejected, (state, action) => {
        state.statusLoad = "error";
        state.statusError = action.error.message ?? "Impossible de lire l'état de l'appliance ExaGrid.";
      })
      .addCase(fetchExagridConfig.pending, (state) => {
        state.configLoad = "loading";
      })
      .addCase(fetchExagridConfig.fulfilled, (state, action) => {
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
      .addCase(fetchExagridConfig.rejected, (state) => {
        state.configLoad = "error";
      })
      .addCase(saveExagridConfig.pending, (state) => {
        state.configSaving = true;
        state.configError = null;
      })
      .addCase(saveExagridConfig.fulfilled, (state, action) => {
        state.configSaving = false;
        state.configLoad = "ready";
        state.config = action.payload;
        state.configured = action.payload.configured;
        state.backendUnavailable = false;
        // L'état affiché peut venir d'une ancienne appliance — forcer son rechargement.
        state.statusLoad = "idle";
      })
      .addCase(saveExagridConfig.rejected, (state, action) => {
        state.configSaving = false;
        state.configError = action.payload ?? "Impossible d'enregistrer la configuration ExaGrid.";
      })
      .addCase(testExagridConfig.pending, (state) => {
        state.testing = true;
        state.testResult = null;
      })
      .addCase(testExagridConfig.fulfilled, (state, action) => {
        state.testing = false;
        state.testResult = action.payload;
      })
      .addCase(testExagridConfig.rejected, (state, action) => {
        state.testing = false;
        state.testResult = {
          ok: false,
          message: action.payload ?? "Impossible de tester la connexion SNMP à l'appliance ExaGrid.",
        };
      })
      .addCase(disableExagrid.pending, (state) => {
        state.clearing = true;
      })
      .addCase(fetchExagridTraps.fulfilled, (state, action) => {
        state.traps = action.payload;
      })
      .addCase(disableExagrid.fulfilled, (state) => {
        state.clearing = false;
        state.configured = false;
        state.config = { configured: false };
        state.status = { configured: false };
        state.statusLoad = "ready";
        state.statusError = null;
        state.testResult = null;
      })
      .addCase(disableExagrid.rejected, (state, action) => {
        state.clearing = false;
        state.configError = action.payload ?? "Impossible de retirer la configuration ExaGrid.";
      });
  },
});

export const { clearExagridTestResult } = exagridSlice.actions;
export default exagridSlice.reducer;
