/**
 * Types du PBX 3CX, LOCAUX à la feature (rien n'est ajouté à src/types.ts). Miroir strict des
 * formes réellement renvoyées par apps/api/src/routes/threecx.ts et services/threecx.ts.
 */

export type ThreecxLoadStatus = "idle" | "loading" | "ready" | "error";

/** Interlocuteur d'un appel — dérivé côté API de Pbx.ActiveCall.Caller/Callee. */
export interface ThreecxCallParticipant {
  /** Chaîne BRUTE du PBX (pas forcément un numéro nu). */
  number: string;
  direction: "caller" | "callee";
  /** DisplayName du poste dont le numéro correspond EXACTEMENT — absent sinon. */
  name?: string;
}

export interface ThreecxActiveCall {
  id: string;
  /** Absent tant que l'appel n'est pas établi (sonnerie). */
  startedAt?: string;
  participants: ThreecxCallParticipant[];
  /** Calculée par le PBX (ServerNow - EstablishedAt) au moment de la réponse. */
  durationSeconds?: number;
  /** Chaîne libre du XAPI — affichée telle quelle. */
  status?: string;
  lastChangeAt?: string;
}

export interface ThreecxExtension {
  id: number;
  number: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  /** IsRegistered — un poste enregistré est joignable. */
  registered?: boolean;
  enabled?: boolean;
  internal?: boolean;
  /** Profil de présence courant (libellé libre du PBX). */
  currentProfileName?: string;
  /** "LoggedIn" | "LoggedOut" côté XAPI, chaîne libre ici. */
  queueStatus?: string;
}

export interface ThreecxQueue {
  id: number;
  number: string;
  name?: string;
  registered?: boolean;
  pollingStrategy?: string;
  maxCallersInQueue?: number;
}

export interface ThreecxSystemStatus {
  version?: string;
  fqdn?: string;
  activated?: boolean;
  callsActive?: number;
  maxSimCalls?: number;
  extensionsRegistered?: number;
  extensionsTotal?: number;
  trunksRegistered?: number;
  trunksTotal?: number;
}

export interface ThreecxPollOutcome {
  reachable: boolean;
  at: string;
}

export interface ThreecxStatusSummary {
  configured: boolean;
  reachable?: boolean;
  /** Message BRUT du PBX quand il répond mais refuse le XAPI (licence Enterprise, droits). */
  accessError?: string;
  activeCallCount?: number;
  extensionCount?: number;
  reachableExtensionCount?: number;
  queueCount?: number;
  system?: ThreecxSystemStatus;
  lastPoll?: ThreecxPollOutcome;
}

/** Enveloppe d'accès commune aux trois routes de lecture. */
export interface ThreecxAccess {
  configured: boolean;
  reachable?: boolean;
  accessError?: string;
}

/** Les quatre états que le backend distingue, plus "en attente d'une réponse". */
export type ThreecxAccessState = "unconfigured" | "unreachable" | "denied" | "ok" | "unknown";

/** Liste + son enveloppe : une liste vide n'a de sens que si l'état d'accès est "ok". */
export interface ThreecxListState<T> {
  access: ThreecxAccess;
  items: T[];
  load: ThreecxLoadStatus;
  error: string | null;
}

/** Config publique : la clé API n'en fait JAMAIS partie (l'API ne la renvoie pas, même tronquée). */
export interface ThreecxPublicConfig {
  baseUrl: string;
  clientId: string;
  tlsRejectUnauthorized?: boolean;
}

export interface ThreecxConfigStatus {
  configured: boolean;
  config?: ThreecxPublicConfig;
}

export interface ThreecxTestResult {
  ok: boolean;
  message: string;
  activeCallCount?: number;
}
