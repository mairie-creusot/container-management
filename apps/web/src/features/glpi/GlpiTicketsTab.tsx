import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { canOperate } from "@/features/auth/authSlice";
import { accountLabel, canBrowseOtherAccounts, glpiPagerState } from "@/features/glpi/browse";
import StatusPill from "@/components/StatusPill";
import DataTable, { type DataTableColumn } from "@/components/DataTable";
import { IconInfo, IconSearch } from "@/components/icons";
import {
  addGlpiFollowup,
  fetchGlpiAccounts,
  fetchGlpiBrowseTickets,
  fetchGlpiMyTickets,
  fetchGlpiTicket,
  selectGlpiState,
  selectGlpiTicket,
  setGlpiAccountQuery,
  setGlpiBrowseOffset,
  setGlpiBrowseTarget,
  TICKETS_PAGE_SIZE,
} from "@/features/glpi/glpiSlice";
import { MISSING, formatDateTime, htmlToText, ticketPill } from "@/features/glpi/format";
import type { GlpiAccount, GlpiTicketDetail, GlpiTicketSummary } from "@/features/glpi/types";

function FollowupList({ ticket }: { ticket: GlpiTicketDetail }) {
  if (ticket.followups.length === 0) {
    return <p className="glpi-note">Aucun suivi sur ce ticket pour l'instant.</p>;
  }
  return (
    <div className="glpi-followups">
      {ticket.followups.map((followup) => (
        <div key={followup.id} className="glpi-followup">
          <div className="glpi-followup__head">
            <span>{formatDateTime(followup.date)}</span>
            {followup.authorId !== undefined && <span>Auteur GLPI #{followup.authorId}</span>}
            {followup.isPrivate && <span className="glpi-followup__private">Suivi privé</span>}
          </div>
          <p className="glpi-followup__body">{htmlToText(followup.content) || MISSING}</p>
        </div>
      ))}
    </div>
  );
}

function TicketDetail({ foreign }: { foreign: boolean }) {
  const dispatch = useAppDispatch();
  const { selectedTicketId, ticket, ticketLoad, ticketError, ticketNotFound, followupSaving, followupError } =
    useAppSelector(selectGlpiState);
  const session = useAppSelector((s) => s.auth.session);
  const operator = canOperate(session);
  const [comment, setComment] = useState("");

  useEffect(() => {
    setComment("");
  }, [selectedTicketId]);

  if (selectedTicketId === null) {
    return (
      <div className="glpi-detail glpi-detail--empty">
        <IconInfo />
        <span>Sélectionnez un ticket pour afficher son contenu et ses suivis.</span>
      </div>
    );
  }

  if (ticketLoad === "loading" && !ticket) {
    return <div className="glpi-detail glpi-detail--empty">Chargement du ticket {selectedTicketId}…</div>;
  }

  if (ticketNotFound) {
    return (
      <div className="glpi-detail glpi-detail--empty">
        <strong>Ticket {selectedTicketId} indisponible</strong>
        <span>
          {foreign
            ? "GLPI ne renvoie pas ce ticket : il n'existe pas, ou le compte de service QUAI n'y a pas accès dans cette entité."
            : "GLPI ne renvoie ce ticket qu'à son demandeur. Il n'existe pas, ou votre compte GLPI n'en est pas demandeur."}
        </span>
      </div>
    );
  }

  if (ticketError) {
    return <div className="error-banner">{ticketError}</div>;
  }

  if (!ticket) return null;

  const pill = ticketPill(ticket);
  const body = htmlToText(ticket.content);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const content = comment.trim();
    if (!content || selectedTicketId === null) return;
    const result = await dispatch(addGlpiFollowup({ ticketId: selectedTicketId, content }));
    if (addGlpiFollowup.fulfilled.match(result)) {
      setComment("");
      dispatch(fetchGlpiTicket({ id: selectedTicketId }));
      dispatch(fetchGlpiMyTickets());
    }
  }

  return (
    <div className="glpi-detail">
      <div className="glpi-detail__head">
        <div>
          <h3 className="glpi-detail__title">
            #{ticket.id} — {ticket.title}
          </h3>
          <span className="glpi-detail__meta">
            Ouvert le {formatDateTime(ticket.openedAt)} · mis à jour le {formatDateTime(ticket.updatedAt)}
            {ticket.solvedAt ? ` · résolu le ${formatDateTime(ticket.solvedAt)}` : ""}
            {ticket.closedAt ? ` · clos le ${formatDateTime(ticket.closedAt)}` : ""}
            {ticket.requesterIds?.length ? ` · demandeur GLPI #${ticket.requesterIds.join(", #")}` : ""}
          </span>
        </div>
        <StatusPill status={pill.status} label={pill.label} />
      </div>

      <p className="glpi-detail__body">{body || "Ce ticket n'a pas de description."}</p>

      <h4 className="glpi-section-title">Suivis</h4>
      <FollowupList ticket={ticket} />

      {followupError && <div className="error-banner">{followupError}</div>}

      {foreign ? (
        <p className="glpi-note">
          Vous consultez le ticket de quelqu'un d'autre : cette vue est en lecture seule. GLPI n'accepte un suivi
          que de la part d'un demandeur du ticket.
        </p>
      ) : operator ? (
        <form className="glpi-comment" onSubmit={handleSubmit}>
          <label htmlFor="glpi-comment">Ajouter un commentaire</label>
          <textarea
            id="glpi-comment"
            rows={4}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="Votre message sera ajouté au ticket comme suivi, à votre nom."
            disabled={followupSaving}
          />
          <div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={followupSaving || !comment.trim()}>
              {followupSaving ? "Envoi…" : "Ajouter le commentaire"}
            </button>
          </div>
        </form>
      ) : (
        <p className="glpi-note">
          Votre rôle QUAI ne permet pas d'écrire dans GLPI : l'ajout d'un suivi est réservé aux rôles opérateur et
          administrateur.
        </p>
      )}
    </div>
  );
}

