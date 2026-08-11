import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { apiGet } from "@/api/client";
import type { AuditEvent } from "@/types";

interface AuditState {
  items: AuditEvent[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
}

const initialState: AuditState = { items: [], status: "idle", error: null };

export const fetchAuditLog = createAsyncThunk<AuditEvent[]>("audit/fetch", async () =>
  apiGet<AuditEvent[]>("/audit"),
);

const auditSlice = createSlice({
  name: "audit",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchAuditLog.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchAuditLog.fulfilled, (state, action) => {
        state.status = "ready";
        state.items = action.payload;
      })
      .addCase(fetchAuditLog.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Impossible de charger le journal d'audit.";
      });
  },
});

export default auditSlice.reducer;
