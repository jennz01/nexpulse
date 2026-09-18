import { useState } from 'react';
import type { CiState, Event, GithubSnapshot, PullRequest } from '../../../shared/types';
import { unreadItems } from '../state';
import { relativeTime } from '../time';
import { openItem } from './open';

interface Props {
  snapshot: GithubSnapshot | null;
  events: Event[];
  onSee: (ids: number[]) => void;
  now: number;
  /** Repositories chosen in Settings; the All tab lists their open PRs. */
  repos: string[];
}

type Tab = 'incoming' | 'mine' | 'all';
const TABS: { id: Tab; label: string }[] = [{ id: 'incoming', label: 'Review requested' }, { id: 'mine', label: 'Mine' }, { id: 'all', label: 'All' }];

function DecisionTag({ pr }: { pr: PullRequest }) {
  if (pr.isDraft) return <span className="tag plain">Draft</span>;
  if (pr.reviewDecision === 'APPROVED') return <span className="tag ok">Approved</span>;
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return <span className="tag fail">Changes requested</span>;
  return <span className="tag warn">Review required</span>;
}

function CiDot({ ci }: { ci: CiState }) {
  if (ci == null) return <i className="dot grey" title="No CI" />;
  if (ci === 'SUCCESS') return <i className="dot green" title="CI passing" />;
  if (ci === 'PENDING' || ci === 'EXPECTED') return <i className="dot blue pulse" title="CI running" />;
  return <i className="dot red" title="CI failing" />;
}

export function PullRequests({ snapshot, events, onSee, now, repos }: Props) {
  const [tab, setTab] = useState<Tab>('incoming');
  if (!snapshot) return <div className="note">Waiting for the first GitHub poll…</div>;
  const unread = unreadItems(events, 'prs');
  const lists: Record<Tab, PullRequest[]> = { incoming: snapshot.incoming, mine: snapshot.mine, all: snapshot.all ?? [] };
  const list = lists[tab];
  const empty = tab === 'incoming' ? 'No PRs waiting for your review.'
    : tab === 'mine' ? 'No open PRs of yours.'
    : repos.length === 0 ? <>No repositories chosen yet. <a href="#/settings">Pick them in Settings → Pull requests</a>.</>
    : `No open PRs in the ${repos.length === 1 ? 'selected repository' : `${repos.length} selected repositories`}.`;
  return (
    <>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}
            title={t.id === 'all' ? (repos.length ? `Open PRs in ${repos.join(', ')}` : 'Open PRs in the repositories chosen in Settings') : undefined}>
            {t.label} <span className="count">{lists[t.id].length}</span>
          </button>
        ))}
      </div>
      <div className="rows" role="list" style={{ paddingTop: 6 }}>
        {list.length === 0 && <div className="note">{empty}</div>}
        {list.map((pr) => {
          const ids = unread.get(pr.id) ?? [];
          return (
            <button key={pr.id} role="listitem" className={`row click ${ids.length ? 'new' : ''}`} onClick={() => openItem(pr.url, ids, onSee)}>
              <i className={ids.length ? 'newdot' : 'nodot'} />
              {pr.authorAvatarUrl ? <img className="avatar" src={pr.authorAvatarUrl} alt="" /> : <span className="avatar" />}
              <span className="meta mono" title={pr.repo}>{pr.repo.split('/')[1] ?? pr.repo} #{pr.number}</span>
              <span className="title" title={pr.title}>{pr.title}</span>
              <span className="meta">{pr.authorLogin} · {relativeTime(tab === 'all' ? pr.updatedAt : pr.createdAt, now)}</span>
              <CiDot ci={pr.ci} />
              <DecisionTag pr={pr} />
            </button>
          );
        })}
      </div>
    </>
  );
}
