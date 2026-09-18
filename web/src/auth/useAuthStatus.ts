import { useCallback, useEffect, useState } from 'react';
import type { AuthProvider, AuthStatus, SourceStates } from '../../../shared/types';
import { fetchAuthStatus } from '../api';
import { formatClock } from '../time';

/** A source error that reads like a sign-in problem rather than an outage. */
export const looksLikeAuthError = (msg: string | null | undefined): boolean =>
  !!msg && /auth login|auth switch|not logged|HTTP 401|unauthori[sz]ed|token|expired/i.test(msg);

/** gh and lark-cli session status: fetched at load, every five minutes, on window focus, and at once when a poll fails with an auth-looking error. */
export function useAuthStatus(states: SourceStates): [AuthStatus | null, (fresh?: boolean) => Promise<void>] {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const refresh = useCallback(async (fresh = false) => {
    try { setStatus(await fetchAuthStatus(fresh)); } catch { /* server unreachable: keep the last answer */ }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5 * 60_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  const authErrors = `${looksLikeAuthError(states.github.error)}|${looksLikeAuthError(states.lark.error)}`;
  useEffect(() => { if (authErrors.includes('true')) void refresh(true); }, [authErrors, refresh]);
  return [status, refresh];
}

export interface AuthProblem {
  provider: AuthProvider;
  severity: 'error' | 'warn';
  title: string;
  detail: string;
  action: 'login' | 'switch' | 'setup';
}

const SOON_MS = 48 * 3600_000;

export const formatWhen = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** What the banner shows: expired or mismatched sessions first, then a Lark session that ends within two days. */
export function authProblems(status: AuthStatus | null, states: SourceStates, now: number): AuthProblem[] {
  const out: AuthProblem[] = [];
  const gh = status?.github;
  const lk = status?.lark;
  const stalled = (s: { errorAt: number | null; fetchedAt: number | null }) => (s.errorAt ? `stopped updating at ${formatClock(s.fetchedAt ?? s.errorAt)}` : 'not updating');
  if (gh?.state === 'wrong-account') {
    out.push({ provider: 'github', severity: 'error', title: `GitHub is signed in as ${gh.account}`, detail: `the dashboard tracks ${gh.expected}; Pull Requests ${stalled(states.github)}`, action: 'switch' });
  } else if (gh?.state === 'expired' || gh?.state === 'missing' || (gh?.state !== 'ok' && looksLikeAuthError(states.github.error))) {
    out.push({ provider: 'github', severity: 'error', title: 'GitHub session expired', detail: `Pull Requests ${stalled(states.github)}`, action: 'login' });
  }
  if (lk?.state === 'unconfigured') {
    out.push({ provider: 'lark', severity: 'error', title: 'Lark is not set up on this PC', detail: 'one-time lark-cli config init needed; Tasks, Issues and Merchant Feedback stay off until then', action: 'setup' });
  } else if (lk?.state === 'expired' || lk?.state === 'missing' || (lk?.state !== 'ok' && looksLikeAuthError(states.lark.error))) {
    out.push({ provider: 'lark', severity: 'error', title: 'Lark session expired', detail: `Tasks, Issues and Merchant Feedback ${stalled(states.lark)}`, action: 'login' });
  } else if (lk?.state === 'ok' && lk.sessionUntil) {
    const until = Date.parse(lk.sessionUntil);
    if (Number.isFinite(until) && until - now < SOON_MS) {
      out.push({ provider: 'lark', severity: until < now ? 'error' : 'warn', title: until < now ? 'Lark session needs renewing' : `Lark session ends ${formatWhen(until)}`, detail: 're-authorize now to keep Tasks, Issues and Merchant Feedback updating', action: 'login' });
    }
  }
  return out;
}
