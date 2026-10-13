import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applicationBriefSchema,
  architectureIntentSchema,
  briefFingerprint,
  canonical,
  type ApplicationBrief,
} from '../src/architecture-contract.js';

const validBrief: ApplicationBrief = {
  version: 1,
  audience: 'public',
  access: 'visitor-session',
  frontend: 'static',
  api: 'application',
  data: 'synthetic',
  files: false,
  backgroundWork: false,
  availability: 'proof-of-concept',
  observability: 'basic',
  growthPriority: 'simplest-start',
  acceptanceActions: ['Create an item and see it after reload'],
};

test('applicationBriefSchema accepts a strict service-agnostic application brief', () => {
  assert.deepEqual(applicationBriefSchema.parse(validBrief), validBrief);
  assert.equal(applicationBriefSchema.safeParse({ ...validBrief, hosting: 'app-service' }).success, false);
});

test('applicationBriefSchema requires nonempty acceptance actions', () => {
  assert.equal(applicationBriefSchema.safeParse({ ...validBrief, acceptanceActions: [] }).success, false);
  assert.equal(applicationBriefSchema.safeParse({ ...validBrief, acceptanceActions: ['   '] }).success, false);
});

test('canonical recursively sorts object keys while preserving array order', () => {
  assert.equal(canonical({ z: 1, nested: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }, 'last'] }),
    '{"list":[{"x":1,"y":2},"last"],"nested":{"a":1,"b":2},"z":1}');
});

test('canonical sorts punctuation and non-ASCII object keys by locale-independent ordinal order', () => {
  assert.equal(canonical({ 'éclair': 4, zebra: 3, '中': 5, _meta: 2, '!tag': 1 }),
    '{"!tag":1,"_meta":2,"zebra":3,"éclair":4,"中":5}');
});

test('briefFingerprint is a stable lowercase SHA-256 digest', () => {
  const reordered = {
    acceptanceActions: validBrief.acceptanceActions,
    growthPriority: validBrief.growthPriority,
    observability: validBrief.observability,
    availability: validBrief.availability,
    backgroundWork: validBrief.backgroundWork,
    files: validBrief.files,
    data: validBrief.data,
    api: validBrief.api,
    frontend: validBrief.frontend,
    access: validBrief.access,
    audience: validBrief.audience,
    version: validBrief.version,
  };
  const fingerprint = briefFingerprint(validBrief);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(briefFingerprint(reordered), fingerprint);
});

test('architectureIntentSchema accepts strict, unique architecture intent', () => {
  const intent = {
    version: 1,
    briefFingerprint: briefFingerprint(validBrief),
    capabilities: ['static-web', 'application-api', 'visitor-sessions'],
    guarantees: ['synthetic-data-only', 'same-origin-browser'],
    optimization: 'simplest-validated-start',
    growth: ['add-operational-observability'],
  };
  assert.deepEqual(architectureIntentSchema.parse(intent), intent);
  assert.equal(architectureIntentSchema.safeParse({ ...intent, resources: ['app-service'] }).success, false);
});

test('architectureIntentSchema rejects duplicate capabilities', () => {
  const result = architectureIntentSchema.safeParse({
    version: 1,
    briefFingerprint: briefFingerprint(validBrief),
    capabilities: ['static-web', 'static-web'],
    guarantees: ['synthetic-data-only'],
    optimization: 'simplest-validated-start',
    growth: [],
  });
  assert.equal(result.success, false);
  if (!result.success) assert.deepEqual(result.error.issues[0]?.path, ['capabilities']);
});

test('applicationBriefSchema rejects anonymous access to real data at the data field', () => {
  const result = applicationBriefSchema.safeParse({ ...validBrief, access: 'anonymous', data: 'real' });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some(issue => issue.code === 'custom' && issue.path.join('.') === 'data'));
  }
});

test('applicationBriefSchema rejects server-rendered frontends with a DAB-only API at the api field', () => {
  const result = applicationBriefSchema.safeParse({ ...validBrief, frontend: 'server-rendered', api: 'dab-only' });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some(issue => issue.code === 'custom' && issue.path.join('.') === 'api'));
  }
});
