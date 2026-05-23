/**
 * Reply branching FSM — pure-function tests.
 *
 * Covers every documented transition + the terminal-node "ignore further
 * events" rule. The FSM is the single source of truth for what to do when
 * a reply comes in; bugs here silently misroute leads (e.g. classify a
 * complaint as engaged) so the suite is intentionally exhaustive.
 */
import { describe, it, expect } from 'vitest';
import {
  reduce,
  INITIAL_BRANCH_STATE,
  type BranchState,
  type BranchEvent,
} from '../src/reply-fsm.js';

const ANCHOR = new Date('2026-05-23T12:00:00.000Z');

function clone(s: BranchState): BranchState {
  return { ...s };
}

describe('reply-fsm — hard-signal short-circuit', () => {
  it.each([
    'awaiting_reply', 'engaged', 'asked_for_info', 'scheduling', 'won', 'lost', 'dormant',
  ] as const)('any state → suppressed on bounce_hard (%s)', (node) => {
    const state: BranchState = { ...INITIAL_BRANCH_STATE, node };
    const t = reduce(state, { kind: 'bounce_hard' }, ANCHOR);
    expect(t.state.node).toBe('suppressed');
    expect(t.action.type).toBe('suppress');
    if (t.action.type === 'suppress') expect(t.action.reason).toBe('suppress_bounce_hard');
  });

  it('complaint → suppressed', () => {
    const t = reduce(clone(INITIAL_BRANCH_STATE), { kind: 'complaint' }, ANCHOR);
    expect(t.state.node).toBe('suppressed');
    expect(t.action.type).toBe('suppress');
  });

  it('unsubscribe → suppressed', () => {
    const t = reduce(clone(INITIAL_BRANCH_STATE), { kind: 'unsubscribe' }, ANCHOR);
    expect(t.state.node).toBe('suppressed');
  });

  it('inbound:not_interested_hostile → suppressed', () => {
    const t = reduce(clone(INITIAL_BRANCH_STATE), { kind: 'inbound', intent: 'not_interested_hostile' }, ANCHOR);
    expect(t.state.node).toBe('suppressed');
  });

  it('inbound:unsubscribe → suppressed (covers reply-classifier "unsubscribe" intent)', () => {
    const t = reduce(clone(INITIAL_BRANCH_STATE), { kind: 'inbound', intent: 'unsubscribe' }, ANCHOR);
    expect(t.state.node).toBe('suppressed');
  });
});

describe('reply-fsm — from awaiting_reply', () => {
  const start = clone(INITIAL_BRANCH_STATE);

  it.each([
    ['interested', 'engaged'],
    ['conditional', 'engaged'],
    ['referral',    'engaged'],
    ['objection',   'engaged'],
  ] as const)('%s → %s', (intent, dest) => {
    const t = reduce(start, { kind: 'inbound', intent }, ANCHOR);
    expect(t.state.node).toBe(dest);
    expect(t.action.type).toBe('noop');
  });

  it('wrong_person → asked_for_info', () => {
    const t = reduce(start, { kind: 'inbound', intent: 'wrong_person' }, ANCHOR);
    expect(t.state.node).toBe('asked_for_info');
  });

  it('not_interested_polite → dormant', () => {
    const t = reduce(start, { kind: 'inbound', intent: 'not_interested_polite' }, ANCHOR);
    expect(t.state.node).toBe('dormant');
    expect(t.action.type).toBe('noop');
  });

  it('auto_reply (OOO) is ignored — stays awaiting_reply', () => {
    const t = reduce(start, { kind: 'inbound', intent: 'auto_reply' }, ANCHOR);
    expect(t.state.node).toBe('awaiting_reply');
    expect(t.trail.cause).toBe('auto_reply_ignored');
  });

  it('tick on fresh state arms follow_up_1 at +48h', () => {
    const now = ANCHOR;
    const t = reduce(start, { kind: 'tick', now }, ANCHOR);
    expect(t.state.followUpsSent).toBe(1);
    expect(t.action.type).toBe('send_followup');
    if (t.action.type === 'send_followup') expect(t.action.templateKey).toBe('follow_up_1');
    expect(t.state.nextActionAt).not.toBeNull();
    const deltaH = (t.state.nextActionAt!.getTime() - now.getTime()) / 3_600_000;
    expect(deltaH).toBe(48);
  });

  it('tick before nextActionAt is a no-op (cause=tick_too_early)', () => {
    const armed: BranchState = {
      ...start,
      followUpsSent: 1,
      nextActionAt: new Date(ANCHOR.getTime() + 1_000),
      nextActionKind: 'send_followup',
    };
    const t = reduce(armed, { kind: 'tick', now: ANCHOR }, ANCHOR);
    expect(t.state).toEqual(armed);
    expect(t.action.type).toBe('noop');
    expect(t.trail.cause).toBe('tick_too_early');
  });

  it('tick after max follow-ups → dormant', () => {
    const exhausted: BranchState = { ...start, followUpsSent: 3 };
    const t = reduce(exhausted, { kind: 'tick', now: ANCHOR }, ANCHOR);
    expect(t.state.node).toBe('dormant');
    expect(t.trail.cause).toBe('max_followups_reached');
  });

  it('sequential ticks emit follow_up_1 → follow_up_2 → follow_up_3 then dormant', () => {
    let s = clone(start);
    const labels: string[] = [];
    for (let i = 0; i < 4; i++) {
      const t = reduce(s, { kind: 'tick', now: new Date(ANCHOR.getTime() + i * 10 * 86_400_000) }, ANCHOR);
      s = t.state;
      if (t.action.type === 'send_followup') labels.push(t.action.templateKey);
    }
    expect(labels).toEqual(['follow_up_1', 'follow_up_2', 'follow_up_3']);
    expect(s.node).toBe('dormant');
  });
});