/** Recherche d'un compte GLPI par identifiant, avec le nom réel renvoyé par l'instance. */
function AccountPicker() {
  const dispatch = useAppDispatch();
  const { accountQuery, accounts, accountsLoad, accountsError } = useAppSelector(selectGlpiState);

  useEffect(() => {
    const timer = setTimeout(() => {
      void dispatch(fetchGlpiAccounts({ query: accountQuery }));
    }, 300);
    return () => clearTimeout(timer);
  }, [dispatch, accountQuery]);

  return (
    <div className="glpi-account-picker">
      <label className="glpi-account-picker__field">
        <IconSearch />
        <input
          type="search"
          value={accountQuery}
          onChange={(event) => dispatch(setGlpiAccountQuery(event.target.value))}
          placeholder="Identifiant GLPI (ex : ybanas) — laisser vide pour parcourir les comptes"
          aria-label="Rechercher un compte GLPI par identifiant"
        />
      </label>

      {accountsError && <div className="error-banner">{accountsError}</div>}

      {!accountsError && accountsLoad === "loading" && !accounts && (
        <p className="glpi-note">Recherche des comptes dans GLPI…</p>
      )}

      {!accountsError && accounts && accounts.users.length === 0 && (
        <p className="glpi-note">
          Aucun compte GLPI ne correspond à cette recherche. QUAI n'affiche que ce que l'instance renvoie
          réellement, il ne propose jamais un compte approchant.
        </p>
      )}

      {!accountsError && accounts && accounts.users.length > 0 && (
        <>
          <ul className="glpi-account-list">
            {accounts.users.map((account) => (
              <li key={account.id}>
                <button
                  type="button"
                  className="glpi-account"
                  onClick={() => dispatch(setGlpiBrowseTarget({ scope: "requester", account }))}
                >
                  <span className="glpi-account__name">{account.displayName}</span>
                  <span className="glpi-account__login">{account.login}</span>
                  {account.active === false && <span className="glpi-account__inactive">Compte désactivé</span>}
                </button>
              </li>
            ))}
          </ul>
          <p className="glpi-note">
            {accounts.total !== undefined
              ? `Comptes ${accounts.offset + 1} à ${accounts.offset + accounts.users.length} sur ${accounts.total.toLocaleString("fr-FR")}.`
              : `${accounts.users.length} compte(s) affiché(s) — GLPI n'a pas communiqué de total.`}{" "}
            Affinez la recherche par identifiant pour réduire la liste.
          </p>
        </>
      )}
    </div>
  );
}

