import { useState } from 'react';
import type { ReactNode } from 'react';
import type { PanelId, PublicConfig } from '../../../shared/types';
import { refreshSource } from '../api';
import { IconPlay, IconPlus } from '../icons';
import type { PageContext } from '../pages/context';
import { Builds } from './Builds';
import { Feedback } from './Feedback';
import { Issues } from './Issues';
import { otherCounts } from './larkFormat';
import { Panel } from './Panel';
import type { PanelProps } from './Panel';
import { PullRequests } from './PullRequests';
import { StartBuildDialog } from './StartBuildDialog';
import { Stores } from './Stores';
import { Tasks } from './Tasks';

/** " · <view name>" for a Lark panel's header, so each card says which view of the Base it is showing (Settings → Lark Base). */
const viewSuffix = (config: PublicConfig | null, table: 'tasks' | 'issues' | 'feedback'): string => {
  const name = config?.larkBase.tables[table].viewName;
  return name ? ` · ${name}` : '';
};

/** What the host adds to a panel: grid spans and tint from the Home layout, and the customize-mode chrome. */
export type CardChrome = Partial<Pick<PanelProps, 'tint' | 'leading' | 'tools' | 'fill' | 'extra' | 'innerRef' | 'className' | 'style' | 'sectionProps'>>;

interface CardProps {
  ctx: PageContext;
  chrome?: CardChrome;
  /** Builds only: the page layout with every returned build as a table instead of the compact list. */
  full?: boolean;
}

/** One panel per id, wired to the shared state. The Home grid and the Builds and Stores pages render these. */
export function renderCard(id: PanelId, ctx: PageContext, chrome: CardChrome): ReactNode {
  switch (id) {
    case 'prs': return <PullRequestsCard ctx={ctx} chrome={chrome} />;
    case 'tasks': return <TasksCard ctx={ctx} chrome={chrome} />;
    case 'issues': return <IssuesCard ctx={ctx} chrome={chrome} />;
    case 'feedback': return <FeedbackCard ctx={ctx} chrome={chrome} />;
    case 'builds': return <BuildsCard ctx={ctx} chrome={chrome} />;
    case 'stores': return <StoresCard ctx={ctx} chrome={chrome} />;
  }
}

export function PullRequestsCard({ ctx, chrome }: CardProps) {
  const { state, now, intervals, unread, showUnread, seeIds, seeSource } = ctx;
  const gh = state.states.github.snapshot;
  return (
    <Panel id="prs" title="Pull Requests" count={gh ? gh.incoming.length + gh.mine.length : undefined}
      unread={showUnread ? unread.prs.length : 0} state={state.states.github} intervalSec={intervals.github} now={now}
      onRefresh={() => void refreshSource('github')} onMarkAllSeen={() => seeSource('github')} openUrl="https://github.com/pulls/review-requested" {...chrome}>
      <PullRequests snapshot={gh} events={state.events} onSee={seeIds} now={now} repos={state.config?.githubRepos ?? []} />
    </Panel>
  );
}

export function TasksCard({ ctx, chrome }: CardProps) {
  const { state, now, intervals } = ctx;
  const lark = state.states.lark.snapshot;
  return (
    <Panel id="tasks" title="Tasks" count={lark ? `${lark.tasks.total}${viewSuffix(state.config, 'tasks')}` : undefined} unread={0} state={state.states.lark} intervalSec={intervals.lark} now={now}
      onRefresh={() => void refreshSource('lark')}
      headerRight={state.config?.taskFormUrl ? (
        <a className="btn primary" href={state.config.taskFormUrl} target="_blank" rel="noreferrer" title="Open the R&D Task form in Lark"><IconPlus size={12} />Create task</a>
      ) : null} {...chrome}>
      {state.config ? <Tasks snapshot={lark} config={state.config} /> : <div className="note">Loading…</div>}
    </Panel>
  );
}

