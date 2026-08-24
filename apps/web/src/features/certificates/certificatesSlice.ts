import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiDelete, apiGet, apiPost, apiPut, ApiError } from "@/api/client";

/** Voie d'inscription auprès de l'autorité AD CS — seul le site d'inscription web `certsrv` est
 * réellement automatisable depuis un conteneur Linux (voir apps/api/src/services/certificates.ts). */
export type CertificateEnrollmentMethod = "certsrv";

export type CertificateHealth = "valid" | "expiring" | "expired";

/** GET /api/certificates — jamais de clé privée, jamais d'identifiant. */
export interface CertificateSummary {
  id: string;
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  daysRemaining: number;
  health: CertificateHealth;
  issuedAt: string;
  renewAt: string;
  lastRenewalAttemptAt?: string;
  lastRenewalError?: string;
}

export interface CertificatesReconciliationStatus {
  intervalMs: number;
  lastCheckAt: string | null;
  lastOutcome: string | null;
  lastRenewalAt: string | null;
  lastRenewedSubjects: string[];
  lastFailedSubjects: string[];
  lastError: string | null;
}

export interface CertificatesOverview {
  configured: boolean;
  caUrl?: string;
  template?: string;
  autoEnroll?: boolean;
  renewBeforeDays: number;
  certificates: CertificateSummary[];
  reconciliation: CertificatesReconciliationStatus;
}

/** GET /api/certificates/config — le mot de passe n'y figure tout simplement pas. */
export interface CertificatesConfig {
  caUrl: string;
  method: CertificateEnrollmentMethod;
  template: string;
  username: string;
  renewBeforeDays?: number;
  keySize?: number;
  autoEnroll: boolean;
  tlsRejectUnauthorized?: boolean;
}

export interface CertificatesConfigStatus {
  configured: boolean;
  config?: CertificatesConfig;
}

export interface CertificatesTestResult {
  ok: boolean;
  message: string;
}

/** `password` vide = conserver celui déjà enregistré (même convention que AdDnsFormInput). */
export interface CertificatesFormInput {
  caUrl: string;
  template: string;
  username: string;
  password?: string;
  renewBeforeDays?: number;
  keySize?: number;
  autoEnroll?: boolean;
  tlsRejectUnauthorized?: boolean;
}

type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface CertificatesState {
  overview: CertificatesOverview | null;
  status: LoadStatus;
  error: string | null;
  configured: boolean;
  config: CertificatesConfig | null;
  configStatus: LoadStatus;
  saving: boolean;
  clearing: boolean;
  testing: boolean;
  testResult: CertificatesTestResult | null;
  issuing: boolean;
  issueError: string | null;
}