/** Pagination CÔTÉ GLPI : la page affichée est celle que l'instance a réellement renvoyée. */
function ServerPager({
  offset,
  limit,
  count,
  total,
  loading,
  onOffset,
}: {
  offset: number;
  limit: number;
  count: number;
  total?: number | undefined;
  loading: boolean;
  onOffset: (offset: number) => void;
}) {
  const pager = glpiPagerState({ offset, limit, count, total });
  return (
    <div className="glpi-pager">
      <span className="glpi-pager__range">{pager.label}</span>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={!pager.hasPrevious || loading}
        onClick={() => onOffset(pager.previousOffset)}
      >
        Page précédente
      </button>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={!pager.hasNext || loading}
        onClick={() => onOffset(pager.nextOffset)}
      >
        Page suivante
      </button>
    </div>
  );
}

function TicketsTable({
  tickets,
  loading,
  showRequester,
  storageKey,
  emptyLabel,
  itemsLabel,
  toolbarExtra,
}: {
  tickets: GlpiTicketSummary[];
  loading: boolean;
  showRequester: boolean;
  storageKey: string;
  emptyLabel: string;
  itemsLabel: string;
  toolbarExtra?: ReactNode;
}) {
  const dispatch = useAppDispatch();
  const { selectedTicketId, browseScope } = useAppSelector(selectGlpiState);
  const browse = browseScope !== null;

  const columns = useMemo<DataTableColumn<GlpiTicketSummary>[]>(() => {
    const list: DataTableColumn<GlpiTicketSummary>[] = [
      {
        key: "numero",
        label: "N°",
        accessor: (t) => t.id,
        kind: "number",
        aliases: ["id"],
        className: "cell-mono",
        width: "88px",
        render: (t) => `#${t.id}`,
      },
      {
        key: "statut",
        label: "Statut",
        accessor: (t) => t.statusLabel ?? (t.status !== undefined ? `Statut GLPI ${t.status}` : ""),
        width: "170px",
        render: (t) => {
          const pill = ticketPill(t);
          return <StatusPill status={pill.status} label={pill.label} />;
        },
      },
      { key: "titre", label: "Titre", accessor: (t) => t.title, className: "cell-primary" },
    ];
    if (showRequester) {
      list.push({ key: "demandeur", label: "Demandeur", accessor: (t) => t.requesterLabel ?? "" });
    }
    list.push(
      { key: "ouverture", label: "Ouvert le", accessor: (t) => t.openedAt ?? "", kind: "date", render: (t) => formatDateTime(t.openedAt) },
      { key: "maj", label: "Mis à jour le", accessor: (t) => t.updatedAt ?? "", kind: "date", render: (t) => formatDateTime(t.updatedAt) },
    );
    return list;
  }, [showRequester]);

  return (
    <DataTable
      rows={tickets}
      columns={columns}
      rowKey={(t) => String(t.id)}
      loading={loading}
      storageKey={storageKey}
      itemsLabel={itemsLabel}
      defaultSort={{ key: "maj", direction: "desc" }}
      emptyLabel={emptyLabel}
      noResultsLabel="Aucun ticket de cette page ne correspond à la recherche."
      searchPlaceholder="Rechercher…  (ex : statut:résolu titre:imprimante)"
      onRowClick={(ticket) => {
        dispatch(selectGlpiTicket(ticket.id));
        void dispatch(fetchGlpiTicket({ id: ticket.id, browse }));
      }}
      isRowSelected={(ticket) => ticket.id === selectedTicketId}
      {...(toolbarExtra ? { toolbarExtra } : {})}
    />
  );
}

/** Sélecteur de périmètre — visible UNIQUEMENT pour operator/admin, seuls rôles autorisés côté
 * backend à lire les tickets d'autrui (/api/glpi/browse/*). */
