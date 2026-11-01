/**
 * Prior approval of every action in the user's name, asked by the server itself through MCP elicitation:
 * the client shows the user the exact action (room and its kind, members, the message quoted, the text)
 * and the server acts only on an explicit "accept". Fail closed: a client that cannot ask, a refusal,
 * a timeout or an error means nothing is sent.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export type ApprovalMode = 'elicit' | 'client';
export type Language = 'en' | 'fr';

export class ApprovalUnavailable extends Error {}

export class NotApproved extends Error {
  constructor(readonly outcome: 'decline' | 'cancel') {
    super(outcome);
  }
}

const ACTIONS = {
  send_message: { en: 'Send a message', fr: 'Envoyer un message' },
  react: { en: 'React to a message', fr: 'Réagir à un message' },
  edit_message: { en: 'Edit one of your messages', fr: 'Modifier un de vos messages' },
  redact_message: { en: 'Delete one of your messages (for everyone, cannot be undone)', fr: 'Supprimer un de vos messages (pour tous, définitif)' },
  send_file: { en: 'Send a file', fr: 'Envoyer un fichier' },
  join_room: { en: 'Join a room', fr: 'Rejoindre un salon' },
  leave_room: { en: 'Leave a room', fr: 'Quitter un salon' },
  create_room: { en: 'Create a room', fr: 'Créer un salon' },
  invite_user: { en: 'Invite someone to a room', fr: "Inviter quelqu'un dans un salon" },
} as const;

const LABELS = {
  en: {
    as: 'As', room: 'Room', to: 'To', reply_to: 'In reply to', thread: 'In the thread of', mentions: 'Notifies', text: 'Text', message: 'Message',
    new_text: 'New text', emoji: 'Reaction', file: 'File', caption: 'Caption', reason: 'Reason', name: 'Name', topic: 'Topic', invite: 'Invites',
    person: 'Person', encryption: 'Encryption', account: 'your account', ref: 'Ref.', footer: 'Accept to do it now, refuse to cancel.',
    dm: 'direct message', group: 'group room', space: 'space', member: 'member', members: 'members', encrypted: 'end-to-end encrypted', not_encrypted: 'not encrypted',
  },
  fr: {
    as: 'En tant que', room: 'Salon', to: 'À', reply_to: 'En réponse à', thread: 'Dans le fil de', mentions: 'Notifie', text: 'Texte', message: 'Message',
    new_text: 'Nouveau texte', emoji: 'Réaction', file: 'Fichier', caption: 'Légende', reason: 'Motif', name: 'Nom', topic: 'Sujet', invite: 'Invite',
    person: 'Personne', encryption: 'Chiffrement', account: 'votre compte', ref: 'Réf.', footer: 'Acceptez pour le faire maintenant, refusez pour annuler.',
    dm: 'message direct', group: 'salon de groupe', space: 'espace', member: 'membre', members: 'membres', encrypted: 'chiffré de bout en bout', not_encrypted: 'non chiffré',
  },
} as const;

export type Action = keyof typeof ACTIONS;
export type Label = keyof (typeof LABELS)['en'];

export interface ApprovalRequest {
  action: Action;
  details: [Label, string | undefined][];
}

export interface ApprovalOptions {
  mode: ApprovalMode;
  language: Language;
  timeoutMs: number;
  /** Who the actions are made as (display name or Matrix id). */
  as?: string;
}

export function approvalMessage(req: ApprovalRequest, opts: Pick<ApprovalOptions, 'language' | 'as'>, ref: string): string {
  const L = LABELS[opts.language];
  const sep = opts.language === 'fr' ? ' : ' : ': ';
  const lines = [`Twake Chat${sep}${ACTIONS[req.action][opts.language]}`];
  if (opts.as) lines.push(`${L.as}${sep}${opts.as} (${L.account})`);
  for (const [label, value] of req.details) {
    if (value === undefined || value === '') continue;
    lines.push(value.includes('\n') ? `${L[label]}${sep}\n${value}` : `${L[label]}${sep}${value}`);
  }
  lines.push('', `${L.ref} ${ref} · ${L.footer}`);
  return lines.join('\n');
}

export class Approver {
  constructor(
    private readonly server: Server,
    readonly opts: ApprovalOptions,
  ) {}

  label(key: Label): string {
    return LABELS[this.opts.language][key];
  }

  /** "Équipe Twake (group room, 12 members, end-to-end encrypted)" or "Bob DURAND (direct message, …)". */
  room(r: { name: string; kind: 'dm' | 'group' | 'space'; members: number; encrypted: boolean }): string {
    const parts = [this.label(r.kind)];
    if (r.kind !== 'dm') parts.push(`${r.members} ${this.label(r.members === 1 ? 'member' : 'members')}`);
    parts.push(this.label(r.encrypted ? 'encrypted' : 'not_encrypted'));
    return `${r.name} (${parts.join(', ')})`;
  }

  /** Resolves when the user accepted; throws NotApproved or ApprovalUnavailable otherwise. */
  async confirm(req: ApprovalRequest): Promise<void> {
    if (this.opts.mode === 'client') return;
    if (!this.server.getClientCapabilities()?.elicitation) {
      throw new ApprovalUnavailable(
        'This MCP client cannot ask the user for approval (no elicitation support), so mcp-twake-chat refuses to act. ' +
          'Use a client that supports elicitation, or set MATRIX_APPROVAL=client only if the client itself confirms every write tool with the user.',
      );
    }
    const ref = randomBytes(3).toString('hex');
    let action = 'cancel';
    try {
      const res = await this.server.elicitInput(
        { mode: 'form', message: approvalMessage(req, this.opts, ref), requestedSchema: { type: 'object', properties: {} } },
        { timeout: this.opts.timeoutMs },
      );
      action = res.action;
    } catch {
      action = 'cancel';
    }
    if (action !== 'accept') throw new NotApproved(action === 'decline' ? 'decline' : 'cancel');
  }
}
