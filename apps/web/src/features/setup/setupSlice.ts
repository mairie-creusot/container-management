import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { apiGet, apiPost, ApiError } from "@/api/client";
import type {
  DockerTestResult,
  KubernetesTestResult,
  LdapConfigInput,
  LdapTestResult,
  NutanixTestResult,
  RegistryConfigInput,
  RegistryKind,
  RegistryTestResult,
  Role,
  SetupCompletePayload,
  SetupStatus,
} from "@/types";
import type { RootState } from "@/store";

export type TestStatus = "idle" | "testing" | "ok" | "error" | "skipped";

export type WizardStepId = "welcome" | "ldap" | "orchestrators" | "registries" | "summary";

export const WIZARD_STEPS: { id: WizardStepId; label: string }[] = [
  { id: "welcome", label: "Bienvenue" },
  { id: "ldap", label: "Annuaire LDAP" },
  { id: "orchestrators", label: "Orchestrateurs" },
  { id: "registries", label: "Registries" },
  { id: "summary", label: "Récapitulatif" },
];

export interface GroupRoleEntry {
  id: string;
  ldapGroup: string;
  role: Role;
}

interface LdapStepState {
  url: string;
  bindDn: string;
  bindPassword: string;
  searchBase: string;
  searchFilter: string;
  groupRoleEntries: GroupRoleEntry[];
  test: TestStatus;
  message: string | null;
  resolvedGroups: number | null;
  testUserDn: string | null;
}

interface DockerStepState {
  test: TestStatus;
  message: string | null;
  version: string | null;
}

interface KubernetesStepState {
  kubeconfig: string;
  test: TestStatus;
  message: string | null;
  context: string | null;
  nodeCount: number | null;
}

interface NutanixStepState {
  prismCentralUrl: string;
  username: string;
  password: string;
  test: TestStatus;
  message: string | null;
  vmCount: number | null;
}

export interface RegistryDraft {
  tempId: string;
  kind: RegistryKind;
  name: string;
  url: string;
  username: string;
  password: string;
  token: string;
  test: TestStatus;
  message: string | null;
}

interface SetupState {
  completed: boolean | null; // null = pas encore su
  statusError: string | null;
  currentStep: WizardStepId;
  ldap: LdapStepState;
  docker: DockerStepState;
  kubernetes: KubernetesStepState;
  nutanix: NutanixStepState;
  registries: RegistryDraft[];
  completeStatus: "idle" | "submitting" | "error";
  completeError: string | null;
}

function nextId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const initialState: SetupState = {
  completed: null,
  statusError: null,
  currentStep: "welcome",
  ldap: {
    url: "",
    bindDn: "",
    bindPassword: "",
    searchBase: "",
    searchFilter: "",
    groupRoleEntries: [],
    test: "idle",
    message: null,
    resolvedGroups: null,
    testUserDn: null,
  },
  docker: {
    test: "idle",
    message: null,
    version: null,
  },
  kubernetes: {
    kubeconfig: "",
    test: "idle",
    message: null,
    context: null,
    nodeCount: null,
  },
  nutanix: {
    prismCentralUrl: "",
    username: "",
    password: "",
    test: "idle",
    message: null,
    vmCount: null,
  },
  registries: [],
  completeStatus: "idle",
  completeError: null,
};

export const fetchSetupStatus = createAsyncThunk<SetupStatus>(
  "setup/fetchStatus",
  async () => apiGet<SetupStatus>("/setup/status"),
);

function buildGroupRoleMap(entries: GroupRoleEntry[]): Record<string, Role> {
  const map: Record<string, Role> = {};
  for (const entry of entries) {
    if (entry.ldapGroup.trim() !== "") map[entry.ldapGroup.trim()] = entry.role;
  }
  return map;
}

export const testLdap = createAsyncThunk<LdapTestResult, void, { state: RootState; rejectValue: string }>(
  "setup/testLdap",
  async (_arg, { getState, rejectWithValue }) => {
    const { ldap } = getState().setup;
    const payload: LdapConfigInput = {
      url: ldap.url,
      bindDn: ldap.bindDn,
      bindPassword: ldap.bindPassword,
      searchBase: ldap.searchBase,
      searchFilter: ldap.searchFilter,
      groupRoleMap: buildGroupRoleMap(ldap.groupRoleEntries),
    };
    try {
      return await apiPost<LdapTestResult>("/setup/test/ldap", payload);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Test LDAP impossible.";
      return rejectWithValue(message);
    }
  },
);

