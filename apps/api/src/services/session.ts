/**
 * Émission et vérification du JWT de session posé en cookie httpOnly/secure/sameSite=strict.
 * Contient username + roles + expiration courte (JWT_EXPIRES_IN).
 *
 * Pas de flux de refresh token : une session expirée force simplement une reconnexion LDAP
 * (POST /api/auth/login). Une fonction `signRefreshToken`/un champ de config
 * `jwtRefreshExpiresIn` existaient ici mais n'étaient appelés/lus par aucune route ni aucun
 * flux (recherche exhaustive apps/api + apps/web) — code mort supprimé le 12/08/2026, voir
 * docs/reports/security-audit-2026-08-12.md, finding I3.
 */

import jwt from "jsonwebtoken";
import { config } from "../config.js";
import type { Session } from "../types.js";

export interface SessionTokenPayload {
  username: string;
  displayName: string;
  roles: Session["roles"];
}

// config.session.jwtExpiresIn is read from the environment as a plain string (see
// src/config.ts); jsonwebtoken's SignOptions["expiresIn"] type only accepts a narrower
// `StringValue` pattern type or a number of seconds, so we cast at the boundary.
type ExpiresIn = NonNullable<jwt.SignOptions["expiresIn"]>;

export function signSessionToken(payload: SessionTokenPayload): string {
  return jwt.sign(payload, config.session.jwtSecret, { expiresIn: config.session.jwtExpiresIn as ExpiresIn });
}

export function verifySessionToken(token: string): SessionTokenPayload {
  const decoded = jwt.verify(token, config.session.jwtSecret);
  if (typeof decoded === "string") {
    throw new Error("Unexpected session token payload");
  }
  const { username, displayName, roles } = decoded as Partial<SessionTokenPayload>;
  if (typeof username !== "string" || typeof displayName !== "string" || !Array.isArray(roles)) {
    throw new Error("Malformed session token payload");
  }
  return { username, displayName, roles: roles as Session["roles"] };
}

export function toSession(payload: SessionTokenPayload): Session {
  return { username: payload.username, displayName: payload.displayName, roles: payload.roles };
}