const initialState: CertificatesState = {
  overview: null,
  status: "idle",
  error: null,
  configured: false,
  config: null,
  configStatus: "idle",
  saving: false,
  clearing: false,
  testing: false,
  testResult: null,
  issuing: false,
  issueError: null,
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export const fetchCertificates = createAsyncThunk<CertificatesOverview>("certificates/fetch", async () =>
  apiGet<CertificatesOverview>("/certificates"),
);

export const fetchCertificatesConfig = createAsyncThunk<CertificatesConfigStatus>("certificates/fetchConfig", async () =>
  apiGet<CertificatesConfigStatus>("/certificates/config"),
);

export const saveCertificatesConfig = createAsyncThunk<CertificatesConfigStatus, CertificatesFormInput, { rejectValue: string }>(
  "certificates/saveConfig",
  async (input, { rejectWithValue }) => {
    try {
      return await apiPut<CertificatesConfigStatus>("/certificates/config", input);
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Impossible d'enregistrer la configuration de l'autorité."));
    }
  },
);

export const testCertificatesConfig = createAsyncThunk<CertificatesTestResult, CertificatesFormInput, { rejectValue: string }>(
  "certificates/testConfig",
  async (input, { rejectWithValue }) => {
    try {
      return await apiPost<CertificatesTestResult>("/certificates/config/test", input);
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Impossible de tester l'autorité de certification."));
    }
  },
);

export const disableCertificates = createAsyncThunk<void, void, { rejectValue: string }>(
  "certificates/disable",
  async (_arg, { rejectWithValue }) => {
    try {
      await apiDelete<{ ok: boolean }>("/certificates/config");
    } catch (error) {
      return rejectWithValue(errorMessage(error, "Impossible de retirer la configuration de l'autorité."));
    }
  },
);

/** Émission/renouvellement manuel — renvoie l'état complet remis à jour. */
export const issueCertificate = createAsyncThunk<CertificatesOverview, string, { rejectValue: string }>(
  "certificates/issue",
  async (subject, { rejectWithValue }) => {
    try {
      return await apiPost<CertificatesOverview>("/certificates/issue", { subject });
    } catch (error) {
      return rejectWithValue(errorMessage(error, `Impossible d'obtenir un certificat pour ${subject}.`));
    }
  },
);

export const forgetCertificate = createAsyncThunk<void, string, { rejectValue: string }>(
  "certificates/forget",
  async (subject, { rejectWithValue }) => {
    try {
      await apiDelete<{ ok: boolean }>(`/certificates/${encodeURIComponent(subject)}`);
    } catch (error) {
      return rejectWithValue(errorMessage(error, `Impossible de retirer le certificat de ${subject}.`));
    }
  },
);

const certificatesSlice = createSlice({
  name: "certificates",
  initialState,
  reducers: {
    clearCertificatesTestResult(state) {
      state.testResult = null;
    },
    clearCertificatesIssueError(state) {
      state.issueError = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchCertificates.pending, (state) => {
        state.status = "loading";
      })
      .addCase(fetchCertificates.fulfilled, (state, action) => {
        state.status = "ready";
        state.error = null;
        state.overview = action.payload;
        state.configured = action.payload.configured;
      })
      .addCase(fetchCertificates.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger les certificats.";
      })
      .addCase(fetchCertificatesConfig.pending, (state) => {
        state.configStatus = "loading";
      })
      .addCase(fetchCertificatesConfig.fulfilled, (state, action) => {
        state.configStatus = "ready";
        state.configured = action.payload.configured;
        state.config = action.payload.config ?? null;
      })
      .addCase(fetchCertificatesConfig.rejected, (state) => {
        state.configStatus = "error";
      })
      .addCase(saveCertificatesConfig.pending, (state) => {
        state.saving = true;
        state.error = null;
      })
      .addCase(saveCertificatesConfig.fulfilled, (state, action) => {
        state.saving = false;
        state.configured = action.payload.configured;
        state.config = action.payload.config ?? null;
        state.testResult = null;
      })
      .addCase(saveCertificatesConfig.rejected, (state, action) => {
        state.saving = false;
        state.error = action.payload ?? "Impossible d'enregistrer la configuration de l'autorité.";
      })
      .addCase(testCertificatesConfig.pending, (state) => {
        state.testing = true;
        state.testResult = null;
      })
      .addCase(testCertificatesConfig.fulfilled, (state, action) => {
        state.testing = false;
        state.testResult = action.payload;
      })
      .addCase(testCertificatesConfig.rejected, (state, action) => {
        state.testing = false;
        state.testResult = { ok: false, message: action.payload ?? "Impossible de tester l'autorité de certification." };
      })
      .addCase(disableCertificates.pending, (state) => {
        state.clearing = true;
      })
      .addCase(disableCertificates.fulfilled, (state) => {
        state.clearing = false;
        state.configured = false;
        state.config = null;
        state.testResult = null;
      })
      .addCase(disableCertificates.rejected, (state, action) => {
        state.clearing = false;
        state.error = action.payload ?? "Impossible de retirer la configuration de l'autorité.";
      })
      .addCase(issueCertificate.pending, (state) => {
        state.issuing = true;
        state.issueError = null;
      })
      .addCase(issueCertificate.fulfilled, (state, action) => {
        state.issuing = false;
        state.overview = action.payload;
        state.configured = action.payload.configured;
      })
      .addCase(issueCertificate.rejected, (state, action) => {
        state.issuing = false;
        state.issueError = action.payload ?? "Impossible d'obtenir le certificat.";
      });
  },
});

export const { clearCertificatesTestResult, clearCertificatesIssueError } = certificatesSlice.actions;
export default certificatesSlice.reducer;
