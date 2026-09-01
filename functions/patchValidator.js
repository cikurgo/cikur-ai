/**
 * BCGO INTERNAL PATCH EXECUTOR
 * Deterministic safety gates.
 *
 * No fuzzy matching.
 * No regex replacement.
 * No automatic diagnosis.
 * No external API.
 */

'use strict';

const crypto = require('crypto');
const {
  ALLOWED_FILES,
  OPERATIONS,
  MAX_SOURCE_BYTES,
  MAX_OLD_TEXT_BYTES,
  MAX_NEW_TEXT_BYTES,
} = require('./config');

class ExecutorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ExecutorError';
    this.code = code;
    Object.assign(this, details);
  }
}

function string(value) {
  return typeof value === 'string' ? value : '';
}

function requiredString(value, field) {
  const v = string(value).trim();
  if (!v) {
    throw new ExecutorError(
      'MISSING_FIELD',
      `${field} wajib tersedia.`,
      { field }
    );
  }
  return v;
}

function byteLength(value) {
  return Buffer.byteLength(string(value), 'utf8');
}

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(string(value), 'utf8')
    .digest('hex');
}

function normalizePath(value) {
  const path = requiredString(value, 'filePath')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');

  if (
    path.includes('..') ||
    path.includes('\0') ||
    path.startsWith('.') ||
    path.includes('//')
  ) {
    throw new ExecutorError(
      'INVALID_FILE_PATH',
      `Path file tidak aman: ${path}`
    );
  }

  return path;
}

function validateOperation(operation) {
  if (operation !== OPERATIONS.REPLACE_EXACT) {
    throw new ExecutorError(
      'OPERATION_NOT_ALLOWED',
      `Operation '${operation}' tidak diizinkan.`
    );
  }
}

function validateExactOperation(op, index) {
  if (!op || typeof op !== 'object') {
    throw new ExecutorError(
      'INVALID_OPERATION',
      `Operation #${index + 1} tidak valid.`
    );
  }

  validateOperation(op.type || OPERATIONS.REPLACE_EXACT);

  const filePath = normalizePath(op.file || op.filePath);
  const before = requiredString(op.before, `operations[${index}].before`);

  if (typeof op.after !== 'string') {
    throw new ExecutorError(
      'AFTER_MISSING',
      `operations[${index}].after wajib berupa string.`
    );
  }

  if (!ALLOWED_FILES.has(filePath)) {
    throw new ExecutorError(
      'TARGET_NOT_ALLOWED',
      `File '${filePath}' tidak berada dalam registry Executor.`
    );
  }

  if (byteLength(before) > MAX_OLD_TEXT_BYTES) {
    throw new ExecutorError(
      'BEFORE_TOO_LARGE',
      `BEFORE operation #${index + 1} terlalu besar.`
    );
  }

  if (byteLength(op.after) > MAX_NEW_TEXT_BYTES) {
    throw new ExecutorError(
      'AFTER_TOO_LARGE',
      `AFTER operation #${index + 1} terlalu besar.`
    );
  }

  return {
    type: OPERATIONS.REPLACE_EXACT,
    filePath,
    before,
    after: op.after,
    line: Number.isFinite(Number(op.line)) ? Number(op.line) : null,
    reason: string(op.reason).slice(0, 2000),
  };
}

function validateRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new ExecutorError(
      'INVALID_PATCH_REQUEST',
      'Patch request tidak valid.'
    );
  }

  const requestId = requiredString(request.requestId, 'requestId');
  const caseId = requiredString(request.caseId, 'caseId');
  const proposalId = requiredString(request.proposalId, 'proposalId');
  const planId = requiredString(request.planId, 'planId');
  const actorUid = requiredString(request.actorUid, 'actorUid');

  if (request.status !== 'PENDING_EXECUTION') {
    throw new ExecutorError(
      'INVALID_REQUEST_STATUS',
      'Executor hanya menerima request PENDING_EXECUTION.'
    );
  }

  if (request.humanApproved !== true) {
    throw new ExecutorError(
      'HUMAN_APPROVAL_REQUIRED',
      'Executor membutuhkan approval manusia yang eksplisit.'
    );
  }

  const target = normalizePath(request.target || request.telemetryTarget);

  if (!ALLOWED_FILES.has(target)) {
    throw new ExecutorError(
      'TARGET_NOT_ALLOWED',
      `Target '${target}' tidak berada dalam registry Executor.`
    );
  }

  if (!Array.isArray(request.operations) || request.operations.length === 0) {
    throw new ExecutorError(
      'OPERATIONS_MISSING',
      'Tidak ada operasi repair yang dapat dieksekusi.'
    );
  }

  if (request.operations.length > 20) {
    throw new ExecutorError(
      'TOO_MANY_OPERATIONS',
      'Jumlah operasi patch melebihi batas aman.'
    );
  }

  const operations = request.operations.map(validateExactOperation);

  const uniqueFiles = new Set(operations.map(op => op.filePath));
  if (uniqueFiles.size !== 1) {
    throw new ExecutorError(
      'MULTI_FILE_PATCH_BLOCKED',
      'Satu request Executor hanya boleh mengubah satu file.'
    );
  }

  if (operations[0].filePath !== target) {
    throw new ExecutorError(
      'TARGET_OPERATION_MISMATCH',
      'Target request berbeda dengan file operation.'
    );
  }

  const sourceSnapshot = string(request.sourceSnapshot);
  if (!sourceSnapshot) {
    throw new ExecutorError(
      'SOURCE_SNAPSHOT_MISSING',
      'Executor internal membutuhkan sourceSnapshot exact dari Medicine.'
    );
  }

  if (byteLength(sourceSnapshot) > MAX_SOURCE_BYTES) {
    throw new ExecutorError(
      'SOURCE_TOO_LARGE',
      'Source snapshot melebihi batas aman.'
    );
  }

  const expectedSourceSha = requiredString(
    request.expectedSourceSha,
    'expectedSourceSha'
  );

  const actualSourceSha = sha256(sourceSnapshot);

  if (actualSourceSha !== expectedSourceSha) {
    throw new ExecutorError(
      'SOURCE_SHA_MISMATCH',
      'Fingerprint source tidak cocok dengan expectedSourceSha.',
      { expectedSourceSha, actualSourceSha }
    );
  }

  return {
    requestId,
    caseId,
    proposalId,
    planId,
    actorUid,
    target,
    expectedSourceSha,
    sourceSnapshot,
    operations,
    dryRun: request.dryRun === true,
    commitMessage:
      string(request.commitMessage).trim() ||
      `BCGO Medicine internal repair: ${target}`,
  };
}

function exactReplace(source, before, after) {
  const first = source.indexOf(before);

  if (first === -1) {
    throw new ExecutorError(
      'BEFORE_NOT_FOUND',
      'BEFORE tidak ditemukan secara exact pada source snapshot.'
    );
  }

  const second = source.indexOf(
    before,
    first + before.length
  );

  if (second !== -1) {
    throw new ExecutorError(
      'BEFORE_NOT_UNIQUE',
      'BEFORE ditemukan lebih dari satu kali. Patch dibatalkan.'
    );
  }

  const updatedSource =
    source.slice(0, first) +
    after +
    source.slice(first + before.length);

  if (updatedSource === source) {
    throw new ExecutorError(
      'NO_SOURCE_CHANGE',
      'Patch tidak menghasilkan perubahan.'
    );
  }

  return {
    updatedSource,
    replacementCount: 1,
    sourceIndex: first,
  };
}

module.exports = {
  ExecutorError,
  validateRequest,
  exactReplace,
  sha256,
};