describe('reply-fsm — from engaged', () => {
  const engaged: BranchState = { ...INITIAL_BRANCH_STATE, node: 'engaged' };

  it('positive intent arms a booking nudge at +24h', () => {
    const t = reduce(engaged, { kind: 'inbound', intent: 'interested' }, ANCHOR);
    expect(t.state.node).toBe('engaged');
    expect(t.state.nextActionAt).not.toBeNull();
    expect(t.state.nextActionKind).toBe('send_booking_link');
    const deltaH = (t.state.nextActionAt!.getTime() - ANCHOR.getTime()) / 3_600_000;
    expect(deltaH).toBe(24);
  });

  it('tick after nextActionAt with kind=send_booking_link → scheduling + action', () => {
    const armed: BranchState = {
      ...engaged,
      nextActionAt: new Date(ANCHOR.getTime() - 1_000),
      nextActionKind: 'send_booking_link',
    };
    const t = reduce(armed, { kind: 'tick', now: ANCHOR }, ANCHOR);
    expect(t.state.node).toBe('scheduling');
    expect(t.action.type).toBe('send_booking_link');
  });

  it('tick before nextActionAt is a noop', () => {
    const armed: BranchState = {
      ...engaged,
      nextActionAt: new Date(ANCHOR.getTime() + 60_000),
      nextActionKind: 'send_booking_link',
    };
    const t = reduce(armed, { kind: 'tick', now: ANCHOR }, ANCHOR);
    expect(t.state.node).toBe('engaged');
    expect(t.action.type).toBe('noop');
  });
});

describe('reply-fsm — from asked_for_info', () => {
  const asked: BranchState = { ...INITIAL_BRANCH_STATE, node: 'asked_for_info' };

  it('positive intent → engaged', () => {
    const t = reduce(asked, { kind: 'inbound', intent: 'interested' }, ANCHOR);
    expect(t.state.node).toBe('engaged');
  });

  it('first tick arms a 96h expiry timer', () => {
    const t = reduce(asked, { kind: 'tick', now: ANCHOR }, ANCHOR);
    expect(t.state.node).toBe('asked_for_info');
    expect(t.state.nextActionAt).not.toBeNull();
    const deltaH = (t.state.nextActionAt!.getTime() - ANCHOR.getTime()) / 3_600_000;
    expect(deltaH).toBe(96);
  });

  it('tick after expiry → dormant', () => {
    const armed: BranchState = { ...asked, nextActionAt: new Date(ANCHOR.getTime() - 1) };
    const t = reduce(armed, { kind: 'tick', now: ANCHOR }, ANCHOR);
    expect(t.state.node).toBe('dormant');
    expect(t.trail.cause).toBe('asked_for_info_timeout');
  });
});

describe('reply-fsm — from scheduling', () => {
  const sched: BranchState = { ...INITIAL_BRANCH_STATE, node: 'scheduling' };

  it('any inbound → back to engaged for manual triage', () => {
    const t = reduce(sched, { kind: 'inbound', intent: 'unknown' }, ANCHOR);
    expect(t.state.node).toBe('engaged');
  });

  it('first tick arms a 72h expiry timer', () => {
    const t = reduce(sched, { kind: 'tick', now: ANCHOR }, ANCHOR);
    expect(t.state.node).toBe('scheduling');
    const deltaH = (t.state.nextActionAt!.getTime() - ANCHOR.getTime()) / 3_600_000;
    expect(deltaH).toBe(72);
  });

  it('tick after expiry → dormant', () => {
    const armed: BranchState = { ...sched, nextActionAt: new Date(ANCHOR.getTime() - 1) };
    const t = reduce(armed, { kind: 'tick', now: ANCHOR }, ANCHOR);
    expect(t.state.node).toBe('dormant');
  });
});

describe('reply-fsm — manual override', () => {
  it('manual jumps to the target node regardless of current state', () => {
    const t = reduce({ ...INITIAL_BRANCH_STATE, node: 'engaged' }, { kind: 'manual', toNode: 'won' }, ANCHOR);
    expect(t.state.node).toBe('won');
    expect(t.state.nextActionAt).toBeNull();
    expect(t.trail.cause).toBe('manual');
  });
});

describe('reply-fsm — terminal nodes', () => {
  const terminals: Array<BranchState['node']> = ['won', 'lost', 'dormant', 'suppressed'];

  for (const node of terminals) {
    it(`${node} ignores further events except manual + hard signals`, () => {
      const t: BranchEvent = { kind: 'tick', now: ANCHOR };
      const r = reduce({ ...INITIAL_BRANCH_STATE, node }, t, ANCHOR);
      expect(r.state.node).toBe(node);
      expect(r.action.type).toBe('noop');
      expect(r.trail.cause).toBe('terminal_ignored');
    });
  }

  it('suppressed responds to manual (operator un-suppress)', () => {
    const r = reduce(
      { ...INITIAL_BRANCH_STATE, node: 'suppressed' },
      { kind: 'manual', toNode: 'awaiting_reply' },
      ANCHOR,
    );
    expect(r.state.node).toBe('awaiting_reply');
  });
});
