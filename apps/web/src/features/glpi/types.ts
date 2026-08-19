// Types locaux de l'intégration GLPI — copie fidèle des formes renvoyées par
// apps/api/src/routes/glpi.ts et routes/glpiInventory.ts. Rien n'est ajouté à src/types.ts.

export type GlpiAuthMode = "user-token" | "credentials";

/** Rapprochement du login QUAI avec un compte GLPI — 0 ou >1 correspondance est signalé tel quel. */
export type GlpiAccountMatch = "found" | "not-found" | "ambiguous";

export interface GlpiPollOutcome {
  reachable: boolean;
  at: string;
}

export interface GlpiStatus {
  configured: boolean;
  reachable?: boolean;
  apiUrl?: string;
  authMode?: GlpiAuthMode;
  serviceAccount?: string;
  lastPoll?: GlpiPollOutcome;
}

export interface GlpiTicketSummary {
  id: number;
  /** Code de statut GLPI brut (1..6), tel que renvoyé — jamais réinterprété. */
  status?: number;
  statusLabel?: string;
  title: string;
  openedAt?: string;
  updatedAt?: string;
}

export interface GlpiFollowup {
  id: number;
  content: string;
  date?: string;
  authorId?: number;
  isPrivate?: boolean;
}

export interface GlpiTicketDetail extends GlpiTicketSummary {
  content: string;
  solvedAt?: string;
  closedAt?: string;
  followups: GlpiFollowup[];
}

export interface GlpiMyTickets {
  configured: boolean;
  reachable?: boolean;
  account?: GlpiAccountMatch;
  candidateCount?: number;
  tickets: GlpiTicketSummary[];
  error?: string;
}

/** Config REDACTÉE renvoyée par GET /api/glpi/config : uniquement des booléens de présence. */
export interface GlpiPublicConfig {
  apiUrl: string;
  authMode: GlpiAuthMode;
  username?: string;
  hasAppToken: boolean;
  hasUserToken: boolean;
  hasPassword: boolean;
}

export interface GlpiConfigStatus {
  configured: boolean;
  config?: GlpiPublicConfig;
}

export interface GlpiTestResult {
  ok: boolean;
  message: string;
}

/** Une entrée de GET /api/glpi/search-options, ramenée à ce qui sert à confirmer un numéro. */
export interface GlpiSearchOption {
  option: string;
  name?: string;
  uid?: string;
  table?: string;
  field?: string;
}

// --- Réconciliation d'inventaire (CMDB) ---

export type GlpiInventoryField =
  | "name"
  | "uuid"
  | "serial"
  | "vcpu"
  | "memoryMib"
  | "ipAddresses"
  | "operatingSystem"
  | "host";

export type GlpiInventoryValue = string | number | string[];

export interface GlpiFieldDifference {
  field: GlpiInventoryField;
  glpiValue: GlpiInventoryValue;
  realValue: GlpiInventoryValue;
  /** Le backend décide seul de ce qui est corrigeable — l'interface ne le suppose jamais. */
  fixable: boolean;
  reason?: string;
}

export interface GlpiFieldAbsence {
  field: GlpiInventoryField;
  missingOn: "glpi" | "real" | "both";
}

export type GlpiRealResourceKind = "nutanix-vm" | "nutanix-host";

export interface GlpiRealResource {
  kind: GlpiRealResourceKind;
  id: string;
  name: string;
  uuid?: string;
  serial?: string;
  vcpu?: number;
  memoryMib?: number;
  ipAddresses?: string[];
  operatingSystem?: string;
  cluster?: string;
  hostName?: string;
}

export interface GlpiComputerRecord {
  id: number;
  name: string;
  uuid?: string;
  serial?: string;
  comment?: string;
  vcpu?: number;
  memoryMib?: number;
  ipAddresses?: string[];
  operatingSystem?: string;
  virtualizationHost?: string;
}

export type GlpiMatchKey = "uuid" | "serial" | "name";

export interface GlpiMatchedPair {
  resource: GlpiRealResource;
  glpi: GlpiComputerRecord;
  matchedBy: GlpiMatchKey;
  differences: GlpiFieldDifference[];
  absences: GlpiFieldAbsence[];
}

export interface GlpiAmbiguousItem {
  resource?: GlpiRealResource;
  glpiCandidates: Array<{ id: number; name: string; uuid?: string }>;
  reason: string;
}

export type GlpiStaleScopeReason = "provenance-marker" | "glpi-virtual-machine-of-nutanix-host";

export interface GlpiStaleRecord {
  glpi: GlpiComputerRecord;
  scopeReason: GlpiStaleScopeReason;
  detail: string;
}

export type GlpiEnrichmentState = "ok" | "unavailable" | "skipped";

export interface GlpiInventoryCounts {
  real: number;
  glpiComputers: number;
  matched: number;
  inSync: number;
  drifted: number;
  missingInGlpi: number;
  staleInGlpi: number;
  ambiguous: number;
  outOfScopeGlpi: number;
}

export interface GlpiInventoryDiff {
  generatedAt: string;
  glpi: { configured: boolean; reachable: boolean; computerCount: number; error?: string };
  nutanix: { configured: boolean; reachable: boolean; resourceCount: number };
  enrichment: {
    virtualMachines: GlpiEnrichmentState;
    ipAddresses: GlpiEnrichmentState;
    operatingSystems: GlpiEnrichmentState;
  };
  counts: GlpiInventoryCounts;
  /** false = les deux inventaires n'ont pas pu être lus : aucune conclusion, listes non probantes. */
  conclusive: boolean;
  missingInGlpi: GlpiRealResource[];
  drifted: GlpiMatchedPair[];
  inSync: GlpiMatchedPair[];
  staleInGlpi: GlpiStaleRecord[];
  ambiguous: GlpiAmbiguousItem[];
  outOfScopeGlpiCount: number;
}

export interface GlpiCreateComputerOutcome {
  ok: true;
  computerId: number;
  resource: GlpiRealResource;
}

export interface GlpiUpdateComputerOutcome {
  ok: true;
  computerId: number;
  appliedFields: GlpiInventoryField[];
  skippedFields: GlpiFieldDifference[];
}

/** Corps de PUT /api/glpi/config — un secret vide est OMIS : côté serveur, absent = conserver. */
export interface GlpiConfigFormInput {
  apiUrl: string;
  appToken?: string;
  userToken?: string;
  username?: string;
  password?: string;
}
