import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiGet, apiPost, ApiError } from "@/api/client";
import type { Session } from "@/types";

interface AuthState {
  session: Session | null;
  status: "idle" | "checking" | "authenticating" | "ready" | "error";
  error: string | null;
}

const initialState: AuthState = {
  session: null,
  status: "idle",
  error: null,
};

// Lit la session courante au démarrage de l'app (cookie httpOnly déjà posé
// par une session précédente, le cas échéant).
export const fetchSession = createAsyncThunk<Session | null>(
  "auth/fetchSession",
  async () => {
    try {
      return await apiGet<Session>("/session");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        return null;
      }
      throw error;
    }
  },
);

export const login = createAsyncThunk<
  Session,
  { username: string; password: string },
  { rejectValue: string }
>("auth/login", async (credentials, { rejectWithValue }) => {
  try {
    return await apiPost<Session>("/auth/login", credentials);
  } catch (error) {
    const message =
      error instanceof ApiError ? error.message : "Connexion impossible. Réessayez.";
    return rejectWithValue(message);
  }
});

export const logout = createAsyncThunk("auth/logout", async () => {
  await apiPost<void>("/auth/logout");
});

const authSlice = createSlice({
  name: "auth",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchSession.pending, (state) => {
        state.status = "checking";
      })
      .addCase(fetchSession.fulfilled, (state, action) => {
        state.session = action.payload;
        state.status = "ready";
      })
      .addCase(fetchSession.rejected, (state) => {
        state.session = null;
        state.status = "ready";
      })
      .addCase(login.pending, (state) => {
        state.status = "authenticating";
        state.error = null;
      })
      .addCase(login.fulfilled, (state, action) => {
        state.session = action.payload;
        state.status = "ready";
      })
      .addCase(login.rejected, (state, action) => {
        state.status = "ready";
        state.error = action.payload ?? "Identifiants invalides.";
      })
      .addCase(logout.fulfilled, (state) => {
        state.session = null;
      });
  },
});

export default authSlice.reducer;

export function hasRole(session: Session | null, ...roles: Session["roles"]): boolean {
  if (!session) return false;
  return session.roles.some((role) => roles.includes(role));
}

export function canOperate(session: Session | null): boolean {
  return hasRole(session, "operator", "admin");
}

export function canAdminister(session: Session | null): boolean {
  return hasRole(session, "admin");
}
