/**
 * BCGO INTERNAL PATCH EXECUTOR
 * Configuration only.
 *
 * No AI service.
 * No GitHub API.
 * No third-party API.
 *
 * The executor writes only to the internal Firestore Source Vault.
 * A separate deployment/synchronisation mechanism can later publish
 * an approved, validated source snapshot to the public repository.
 */

'use strict';

const ALLOWED_FILES = new Set([
  'index.html',
  'assistant.html',
  'food.html',
  'ride.html',
  'cikurgo2in1.html',
  'agentcgo.html',
  'resto.html',
  'driver.html',
  'cikur-config.js',
  'bcgo-engine.js',
  'bcgo-admin.html',
  'bcgo.html',
  'data-cgo.html',
  'bcgo-medicine.js',
  'bcgo-medicine.html',
]);

const COLLECTIONS = Object.freeze({
  REQUESTS: 'medicine_patch_requests',
  VALIDATIONS: 'medicine_validations',
  TREATMENTS: 'medicine_treatments',
  LOGS: 'system_logs',
  SOURCE_FILES: 'medicine_source_files',
});

const OPERATIONS = Object.freeze({
  REPLACE_EXACT: 'REPLACE_EXACT',
});

const TERMINAL_STATUSES = new Set([
  'PATCH_APPLIED',
  'PATCH_REJECTED',
  'PATCH_BLOCKED',
  'PATCH_FAILED',
  'PATCH_VALIDATION_FAILED',
  'CANCELLED',
]);

const MAX_SOURCE_BYTES = 1024 * 1024 * 2;
const MAX_OLD_TEXT_BYTES = 1024 * 512;
const MAX_NEW_TEXT_BYTES = 1024 * 512;
const EXECUTOR_VERSION = '1.0.0-INTERNAL';

module.exports = {
  ALLOWED_FILES,
  COLLECTIONS,
  OPERATIONS,
  TERMINAL_STATUSES,
  MAX_SOURCE_BYTES,
  MAX_OLD_TEXT_BYTES,
  MAX_NEW_TEXT_BYTES,
  EXECUTOR_VERSION,
};
