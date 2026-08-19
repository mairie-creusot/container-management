import { useEffect, useState, type FormEvent } from "react";
import { useAppDispatch, useAppSelector } from "@/hooks";
import { canOperate } from "@/features/auth/authSlice";
import StatusPill from "@/components/StatusPill";
import { IconInfo } from "@/components/icons";
import {
  addGlpiFollowup,
  fetchGlpiMyTickets,
  fetchGlpiTicket,
  selectGlpiState,
  selectGlpiTicket,
} from "@/features/glpi/glpiSlice";
import { MISSING, formatDateTime, htmlToText, ticketPill } from "@/features/glpi/format";
import type { GlpiTicketDetail, GlpiTicketSummary } from "@/features/glpi/types";

function TicketRow({
  ticket,
  selected,
  onSelect,
}: {
  ticket: GlpiTicketSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const pill = ticketPill(ticket);
  return (
    <button type="button" className={`glpi-ticket-row${selected ? " is-active" : ""}`} onClick={onSelect}>
      <div className="glpi-ticket-row__head">
        <span className="glpi-ticket-row__id">#{ticket.id}</span>
        <StatusPill status={pill.status} label={pill.label} />
      </div>
      <span className="glpi-ticket-row__title">{ticket.title}</span>
      <span className="glpi-ticket-row__meta">
        Ouvert le {formatDateTime(ticket.openedAt)}
        {ticket.updatedAt ? ` · mis à jour le ${formatDateTime(ticket.updatedAt)}` : ""}
      </span>
    </button>
  );
}

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

function TicketDetail() {
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
          GLPI ne renvoie ce ticket qu'à son demandeur. Il n'existe pas, ou votre compte GLPI n'en est pas
          demandeur.
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
      dispatch(fetchGlpiTicket(selectedTicketId));
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
          </span>
        </div>
        <StatusPill status={pill.status} label={pill.label} />
      </div>

      <p className="glpi-detail__body">{body || "Ce ticket n'a pas de description."}</p>

      <h4 className="glpi-section-title">Suivis</h4>
      <FollowupList ticket={ticket} />

      {followupError && <div className="error-banner">{followupError}</div>}

      {operator ? (
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

export default function GlpiTicketsTab() {
  const dispatch = useAppDispatch();
  const { myTickets, ticketsLoad, ticketsError, selectedTicketId, backendUnavailable } = useAppSelector(selectGlpiState);
  const session = useAppSelector((s) => s.auth.session);
  const login = session?.username ?? "votre identifiant";

  useEffect(() => {
    if (ticketsLoad === "idle") dispatch(fetchGlpiMyTickets());
  }, [dispatch, ticketsLoad]);

  if (backendUnavailable) return null;

  if (ticketsError) {
    return <div className="error-banner">{ticketsError}</div>;
  }

  if (ticketsLoad === "loading" && !myTickets) {
    return <div className="empty-state">Lecture de vos tickets GLPI…</div>;
  }

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

  if (myTickets.tickets.length === 0) {
    return (
      <div className="empty-state">
        <IconInfo />
        <strong>Aucun ticket à votre nom</strong>
        <span>Votre compte GLPI a bien été trouvé, mais aucun ticket ne vous a pour demandeur.</span>
      </div>
    );
  }

  return (
    <div className="glpi-split">
      <div className="glpi-ticket-list">
        {myTickets.tickets.map((ticket) => (
          <TicketRow
            key={ticket.id}
            ticket={ticket}
            selected={ticket.id === selectedTicketId}
            onSelect={() => {
              dispatch(selectGlpiTicket(ticket.id));
              dispatch(fetchGlpiTicket(ticket.id));
            }}
          />
        ))}
      </div>
      <TicketDetail />
    </div>
  );
}