export const testDocker = createAsyncThunk<DockerTestResult, void, { rejectValue: string }>(
  "setup/testDocker",
  async (_arg, { rejectWithValue }) => {
    try {
      return await apiPost<DockerTestResult>("/setup/test/docker", {});
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Test Docker impossible.";
      return rejectWithValue(message);
    }
  },
);

export const testKubernetes = createAsyncThunk<
  KubernetesTestResult,
  void,
  { state: RootState; rejectValue: string }
>("setup/testKubernetes", async (_arg, { getState, rejectWithValue }) => {
  const { kubeconfig } = getState().setup.kubernetes;
  try {
    // L'API attend la clé `kubeconfigYaml` (POST /api/setup/test/kubernetes).
    return await apiPost<KubernetesTestResult>("/setup/test/kubernetes", { kubeconfigYaml: kubeconfig });
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Test Kubernetes impossible.";
    return rejectWithValue(message);
  }
});

export const testNutanix = createAsyncThunk<NutanixTestResult, void, { state: RootState; rejectValue: string }>(
  "setup/testNutanix",
  async (_arg, { getState, rejectWithValue }) => {
    const { nutanix } = getState().setup;
    try {
      return await apiPost<NutanixTestResult>("/setup/test/nutanix", {
        prismCentralUrl: nutanix.prismCentralUrl,
        username: nutanix.username,
        password: nutanix.password,
      });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Test Nutanix impossible.";
      return rejectWithValue(message);
    }
  },
);

export const testRegistry = createAsyncThunk<
  RegistryTestResult & { tempId: string },
  string,
  { state: RootState; rejectValue: { tempId: string; message: string } }
>("setup/testRegistry", async (tempId, { getState, rejectWithValue }) => {
  const draft = getState().setup.registries.find((r) => r.tempId === tempId);
  if (!draft) return rejectWithValue({ tempId, message: "Registry introuvable." });
  const payload: RegistryConfigInput = {
    kind: draft.kind,
    name: draft.name,
    url: draft.url,
    ...(draft.username ? { username: draft.username } : {}),
    ...(draft.password ? { password: draft.password } : {}),
    ...(draft.token ? { token: draft.token } : {}),
  };
  try {
    const result = await apiPost<RegistryTestResult>("/setup/test/registry", payload);
    return { ...result, tempId };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Test du registry impossible.";
    return rejectWithValue({ tempId, message });
  }
});

export const completeSetup = createAsyncThunk<void, void, { state: RootState; rejectValue: string }>(
  "setup/complete",
  async (_arg, { getState, rejectWithValue }) => {
    const { setup } = getState();
    const payload: SetupCompletePayload = {
      ldap: {
        url: setup.ldap.url,
        bindDn: setup.ldap.bindDn,
        bindPassword: setup.ldap.bindPassword,
        searchBase: setup.ldap.searchBase,
        searchFilter: setup.ldap.searchFilter,
        groupRoleMap: buildGroupRoleMap(setup.ldap.groupRoleEntries),
        // Rôle appliqué aux utilisateurs authentifiés dont aucun groupe ne
        // correspond au mapping ci-dessus. Pas encore éditable dans
        // l'assistant : "viewer" (moindre privilège) tant que ce n'est pas
        // exposé comme champ de LdapStep.
        defaultRole: "viewer",
      },
      docker: setup.docker.test === "ok" ? {} : null,
      kubernetes: setup.kubernetes.test === "ok" ? { kubeconfigYaml: setup.kubernetes.kubeconfig } : null,
      nutanix:
        setup.nutanix.test === "ok"
          ? {
              prismCentralUrl: setup.nutanix.prismCentralUrl,
              username: setup.nutanix.username,
              password: setup.nutanix.password,
            }
          : null,
      registries: setup.registries
        .filter((r) => r.test === "ok")
        .map((r) => ({
          kind: r.kind,
          name: r.name,
          url: r.url,
          ...(r.username ? { username: r.username } : {}),
          ...(r.password ? { password: r.password } : {}),
          ...(r.token ? { token: r.token } : {}),
        })),
    };
    try {
      await apiPost<void>("/setup/complete", payload);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Impossible de finaliser la configuration.";
      return rejectWithValue(message);
    }
  },
);

