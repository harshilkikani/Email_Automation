/**
 * Branching reply state machine.
 *
 * Pure: takes the current state + a classifier output and emits the next
 * state plus an `action` the executor should perform. The server-side
 * executor in apps/server/src/services/reply-branches.ts persists state to
 * reply_branch_states and dispatches the actions.
 *
 *   awaiting_reply ── inbound:interested ──→ engaged
 *                  ── inbound:conditional ─→ asked_for_info
 *                  ── inbound:objection ──→ engaged
 *                  ── inbound:not_interested_polite ─→ dormant
 *                  ── inbound:not_interested_hostile ─→ suppressed
 *                  ── inbound:wrong_person ─→ asked_for_info
 *                  ── inbound:referral ───→ engaged
 *                  ── inbound:bounce / unsubscribe ─→ suppressed
 *                  ── tick:48h elapsed ──→ follow_up_1 (auto)
 *
 *   engaged       ── tick:24h ──→ scheduling (auto: send booking link)
 *                  ── inbound:not_interested_hostile → suppressed
 *
 *   asked_for_info ── tick:no reply 96h → dormant
 *                   ── inbound:any positive → engaged
 *
 *   scheduling    ── tick:no reply 72h → dormant
 *                   ── inbound:any → engaged (manual triage)
 *
 *   dormant       — terminal-ish; re-engage from outside the FSM.
 *   won / lost / suppressed — terminal.
 */
import type { ReplyIntent } from './types.js';

export type ReplyNode =
  | 'awaiting_reply' | 'engaged' | 'asked_for_info' | 'scheduling'
  | 'won' | 'lost' | 'dormant' | 'suppressed';

export interface BranchState {
  node: ReplyNode;
  followUpsSent: number;
  /** When non-null, the next scheduled timer fires here. */
  nextActionAt: Date | null;
  nextActionKind: string | null;
  nextActionPayload?: Record<string, unknown>;
}

export type BranchEvent =
  | { kind: 'inbound'; intent: ReplyIntent | 'unknown' }
  | { kind: 'tick'; now: Date }
  | { kind: 'bounce_hard' }
  | { kind: 'complaint' }
  | { kind: 'unsubscribe' }
  | { kind: 'manual'; toNode: ReplyNode };

export type BranchAction =
  | { type: 'send_followup'; templateKey: string }
  | { type: 'send_booking_link' }
  | { type: 'suppress'; reason: string }
  | { type: 'wait'; until: Date }
  | { type: 'noop' };

export interface Transition {
  state: BranchState;
  action: BranchAction;
  /** Audit trail entry. */
  trail: { at: string; from: ReplyNode; to: ReplyNode; cause: string };
}

const FOLLOWUP_GAP_HOURS: Record<number, number> = {
  0: 48,    // first follow-up after 48h of no reply
  1: 96,    // second after another 4 days
  2: 168,   // third after another week
};
const MAX_FOLLOWUPS = 3;

const POSITIVE_INTENTS: ReplyIntent[] = ['interested', 'conditional', 'referral'];

export function reduce(state: BranchState, event: BranchEvent, now: Date = new Date()): Transition {
  /* Hard signals always win. */
  if (event.kind === 'bounce_hard' || event.kind === 'complaint' || event.kind === 'unsubscribe' ||
      (event.kind === 'inbound' && event.intent === 'not_interested_hostile') ||
      (event.kind === 'inbound' && event.intent === 'unsubscribe')) {
    return terminal(state, 'suppressed', event.kind, 'suppress', `suppress_${event.kind}`);
  }
  if (event.kind === 'manual') {
    return {
      state: { ...state, node: event.toNode, nextActionAt: null, nextActionKind: null },
      action: { type: 'noop' },
      trail: { at: now.toISOString(), from: state.node, to: event.toNode, cause: 'manual' },
    };
  }

  switch (state.node) {
    case 'awaiting_reply':
      return fromAwaiting(state, event, now);
    case 'engaged':
      return fromEngaged(state, event, now);
    case 'asked_for_info':
      return fromAskedForInfo(state, event, now);
    case 'scheduling':
      return fromScheduling(state, event, now);
    default:
      /* Terminal: ignore further events except manual (handled above). */
      return { state, action: { type: 'noop' }, trail: { at: now.toISOString(), from: state.node, to: state.node, cause: 'terminal_ignored' } };
  }
}

