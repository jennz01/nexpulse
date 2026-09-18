import { expect, test } from 'bun:test';
import { SOURCE_IDS } from './types';

test('five sources are registered', () => {
  expect(SOURCE_IDS).toEqual(['github', 'codemagic', 'lark', 'appstore', 'playstore']);
});
