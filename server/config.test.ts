import { describe, expect, test } from 'bun:test';
import { ConfigSchema, parseEnvFile, publicConfig, validateSources } from './config';
import example from '../config/dashboard.config.example.json';

/** The example config ships with no store accounts (they are added from Settings), so tests that need one bring their own. */
const withAccount = {
  ...example,
  stores: {
    accounts: [{
      name: 'Account A',
      appstore: { issuerId: '00000000-0000-0000-0000-000000000000', keyId: 'ABC123DEFG', keyFile: 'secrets/AuthKey_ABC123DEFG.p8' },
      play: { serviceAccountFile: 'secrets/play-account-a.json', developerId: '1234567890', apps: [{ packageName: 'com.example.app', name: 'SGPOS' }] },
    }],
  },
};

describe('ConfigSchema', () => {
  test('parses the example config and applies defaults', () => {
    const parsed = ConfigSchema.parse(example);
    expect(parsed.server.port).toBe(6600);
    expect(parsed.lark.tables.feedback.limit).toBe(30);
    expect(parsed.stores.accounts).toEqual([]);
    expect(ConfigSchema.parse(withAccount).stores.accounts[0]?.name).toBe('Account A');
  });

  test('fills polling defaults when polling is partially given', () => {
    const parsed = ConfigSchema.parse({ ...example, polling: { github: 30 } });
    expect(parsed.polling.github).toBe(30);
    expect(parsed.polling.stores).toBe(600);
  });

  test('rejects a config without github.account', () => {
    const { github, ...rest } = example;
    expect(ConfigSchema.safeParse(rest).success).toBe(false);
  });
});

describe('parseEnvFile', () => {
  test('reads KEY=VALUE lines, ignores comments and quotes', () => {
    const env = parseEnvFile('# comment\nCODEMAGIC_API_TOKEN="abc123"\nEMPTY=\n\nOTHER=x=y\n');
    expect(env).toEqual({ CODEMAGIC_API_TOKEN: 'abc123', EMPTY: '', OTHER: 'x=y' });
  });
});

describe('validateSources', () => {
  const config = ConfigSchema.parse(example);
  const stocked = ConfigSchema.parse(withAccount);

  test('reports a missing Codemagic token', () => {
    const problems = validateSources(stocked, {}, 'C:/repo/config', () => true);
    expect(problems.codemagic).toContain('CODEMAGIC_API_TOKEN');
    expect(problems.appstore).toBeUndefined();
    expect(problems.playstore).toBeUndefined();
  });

  test('reports missing key files per account', () => {
    const problems = validateSources(stocked, { CODEMAGIC_API_TOKEN: 't' }, 'C:/repo/config', (p) => !p.endsWith('.p8'));
    expect(problems.appstore).toBe('key file missing for: Account A');
    expect(problems.playstore).toBeUndefined();
  });

  test('disables the store sources on a fresh config, which carries no accounts', () => {
    const problems = validateSources(config, { CODEMAGIC_API_TOKEN: 't' }, 'C:/repo/config', () => true);
    expect(problems.appstore).toBe('no App Store Connect accounts yet (Settings → Store accounts)');
    expect(problems.playstore).toBe('no Google Play accounts yet (Settings → Store accounts)');
  });

  test('flags a Lark Base that is still the example placeholder', () => {
    const problems = validateSources(config, { CODEMAGIC_API_TOKEN: 't' }, 'C:/repo/config', () => true);
    expect(problems.lark).toContain('Lark Base is not set up yet');
  });
});

describe('publicConfig', () => {
  test('exposes only non-secret values', () => {
    const pub = publicConfig(ConfigSchema.parse(withAccount));
    expect(pub.intervals.appstore).toBe(600);
    expect(pub.accounts).toEqual(['Account A']);
    expect(JSON.stringify(pub)).not.toContain('secrets/');
  });
});
