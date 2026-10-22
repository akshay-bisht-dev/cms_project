import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS } from '../../src/config/env.js';
import { PARTITIONED_TABLES } from '../../src/jobs/partitions.js';

const docs = readFileSync(new URL('../../../../docs/environment.md', import.meta.url), 'utf8');
const example = readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8');

describe('environment documentation', () => {
  it('documents every variable the API validates and every retention setting', () => {
    const keys = [...ENV_KEYS, ...Object.values(PARTITIONED_TABLES).map((t) => t.retentionEnv)];
    expect(keys.filter((k) => !docs.includes(`\`${k}\``))).toEqual([]);
  });

  it('lists every required API variable in .env.example', () => {
    const required = ['DATABASE_URL', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET_CAPTURES', 'S3_BUCKET_FILES', 'SESSION_SECRET', 'CSRF_SECRET', 'FIELD_ENCRYPTION_KEYS'];
    expect(required.filter((k) => !new RegExp(`^${k}=`, 'm').test(example))).toEqual([]);
  });
});
