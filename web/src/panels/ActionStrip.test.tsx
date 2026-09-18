import { expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ActionStrip } from './ActionStrip';
import type { AttentionChip } from '../../../shared/types';

const chips: AttentionChip[] = [
  { id: 'builds-failed', text: '1 build failed', detail: 'SGPOS · ios-release', tone: 'red', target: 'builds', pulse: false },
  { id: 'builds-running', text: '1 building', detail: null, tone: 'grey', target: 'builds', pulse: true },
];

test('renders chips with detail and navigates on click', () => {
  const onNavigate = mock(() => {});
  render(<ActionStrip chips={chips} onNavigate={onNavigate} />);
  expect(screen.getByText('1 build failed')).toBeTruthy();
  expect(screen.getByText('SGPOS · ios-release')).toBeTruthy();
  fireEvent.click(screen.getByText('1 build failed'));
  expect(onNavigate).toHaveBeenCalledWith('builds');
  cleanup();
});

test('empty state', () => {
  render(<ActionStrip chips={[]} onNavigate={() => {}} />);
  expect(screen.getByText('Nothing needs you right now.')).toBeTruthy();
  cleanup();
});
