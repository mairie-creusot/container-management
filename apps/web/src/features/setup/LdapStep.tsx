import { useAppDispatch, useAppSelector } from "@/hooks";
import {
  addGroupRoleEntry,
  removeGroupRoleEntry,
  testLdap,
  updateGroupRoleEntry,
  updateLdapForm,
} from "@/features/setup/setupSlice";
import StatusPill from "@/components/StatusPill";
import KeyValueList from "@/components/KeyValueList";
import { IconPlus } from "@/components/icons";
import type { Role } from "@/types";

const ROLES: { id: Role; label: string }[] = [
  { id: "admin", label: "admin" },
  { id: "operator", label: "operator" },
  { id: "viewer", label: "viewer" },
];

export default function LdapStep() {
  const dispatch = useAppDispatch();
  const ldap = useAppSelector((s) => s.setup.ldap);

  const requiredFilled =
    ldap.url.trim() !== "" &&
    ldap.bindDn.trim() !== "" &&
    ldap.bindPassword.trim() !== "" &&
    ldap.searchBase.trim() !== "" &&
    ldap.searchFilter.trim() !== "";

  return (
    <div>
      <div className="setup-step-title">Annuaire LDAP</div>
      <p className="setup-step-subtitle">
        Mécanisme d'authentification principal — cette étape est obligatoire et doit être testée
        avec succès pour continuer.
      </p>

      <div className="setup-form-grid" style={{ marginTop: 14 }}>
        <div className="field">
          <label htmlFor="ldap-url">URL de l'annuaire</label>
          <input
            id="ldap-url"
            value={ldap.url}
            onChange={(e) => dispatch(updateLdapForm({ url: e.target.value }))}
            placeholder="ldaps://annuaire.lecreusot.fr:636"
          />
        </div>
        <div className="field">
          <label htmlFor="ldap-bind-dn">Bind DN</label>
          <input
            id="ldap-bind-dn"
            value={ldap.bindDn}
            onChange={(e) => dispatch(updateLdapForm({ bindDn: e.target.value }))}
            placeholder="cn=quai-svc,ou=services,dc=lecreusot,dc=fr"
          />
        </div>
        <div className="field">
          <label htmlFor="ldap-bind-password">Mot de passe</label>
          <input
            id="ldap-bind-password"
            type="password"
            value={ldap.bindPassword}
            onChange={(e) => dispatch(updateLdapForm({ bindPassword: e.target.value }))}
          />
        </div>
        <div className="field">
          <label htmlFor="ldap-search-base">Base de recherche</label>
          <input
            id="ldap-search-base"
            value={ldap.searchBase}
            onChange={(e) => dispatch(updateLdapForm({ searchBase: e.target.value }))}
            placeholder="ou=utilisateurs,dc=lecreusot,dc=fr"
          />
        </div>
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label htmlFor="ldap-search-filter">Filtre de recherche</label>
          <input
            id="ldap-search-filter"
            value={ldap.searchFilter}
            onChange={(e) => dispatch(updateLdapForm({ searchFilter: e.target.value }))}
            placeholder="(uid={{username}})"
          />
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <div className="setup-block__head">
          <span className="setup-block__title">Mapping groupe LDAP → rôle</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => dispatch(addGroupRoleEntry())}>
            <IconPlus /> Ajouter un mapping
          </button>
        </div>

        <p style={{ fontSize: 11.5, color: "var(--color-text-faint)", marginTop: 4, marginBottom: 8 }}>
          Chaque ligne accepte soit le DN d'un groupe de sécurité (memberOf), soit une unité
          d'organisation (OU) du DN de l'utilisateur — ex :{" "}
          <code>OU=Informatique,OU=ville-du-Creusot,DC=lecreusot,DC=priv</code> rendra admin
          tous les comptes situés dans cette OU, sans avoir à créer un groupe dédié.
        </p>

        {ldap.groupRoleEntries.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--color-text-faint)", marginTop: 8 }}>
            Aucun mapping — tous les utilisateurs authentifiés seront `viewer` par défaut.
          </p>
        )}

        <div className="repeatable-list" style={{ marginTop: 8 }}>
          {ldap.groupRoleEntries.map((entry) => (
            <div className="repeatable-row" key={entry.id}>
              <input
                value={entry.ldapGroup}
                onChange={(e) =>
                  dispatch(updateGroupRoleEntry({ id: entry.id, ldapGroup: e.target.value }))
                }
                placeholder="cn=dsi-admins,ou=groupes,dc=lecreusot,dc=fr"
              />
              <select
                value={entry.role}
                onChange={(e) =>
                  dispatch(updateGroupRoleEntry({ id: entry.id, role: e.target.value as Role }))
                }
              >
                {ROLES.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => dispatch(removeGroupRoleEntry(entry.id))}
              >
                Retirer
              </button>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!requiredFilled || ldap.test === "testing"}
            onClick={() => dispatch(testLdap())}
          >
            {ldap.test === "testing" ? "Test en cours…" : "Tester la connexion"}
          </button>
          {ldap.test === "ok" && <StatusPill status="connected" label="Connexion validée" />}
          {ldap.test === "error" && <StatusPill status="error" />}
        </div>

        {ldap.test === "error" && ldap.message && <div className="error-banner">{ldap.message}</div>}

        {ldap.test === "ok" && (
          <div className="setup-success-banner">
            {ldap.message ?? "Connexion à l'annuaire réussie."}
          </div>
        )}

        {ldap.test === "ok" && (ldap.resolvedGroups !== null || ldap.testUserDn !== null) && (
          <KeyValueList
            rows={[
              ...(ldap.testUserDn !== null ? [{ key: "DN utilisateur test", value: ldap.testUserDn }] : []),
              ...(ldap.resolvedGroups !== null
                ? [{ key: "Groupes résolus", value: String(ldap.resolvedGroups) }]
                : []),
            ]}
          />
        )}

        {ldap.test !== "ok" && (
          <p style={{ fontSize: 11.5, color: "var(--color-text-faint)" }}>
            Le passage à l'étape suivante nécessite un test de connexion réussi.
          </p>
        )}
      </div>
    </div>
  );
}
