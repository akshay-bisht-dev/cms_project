import { buildTestEnv } from './test-env.js';

Object.assign(process.env, buildTestEnv());