/** Repasse en mode assistant (admin uniquement, côté API) — voir Topbar.tsx (menu profil). */
export const resetSetup = createAsyncThunk("setup/reset", async () => {
  await apiPost<void>("/setup/reset");
});

const setupSlice = createSlice({
  name: "setup",
  initialState,
  reducers: {
    setCurrentStep(state, action: PayloadAction<WizardStepId>) {
      state.currentStep = action.payload;
    },
    updateLdapForm(
      state,
      action: PayloadAction<
        Partial<Pick<LdapStepState, "url" | "bindDn" | "bindPassword" | "searchBase" | "searchFilter">>
      >,
    ) {
      Object.assign(state.ldap, action.payload);
      // Toute modification invalide un test précédent.
      if (state.ldap.test !== "idle") {
        state.ldap.test = "idle";
        state.ldap.message = null;
      }
    },
    addGroupRoleEntry(state) {
      state.ldap.groupRoleEntries.push({ id: nextId(), ldapGroup: "", role: "viewer" });
    },
    updateGroupRoleEntry(state, action: PayloadAction<{ id: string; ldapGroup?: string; role?: Role }>) {
      const entry = state.ldap.groupRoleEntries.find((e) => e.id === action.payload.id);
      if (!entry) return;
      if (action.payload.ldapGroup !== undefined) entry.ldapGroup = action.payload.ldapGroup;
      if (action.payload.role !== undefined) entry.role = action.payload.role;
    },
    removeGroupRoleEntry(state, action: PayloadAction<string>) {
      state.ldap.groupRoleEntries = state.ldap.groupRoleEntries.filter((e) => e.id !== action.payload);
    },
    markDockerSkipped(state) {
      state.docker.test = "skipped";
      state.docker.message = null;
    },
    updateKubeconfig(state, action: PayloadAction<string>) {
      state.kubernetes.kubeconfig = action.payload;
      if (state.kubernetes.test !== "idle") {
        state.kubernetes.test = "idle";
        state.kubernetes.message = null;
      }
    },
    markKubernetesSkipped(state) {
      state.kubernetes.test = "skipped";
      state.kubernetes.message = null;
    },
    updateNutanixForm(
      state,
      action: PayloadAction<Partial<Pick<NutanixStepState, "prismCentralUrl" | "username" | "password">>>,
    ) {
      Object.assign(state.nutanix, action.payload);
      if (state.nutanix.test !== "idle") {
        state.nutanix.test = "idle";
        state.nutanix.message = null;
      }
    },
    markNutanixSkipped(state) {
      state.nutanix.test = "skipped";
      state.nutanix.message = null;
    },
    addRegistryDraft(state) {
      state.registries.push({
        tempId: nextId(),
        kind: "dockerhub",
        name: "",
        url: "",
        username: "",
        password: "",
        token: "",
        test: "idle",
        message: null,
      });
    },
    updateRegistryDraft(
      state,
      action: PayloadAction<{ tempId: string } & Partial<Omit<RegistryDraft, "tempId" | "test" | "message">>>,
    ) {
      const draft = state.registries.find((r) => r.tempId === action.payload.tempId);
      if (!draft) return;
      Object.assign(draft, action.payload);
      if (draft.test !== "idle") {
        draft.test = "idle";
        draft.message = null;
      }
    },
    removeRegistryDraft(state, action: PayloadAction<string>) {
      state.registries = state.registries.filter((r) => r.tempId !== action.payload);
    },
    markRegistrySkipped(state, action: PayloadAction<string>) {
      const draft = state.registries.find((r) => r.tempId === action.payload);
      if (draft) {
        draft.test = "skipped";
        draft.message = null;
      }
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchSetupStatus.fulfilled, (state, action) => {
        state.completed = action.payload.completed;
      })
      .addCase(fetchSetupStatus.rejected, (state, action) => {
        // Si l'API n'est pas joignable, on ne bloque pas l'utilisateur
        // indéfiniment sur l'écran de chargement : on suppose la
        // configuration déjà faite et on laisse l'écran de connexion
        // afficher l'erreur réseau à la tentative suivante.
        state.completed = true;
        state.statusError = action.error.message ?? "Statut de configuration indisponible.";
      })
      .addCase(resetSetup.fulfilled, (state) => {
        state.completed = false;
        state.currentStep = "welcome";
      })
      .addCase(testLdap.pending, (state) => {
        state.ldap.test = "testing";
        state.ldap.message = null;
      })
      .addCase(testLdap.fulfilled, (state, action) => {
        state.ldap.test = action.payload.ok ? "ok" : "error";
        state.ldap.message = action.payload.message;
        state.ldap.resolvedGroups = action.payload.groupsResolved ?? null;
        state.ldap.testUserDn = action.payload.userDn ?? null;
      })
      .addCase(testLdap.rejected, (state, action) => {
        state.ldap.test = "error";
        state.ldap.message = action.payload ?? "Test LDAP impossible.";
      })
      .addCase(testDocker.pending, (state) => {
        state.docker.test = "testing";
        state.docker.message = null;
      })
      .addCase(testDocker.fulfilled, (state, action) => {
        state.docker.test = action.payload.ok ? "ok" : "error";
        state.docker.message = action.payload.message;
        state.docker.version = action.payload.version ?? null;
      })
      .addCase(testDocker.rejected, (state, action) => {
        state.docker.test = "error";
        state.docker.message = action.payload ?? "Test Docker impossible.";
      })
      .addCase(testKubernetes.pending, (state) => {
        state.kubernetes.test = "testing";
        state.kubernetes.message = null;
      })
      .addCase(testKubernetes.fulfilled, (state, action) => {
        state.kubernetes.test = action.payload.ok ? "ok" : "error";
        state.kubernetes.message = action.payload.message;
        state.kubernetes.context = action.payload.context ?? null;
        state.kubernetes.nodeCount = action.payload.nodeCount ?? null;
      })
      .addCase(testKubernetes.rejected, (state, action) => {
        state.kubernetes.test = "error";
        state.kubernetes.message = action.payload ?? "Test Kubernetes impossible.";
      })
      .addCase(testNutanix.pending, (state) => {
        state.nutanix.test = "testing";
        state.nutanix.message = null;
      })
      .addCase(testNutanix.fulfilled, (state, action) => {
        state.nutanix.test = action.payload.ok ? "ok" : "error";
        state.nutanix.message = action.payload.message;
        state.nutanix.vmCount = action.payload.vmCount ?? null;
      })
      .addCase(testNutanix.rejected, (state, action) => {
        state.nutanix.test = "error";
        state.nutanix.message = action.payload ?? "Test Nutanix impossible.";
      })
      .addCase(testRegistry.pending, (state, action) => {
        const draft = state.registries.find((r) => r.tempId === action.meta.arg);
        if (draft) {
          draft.test = "testing";
          draft.message = null;
        }
      })
      .addCase(testRegistry.fulfilled, (state, action) => {
        const draft = state.registries.find((r) => r.tempId === action.payload.tempId);
        if (draft) {
          draft.test = action.payload.ok ? "ok" : "error";
          draft.message = action.payload.message;
        }
      })
      .addCase(testRegistry.rejected, (state, action) => {
        const tempId = action.payload?.tempId ?? action.meta.arg;
        const draft = state.registries.find((r) => r.tempId === tempId);
        if (draft) {
          draft.test = "error";
          draft.message = action.payload?.message ?? "Test du registry impossible.";
        }
      })
      .addCase(completeSetup.pending, (state) => {
        state.completeStatus = "submitting";
        state.completeError = null;
      })
      .addCase(completeSetup.fulfilled, (state) => {
        state.completeStatus = "idle";
        state.completed = true;
      })
      .addCase(completeSetup.rejected, (state, action) => {
        state.completeStatus = "error";
        state.completeError = action.payload ?? "Impossible de finaliser la configuration.";
      });
  },
});

export const {
  setCurrentStep,
  updateLdapForm,
  addGroupRoleEntry,
  updateGroupRoleEntry,
  removeGroupRoleEntry,
  markDockerSkipped,
  updateKubeconfig,
  markKubernetesSkipped,
  updateNutanixForm,
  markNutanixSkipped,
  addRegistryDraft,
  updateRegistryDraft,
  removeRegistryDraft,
  markRegistrySkipped,
} = setupSlice.actions;

export default setupSlice.reducer;