function fromAwaiting(state: BranchState, event: BranchEvent, now: Date): Transition {
  if (event.kind === 'inbound') {
    if (POSITIVE_INTENTS.includes(event.intent as ReplyIntent)) {
      return move(state, 'engaged', `inbound_${event.intent}`, { type: 'noop' }, now);
    }
    if (event.intent === 'objection') {
      return move(state, 'engaged', 'inbound_objection', { type: 'noop' }, now);
    }
    if (event.intent === 'wrong_person') {
      return move(state, 'asked_for_info', 'inbound_wrong_person', { type: 'noop' }, now);
    }
    if (event.intent === 'not_interested_polite') {
      return terminal(state, 'dormant', 'inbound_not_interested_polite', 'noop', 'noop');
    }
    if (event.intent === 'auto_reply') {
      /* OOO etc — ignore; remain awaiting. */
      return { state, action: { type: 'noop' }, trail: { at: now.toISOString(), from: state.node, to: state.node, cause: 'auto_reply_ignored' } };
    }
    return { state, action: { type: 'noop' }, trail: { at: now.toISOString(), from: state.node, to: state.node, cause: `inbound_${event.intent}_unhandled` } };
  }
  if (event.kind === 'tick') {
    /* Schedule next follow-up if the gap has elapsed. */
    if (state.nextActionAt && event.now < state.nextActionAt) {
      return { state, action: { type: 'noop' }, trail: { at: now.toISOString(), from: state.node, to: state.node, cause: 'tick_too_early' } };
    }
    if (state.followUpsSent >= MAX_FOLLOWUPS) {
      return terminal(state, 'dormant', 'max_followups_reached', 'noop', 'noop');
    }
    const idx = state.followUpsSent;
    const gapHours = FOLLOWUP_GAP_HOURS[idx] ?? 168;
    const nextAt = new Date(event.now.getTime() + gapHours * 3600_000);
    const nextState: BranchState = {
      ...state,
      followUpsSent: state.followUpsSent + 1,
      nextActionAt: nextAt,
      nextActionKind: 'send_followup',
      nextActionPayload: { templateKey: `${state.followUpsSent === 0 ? 'follow_up_1' : state.followUpsSent === 1 ? 'follow_up_2' : 'follow_up_3'}` },
    };
    return {
      state: nextState,
      action: { type: 'send_followup', templateKey: nextState.nextActionPayload!.templateKey as string },
      trail: { at: now.toISOString(), from: 'awaiting_reply', to: 'awaiting_reply', cause: `followup_${idx + 1}` },
    };
  }
  return { state, action: { type: 'noop' }, trail: { at: now.toISOString(), from: state.node, to: state.node, cause: 'noop' } };
}

function fromEngaged(state: BranchState, event: BranchEvent, now: Date): Transition {
  if (event.kind === 'inbound' && POSITIVE_INTENTS.includes(event.intent as ReplyIntent)) {
    /* Stay engaged; schedule the booking nudge for 24h out if not already. */
    if (!state.nextActionAt) {
      const nextAt = new Date(now.getTime() + 24 * 3600_000);
      return {
        state: { ...state, nextActionAt: nextAt, nextActionKind: 'send_booking_link' },
        action: { type: 'noop' },
        trail: { at: now.toISOString(), from: 'engaged', to: 'engaged', cause: 'schedule_booking_nudge' },
      };
    }
  }
  if (event.kind === 'tick' && state.nextActionAt && event.now >= state.nextActionAt && state.nextActionKind === 'send_booking_link') {
    return move(state, 'scheduling', 'send_booking_link_tick', { type: 'send_booking_link' }, now);
  }
  return { state, action: { type: 'noop' }, trail: { at: now.toISOString(), from: state.node, to: state.node, cause: 'noop' } };
}

function fromAskedForInfo(state: BranchState, event: BranchEvent, now: Date): Transition {
  if (event.kind === 'inbound' && POSITIVE_INTENTS.includes(event.intent as ReplyIntent)) {
    return move(state, 'engaged', `inbound_${event.intent}`, { type: 'noop' }, now);
  }
  if (event.kind === 'tick' && state.nextActionAt && event.now >= state.nextActionAt) {
    return terminal(state, 'dormant', 'asked_for_info_timeout', 'noop', 'noop');
  }
  if (event.kind === 'tick' && !state.nextActionAt) {
    /* Set a 96h timeout the first time we see a tick in this state. */
    return {
      state: { ...state, nextActionAt: new Date(event.now.getTime() + 96 * 3600_000), nextActionKind: 'expire_asked' },
      action: { type: 'noop' },
      trail: { at: now.toISOString(), from: 'asked_for_info', to: 'asked_for_info', cause: 'arm_timer_96h' },
    };
  }
  return { state, action: { type: 'noop' }, trail: { at: now.toISOString(), from: state.node, to: state.node, cause: 'noop' } };
}

function fromScheduling(state: BranchState, event: BranchEvent, now: Date): Transition {
  if (event.kind === 'inbound') {
    /* Any inbound from here is operator-triage worthy; punt back to engaged. */
    return move(state, 'engaged', `inbound_${event.intent}`, { type: 'noop' }, now);
  }
  if (event.kind === 'tick' && state.nextActionAt && event.now >= state.nextActionAt) {
    return terminal(state, 'dormant', 'scheduling_timeout', 'noop', 'noop');
  }
  if (event.kind === 'tick' && !state.nextActionAt) {
    return {
      state: { ...state, nextActionAt: new Date(event.now.getTime() + 72 * 3600_000), nextActionKind: 'expire_scheduling' },
      action: { type: 'noop' },
      trail: { at: now.toISOString(), from: 'scheduling', to: 'scheduling', cause: 'arm_timer_72h' },
    };
  }
  return { state, action: { type: 'noop' }, trail: { at: now.toISOString(), from: state.node, to: state.node, cause: 'noop' } };
}

function move(state: BranchState, to: ReplyNode, cause: string, action: BranchAction, now: Date): Transition {
  return {
    state: { ...state, node: to, nextActionAt: null, nextActionKind: null, nextActionPayload: undefined },
    action,
    trail: { at: now.toISOString(), from: state.node, to, cause },
  };
}

function terminal(state: BranchState, to: ReplyNode, cause: string, actionType: BranchAction['type'], reason: string): Transition {
  const action: BranchAction = actionType === 'suppress'
    ? { type: 'suppress', reason }
    : { type: 'noop' };
  return {
    state: { ...state, node: to, nextActionAt: null, nextActionKind: null, nextActionPayload: undefined },
    action,
    trail: { at: new Date().toISOString(), from: state.node, to, cause },
  };
}

export const INITIAL_BRANCH_STATE: BranchState = {
  node: 'awaiting_reply',
  followUpsSent: 0,
  nextActionAt: null,
  nextActionKind: null,
};
