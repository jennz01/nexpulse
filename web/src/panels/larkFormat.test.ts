import { expect, test } from 'bun:test';
import { ageClass, ageLabel, categoryClass, firstLine, priorityClass, progressPercent, shortCategory, shortDate, typeClass } from './larkFormat';

test('progressPercent accepts fractions and percentages', () => {
  expect(progressPercent('0.92')).toBe(92);
  expect(progressPercent('45')).toBe(45);
  expect(progressPercent('1')).toBe(100);
  expect(progressPercent('')).toBeNull();
});

test('age tags: red over 3 days, amber over 1 day', () => {
  expect(ageClass('1237 hours | 51.5 days')).toBe('fail');
  expect(ageClass('69 hours | 2.9 days')).toBe('warn');
  expect(ageClass('6 hours | 0.2 days')).toBe('plain');
  expect(ageLabel('69 hours | 2.9 days')).toBe('2.9 d');
  expect(ageLabel('n/a')).toBe('n/a');
});

test('type and priority classes', () => {
  expect(typeClass('FEATURE')).toBe('feature');
  expect(typeClass('CHORE')).toBe('chore');
  expect(typeClass('QE')).toBe('qe');
  expect(typeClass('BUG')).toBe('plain');
  expect(priorityClass('High')).toBe('high');
  expect(priorityClass('Normal')).toBe('normal');
  expect(priorityClass('Low')).toBe('plain');
});

test('categories drop the leading channel segment', () => {
  expect(shortCategory('MOBILE > SGPOS > GENERAL')).toBe('SGPOS · GENERAL');
  expect(shortCategory('ERP > SHOPPING APP > APP LAYOUT')).toBe('SHOPPING APP · APP LAYOUT');
  expect(shortCategory('SGPOS')).toBe('SGPOS');
  expect(categoryClass('MOBILE > SGPOS > NEW REQUEST')).toBe('qe');
  expect(categoryClass('MOBILE > SGPOS > GENERAL')).toBe('feature');
  expect(categoryClass('MOBILE > SHOPPING APP > GENERAL')).toBe('warn');
  expect(categoryClass('OTHER')).toBe('plain');
});

test('shortDate handles both Lark date renderings', () => {
  expect(shortDate('10/09/2026')).toBe('10/09');
  expect(shortDate('2026/09/10 09:22')).toBe('10/09');
  expect(shortDate('yesterday')).toBe('yesterday');
});


test('firstLine keeps only the first non-empty line', () => {
  expect(firstLine('Inventory overselling\nSecond paragraph')).toBe('Inventory overselling');
  expect(firstLine('\n\n  Leading blanks  \nmore')).toBe('Leading blanks');
  expect(firstLine('single')).toBe('single');
  expect(firstLine('')).toBe('');
});
