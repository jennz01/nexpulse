import { describe, expect, test } from 'bun:test';
import { ConfigSchema, parseEnvFile, publicConfig, validateSources } from './config';
import example from '../config/dashboard.config.example.json';

describe('ConfigSchema', () => {
  test('parses the example config and applies defaults', () => {
    const parsed = ConfigSchema.parse(example);
    expect(parsed.server.port).toBe(6600);
    expect(parsed.lark.tables.feedback.limit).toBe(30);
    expect(parsed.stores.accounts[0]?.name).toBe('Account A');
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

  test('reports a missing Codemagic token', () => {
    const problems = validateSources(config, {}, 'C:/repo/config', () => true);
    expect(problems.codemagic).toContain('CODEMAGIC_API_TOKEN');
    expect(problems.appstore).toBeUndefined();
    expect(problems.playstore).toBeUndefined();
  });

  test('reports missing key files per account', () => {
    const problems = validateSources(config, { CODEMAGIC_API_TOKEN: 't' }, 'C:/repo/config', (p) => !p.endsWith('.p8'));
    expect(problems.appstore).toBe('key file missing for: Account A');
    expect(problems.playstore).toBeUndefined();
  });

  test('disables store sources when no accounts are configured', () => {
    const problems = validateSources({ ...config, stores: { accounts: [] } }, { CODEMAGIC_API_TOKEN: 't' }, 'C:/repo/config', () => true);
    expect(problems.appstore).toBe('no App Store Connect accounts configured');
    expect(problems.playstore).toBe('no Google Play accounts configured');
  });

  test('flags placeholder Lark ids', () => {
    const problems = validateSources(config, { CODEMAGIC_API_TOKEN: 't' }, 'C:/repo/config', () => true);
    expect(problems.lark).toContain('placeholder');
  });
});

describe('publicConfig', () => {
  test('exposes only non-secret values', () => {
    const pub = publicConfig(ConfigSchema.parse(example));
    expect(pub.intervals.appstore).toBe(600);
    expect(pub.accounts).toEqual(['Account A']);
    expect(JSON.stringify(pub)).not.toContain('secrets/');
  });
});
