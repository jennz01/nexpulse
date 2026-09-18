import { afterEach, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Issues } from './Issues';
import type { Event, LarkSnapshot, PublicConfig } from '../../../shared/types';

afterEach(cleanup);

const config: PublicConfig = {
  intervals: { github: 60, codemagic: 120, lark: 120, appstore: 600, playstore: 600 },
  larkDomain: 'd', accounts: [], pendingLaunchStatus: 'P', collapsedStatuses: [], showIssueStatuses: ['OPEN', 'CHECKING'], taskFormUrl: null, feedbackGroupOrder: [], githubRepos: [],
};
const rec = (id: string, ticket: string, hours: string, description: string) => ({
  recordId: id, url: `https://lark/${id}`,
  fields: { ticketId: ticket, hoursSince: hours, priority: 'Normal', store: 'Store', description, status: 'OPEN' },
});
const snapshot: LarkSnapshot = {
  tasks: { groups: [], total: 0 },
  issues: { groups: [{ status: 'OPEN', records: [rec('r1', '#G001', '24 hours | 1 days', 'Overselling'), rec('r2', '#G002', '1237 hours | 51.5 days', 'Auction')] }], counts: { OPEN: 2 } },
  feedback: { records: [] },
};
const events: Event[] = [{ id: 7, source: 'lark', kind: 'issue.opened', priority: 'high', itemId: 'r1', title: 'New issue', url: 'https://lark/r1', createdAt: 0, seen: false }];

test('sorts newest first, highlights the unread row, and a click marks it seen and opens the detail dialog', () => {
  const onSee = mock(() => {});
  render(<Issues snapshot={snapshot} events={events} onSee={onSee} config={config} />);
  const rows = screen.getAllByRole('listitem');
  expect(rows[0]?.textContent).toContain('#G001');
  expect(rows[0]?.className).toContain('new');
  expect(rows[1]?.className).not.toContain('new');
  fireEvent.click(rows[0]!);
  expect(onSee).toHaveBeenCalledWith([7]);
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).toContain('Overselling');
  expect(screen.getByText('Open in Lark').closest('a')?.getAttribute('href')).toBe('https://lark/r1');
});

test('shows the waiting note before the first poll', () => {
  render(<Issues snapshot={null} events={[]} onSee={() => {}} config={config} />);
  expect(screen.getByText(/Waiting for the first Lark poll/)).toBeTruthy();
});