export function IssuesCard({ ctx, chrome }: CardProps) {
  const { state, now, intervals, unread, showUnread, seeIds } = ctx;
  const lark = state.states.lark.snapshot;
  return (
    <Panel id="issues" title="Issues" count={lark ? `${lark.issues.groups.reduce((n, g) => n + g.records.length, 0)} active${viewSuffix(state.config, 'issues')}` : undefined}
      unread={showUnread ? unread.issues.length : 0} state={state.states.lark} intervalSec={intervals.lark} now={now}
      onRefresh={() => void refreshSource('lark')} onMarkAllSeen={() => seeIds(unread.issues.map((e) => e.id))}
      headerRight={lark && state.config ? <span className="meta">{otherCounts(lark.issues.counts, state.config.showIssueStatuses)}</span> : null} {...chrome}>
      {state.config ? <Issues snapshot={lark} events={state.events} onSee={seeIds} config={state.config} /> : <div className="note">Loading…</div>}
    </Panel>
  );
}

export function FeedbackCard({ ctx, chrome }: CardProps) {
  const { state, now, intervals, unread, showUnread, seeIds } = ctx;
  const lark = state.states.lark.snapshot;
  return (
    <Panel id="feedback" title="Merchant Feedback" count={lark ? `newest ${lark.feedback.records.length}${viewSuffix(state.config, 'feedback')}` : undefined}
      unread={showUnread ? unread.feedback.length : 0} state={state.states.lark} intervalSec={intervals.lark} now={now}
      onRefresh={() => void refreshSource('lark')} onMarkAllSeen={() => seeIds(unread.feedback.map((e) => e.id))} {...chrome}>
      {state.config ? <Feedback snapshot={lark} events={state.events} onSee={seeIds} config={state.config} /> : <div className="note">Loading…</div>}
    </Panel>
  );
}

export function BuildsCard({ ctx, chrome, full }: CardProps) {
  const { state, now, intervals, unread, showUnread, seeIds, seeSource } = ctx;
  const [dialog, setDialog] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const snapshot = state.states.codemagic.snapshot;
  const total = snapshot ? snapshot.apps.reduce((n, a) => n + a.builds.length, 0) : 0;
  const onStarted = (id: string) => { setNotice(`Build ${id.slice(0, 8)} started`); setTimeout(() => setNotice(null), 6000); };
  return (
    <>
      <Panel id="builds" title="Builds" count={snapshot ? `${snapshot.apps.length} apps · ${total} builds` : undefined}
        unread={showUnread ? unread.builds.length : 0} state={state.states.codemagic} intervalSec={intervals.codemagic} now={now}
        onRefresh={() => void refreshSource('codemagic')} onMarkAllSeen={() => seeSource('codemagic')} openUrl="https://codemagic.io/apps"
        headerRight={<>
          {notice && <span className="ok">{notice}</span>}
          <button className="btn primary" disabled={!snapshot} onClick={() => setDialog(true)}><IconPlay size={12} />Start build</button>
        </>} {...chrome}>
        <Builds snapshot={snapshot} events={state.events} onSee={seeIds} now={now} full={full} />
      </Panel>
      {dialog && snapshot && <StartBuildDialog snapshot={snapshot} onClose={() => setDialog(false)} onStarted={onStarted} />}
    </>
  );
}

export function StoresCard({ ctx, chrome }: CardProps) {
  const { state, now, intervals, unread, showUnread, seeIds } = ctx;
  return (
    <Panel id="stores" title="Stores" count={state.config ? `${state.config.accounts.length} accounts` : undefined}
      unread={showUnread ? unread.stores.length : 0} state={[state.states.appstore, state.states.playstore]} intervalSec={intervals.appstore} now={now}
      onRefresh={() => { void refreshSource('appstore'); void refreshSource('playstore'); }} onMarkAllSeen={() => seeIds(unread.stores.map((e) => e.id))} {...chrome}>
      <Stores appstore={state.states.appstore.snapshot} playstore={state.states.playstore.snapshot} events={state.events} onSee={seeIds} accounts={state.config?.accounts ?? []} />
    </Panel>
  );
}