function ScopeBar() {
  const dispatch = useAppDispatch();
  const { browseScope, browseAccount } = useAppSelector(selectGlpiState);
  return (
    <div className="glpi-scope">
      <span className="glpi-scope__label">Périmètre</span>
      {/* Re-cliquer un périmètre déjà actif ne relance rien : la liste resterait en chargement. */}
      <button
        type="button"
        className={`glpi-scope__btn${browseScope === null ? " is-active" : ""}`}
        onClick={() => browseScope !== null && dispatch(setGlpiBrowseTarget(null))}
      >
        Mes tickets
      </button>
      <button
        type="button"
        className={`glpi-scope__btn${browseScope === "requester" ? " is-active" : ""}`}
        onClick={() => dispatch(setGlpiBrowseTarget({ scope: "requester" }))}
      >
        {browseScope === "requester" && browseAccount ? `Compte : ${browseAccount.login}` : "Un compte GLPI…"}
      </button>
      <button
        type="button"
        className={`glpi-scope__btn${browseScope === "all" ? " is-active" : ""}`}
        onClick={() => browseScope !== "all" && dispatch(setGlpiBrowseTarget({ scope: "all" }))}
      >
        Tous les tickets
      </button>
    </div>
  );
}

/** Rappel visuel permanent : on ne regarde PAS ses propres tickets. */
function ForeignBanner({ account }: { account: GlpiAccount | null }) {
  return (
    <div className="glpi-foreign">
      <strong className="glpi-foreign__title">
        {account
          ? `Vous consultez les tickets de ${accountLabel(account)}`
          : "Vous consultez tous les tickets de l'instance GLPI"}
      </strong>
      <span className="glpi-foreign__text">
        Ces tickets ne sont pas les vôtres. Cette vue est en LECTURE SEULE et chaque consultation est inscrite au
        journal d'audit de QUAI sous votre nom.
      </span>
    </div>
  );
}

function MyTicketsView() {
  const dispatch = useAppDispatch();
  const { myTickets, ticketsLoad, ticketsError } = useAppSelector(selectGlpiState);
  const session = useAppSelector((s) => s.auth.session);
  const login = session?.username ?? "votre identifiant";

  useEffect(() => {
    if (ticketsLoad === "idle") void dispatch(fetchGlpiMyTickets());
  }, [dispatch, ticketsLoad]);

  if (ticketsError) return <div className="error-banner">{ticketsError}</div>;
  if (ticketsLoad === "loading" && !myTickets) return <div className="empty-state">Lecture de vos tickets GLPI…</div>;
  if (!myTickets) return null;

  if (!myTickets.configured) {
    return (
      <div className="empty-state">
        <IconInfo />
        <strong>GLPI n'est pas configuré</strong>
        <span>Aucun ticket ne peut être lu tant que l'accès à l'API GLPI n'est pas renseigné.</span>
      </div>
    );
  }

  if (myTickets.reachable === false) {
    return (
      <div className="error-banner">
        GLPI est configuré mais n'a pas répondu : aucun ticket n'est affiché plutôt qu'une liste vide trompeuse.
        {myTickets.error ? ` Détail renvoyé par l'API : ${myTickets.error}` : ""}
      </div>
    );
  }

  if (myTickets.account === "not-found") {
    return (
      <div className="empty-state">
        <IconInfo />
        <strong>Aucun compte GLPI ne correspond à votre login QUAI</strong>
        <span>
          QUAI cherche dans GLPI un utilisateur dont l'identifiant de connexion vaut exactement «&nbsp;{login}&nbsp;»
          et n'en trouve aucun. Il ne choisit jamais un compte approchant : demandez à l'administration GLPI de
          créer ce compte ou d'aligner son identifiant sur celui de l'annuaire.
        </span>
      </div>
    );
  }

  if (myTickets.account === "ambiguous") {
    return (
      <div className="empty-state">
        <IconInfo />
        <strong>Plusieurs comptes GLPI portent votre login</strong>
        <span>
          {myTickets.candidateCount !== undefined ? `${myTickets.candidateCount} comptes GLPI ` : "Plusieurs comptes GLPI "}
          ont «&nbsp;{login}&nbsp;» comme identifiant de connexion. QUAI refuse d'en choisir un : tant que le doublon
          existe côté GLPI, aucun ticket ne peut être attribué avec certitude.
        </span>
      </div>
    );
  }

  if (myTickets.account === undefined) {
    return (
      <div className="empty-state">
        <IconInfo />
        <strong>Rapprochement de compte non communiqué</strong>
        <span>
          L'API n'a pas indiqué si votre login QUAI correspond à un compte GLPI : rien n'est affiché plutôt qu'une
          liste dont on ignore à qui elle appartient.
        </span>
      </div>
    );
  }

  return (
    <div className="glpi-split glpi-split--wide">
      <TicketsTable
        tickets={myTickets.tickets}
        loading={ticketsLoad === "loading"}
        showRequester={false}
        storageKey="glpi-my-tickets"
        itemsLabel="tickets"
        emptyLabel="Votre compte GLPI a bien été trouvé, mais aucun ticket ne vous a pour demandeur."
      />
      <TicketDetail foreign={false} />
    </div>
  );
}

