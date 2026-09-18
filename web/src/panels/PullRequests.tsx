import { useState } from 'react';
import type { CiState, Event, GithubSnapshot, PullRequest } from '../../../shared/types';
import { unreadItems } from '../state';
import { relativeTime } from '../time';
import { openItem } from './open';

interface Props { snapshot: GithubSnapshot | null; events: Event[]; onSee: (ids: number[]) => void; now: number }

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

export function PullRequests({ snapshot, events, onSee, now }: Props) {
  const [tab, setTab] = useState<'incoming' | 'mine'>('incoming');
  if (!snapshot) return <div className="note">Waiting for the first GitHub poll…</div>;
  const unread = unreadItems(events, 'prs');
  const list = snapshot[tab];
  return (
    <>
      <div className="tabs" role="tablist">
        {(['incoming', 'mine'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
            {t === 'incoming' ? 'Review requested' : 'Mine'} <span className="count">{snapshot[t].length}</span>
          </button>
        ))}
      </div>
      <div className="rows" role="list" style={{ paddingTop: 6 }}>
        {list.length === 0 && <div className="note">{tab === 'incoming' ? 'No PRs waiting for your review.' : 'No open PRs of yours.'}</div>}
        {list.map((pr) => {
          const ids = unread.get(pr.id) ?? [];
          return (
            <button key={pr.id} role="listitem" className={`row click ${ids.length ? 'new' : ''}`} onClick={() => openItem(pr.url, ids, onSee)}>
              <i className={ids.length ? 'newdot' : 'nodot'} />
              {pr.authorAvatarUrl ? <img className="avatar" src={pr.authorAvatarUrl} alt="" /> : <span className="avatar" />}
              <span className="meta mono">{pr.repo.split('/')[1] ?? pr.repo} #{pr.number}</span>
              <span className="title" title={pr.title}>{pr.title}</span>
              <span className="meta">{pr.authorLogin} · {relativeTime(pr.createdAt, now)}</span>
              <CiDot ci={pr.ci} />
              <DecisionTag pr={pr} />
            </button>
          );
        })}
      </div>
    </>
  );
}
