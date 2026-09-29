import { expect, test } from 'bun:test';
import { assertDatabaseSchemaVersion, inspectDeploymentSmokeLogin } from './deploymentSmokeAssertions.js';
import { LATEST_SQLITE_SCHEMA_VERSION } from './store/sqlite.js';

test('deployment smoke accepts authenticated login and an explicit root MFA challenge', () => {
  expect(inspectDeploymentSmokeLogin(200, undefined)).toEqual({ authenticated: true, rootMfaChallenge: false });
  expect(inspectDeploymentSmokeLogin(401, 'mfa_required')).toEqual({ authenticated: false, rootMfaChallenge: true });
});

test('deployment smoke rejects unexpected login failures', () => {
  expect(() => inspectDeploymentSmokeLogin(401, 'invalid_credentials')).toThrow('smoke login failed: HTTP 401');
  expect(() => inspectDeploymentSmokeLogin(503, undefined)).toThrow('smoke login failed: HTTP 503');
});

test('deployment smoke requires the latest database migration to be applied', () => {
  expect(() => assertDatabaseSchemaVersion(LATEST_SQLITE_SCHEMA_VERSION, LATEST_SQLITE_SCHEMA_VERSION)).not.toThrow();
  expect(() => assertDatabaseSchemaVersion(LATEST_SQLITE_SCHEMA_VERSION - 1, LATEST_SQLITE_SCHEMA_VERSION)).toThrow('database schema mismatch');
  expect(() => assertDatabaseSchemaVersion(undefined, LATEST_SQLITE_SCHEMA_VERSION)).toThrow('database schema mismatch');
});