function BrowseView() {
  const dispatch = useAppDispatch();
  const { browseScope, browseAccount, browseOffset, browseTickets, browseLoad, browseError } =
    useAppSelector(selectGlpiState);

  const requesterId = browseAccount?.id;
  const ready = browseScope === "all" || requesterId !== undefined;

  useEffect(() => {
    if (!ready) return;
    void dispatch(
      fetchGlpiBrowseTickets({
        ...(requesterId !== undefined ? { requesterId } : {}),
        offset: browseOffset,
        limit: TICKETS_PAGE_SIZE,
      }),
    );
  }, [dispatch, ready, requesterId, browseOffset]);

  if (browseScope === "requester" && !browseAccount) {
    return (
      <>
        <p className="glpi-note">
          Choisissez le compte GLPI dont vous voulez consulter les tickets. La recherche porte sur l'identifiant de
          connexion GLPI ; le nom affiché est celui enregistré dans l'instance.
        </p>
        <AccountPicker />
      </>
    );
  }

  const pager = browseTickets ? (
    <ServerPager
      offset={browseTickets.offset}
      limit={browseTickets.limit}
      count={browseTickets.tickets.length}
      total={browseTickets.total}
      loading={browseLoad === "loading"}
      onOffset={(offset) => dispatch(setGlpiBrowseOffset(offset))}
    />
  ) : undefined;

  return (
    <>
      <ForeignBanner account={browseAccount} />

      {browseScope === "requester" && (
        <div className="glpi-foreign__actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => dispatch(setGlpiBrowseTarget({ scope: "requester" }))}
          >
            Changer de compte
          </button>
        </div>
      )}

      {browseError && <div className="error-banner">{browseError}</div>}

      {browseTickets?.error && (
        <div className="error-banner">
          GLPI est configuré mais n'a pas répondu : aucun ticket n'est affiché plutôt qu'une liste vide trompeuse.
          {` Détail renvoyé par l'API : ${browseTickets.error}`}
        </div>
      )}

      {browseLoad === "loading" && !browseTickets && <div className="empty-state">Lecture des tickets dans GLPI…</div>}

      {browseTickets && !browseTickets.error && (
        <div className="glpi-split glpi-split--wide">
          <TicketsTable
            tickets={browseTickets.tickets}
            loading={browseLoad === "loading"}
            showRequester={browseScope === "all"}
            storageKey="glpi-browse-tickets"
            itemsLabel="tickets sur cette page GLPI"
            emptyLabel={
              browseScope === "all"
                ? "GLPI n'a renvoyé aucun ticket sur cette page."
                : "Aucun ticket n'a ce compte pour demandeur."
            }
            {...(pager ? { toolbarExtra: pager } : {})}
          />
          <TicketDetail foreign />
        </div>
      )}
    </>
  );
}

export default function GlpiTicketsTab() {
  const { backendUnavailable, browseScope } = useAppSelector(selectGlpiState);
  const session = useAppSelector((s) => s.auth.session);
  const privileged = canBrowseOtherAccounts(session);

  if (backendUnavailable) return null;

  return (
    <>
      {privileged && <ScopeBar />}
      {privileged && browseScope !== null ? <BrowseView /> : <MyTicketsView />}
    </>
  );
}
