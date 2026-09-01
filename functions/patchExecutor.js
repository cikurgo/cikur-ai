/**
 * ============================================================
 * BCGO INTERNAL PATCH EXECUTOR
 * ============================================================
 *
 * Ini adalah mesin eksekusi internal BCGO.
 *
 * TIDAK menggunakan:
 * - OpenAI
 * - Gemini
 * - AI API lain
 * - GitHub API
 * - API pihak ketiga
 *
 * Mesin hanya:
 * 1. menerima request yang sudah approved;
 * 2. memeriksa source snapshot;
 * 3. memeriksa SHA-256;
 * 4. melakukan REPLACE_EXACT satu kali;
 * 5. menyimpan source hasil ke Firestore Source Vault;
 * 6. membuat audit result.
 *
 * Catatan arsitektur:
 * Tanpa transport eksternal, mesin ini tidak menulis repository GitHub.
 * Source of truth untuk fase internal ini adalah:
 *   medicine_source_files/{filePath}
 *
 * Publikasi ke repository adalah lapisan terpisah dan TIDAK
 * dimasukkan ke file ini.
 * ============================================================
 */

'use strict';

const crypto = require('crypto');
const {
  COLLECTIONS,
  EXECUTOR_VERSION,
  TERMINAL_STATUSES,
} = require('./config');
const {
  ExecutorError,
  validateRequest,
  exactReplace,
  sha256,
} = require('./patchValidator');

function nowIso() {
  return new Date().toISOString();
}

function safeId(value) {
  return String(value || '')
    .replace(/[^\w.-]/g, '_')
    .slice(0, 200);
}

function createResultError(error) {
  return {
    ok: false,
    status:
      error?.code === 'HUMAN_APPROVAL_REQUIRED'
        ? 'PATCH_BLOCKED'
        : 'PATCH_REJECTED',
    error: {
      code: error?.code || 'EXECUTOR_ERROR',
      message: error?.message || 'Executor gagal.',
    },
    executorVersion: EXECUTOR_VERSION,
    finishedAt: nowIso(),
  };
}

async function getSource(db, filePath) {
  const ref = db.collection(COLLECTIONS.SOURCE_FILES).doc(safeId(filePath));
  const snap = await ref.get();

  if (!snap.exists) {
    throw new ExecutorError(
      'SOURCE_VAULT_MISSING',
      `Source Vault belum memiliki '${filePath}'.`
    );
  }

  const data = snap.data() || {};
  if (typeof data.content !== 'string') {
    throw new ExecutorError(
      'SOURCE_VAULT_INVALID',
      `Source Vault '${filePath}' tidak memiliki content yang valid.`
    );
  }

  const actualSha = sha256(data.content);

  if (data.sha256 && data.sha256 !== actualSha) {
    throw new ExecutorError(
      'SOURCE_VAULT_CORRUPT',
      `Fingerprint Source Vault '${filePath}' tidak konsisten.`
    );
  }

  return {
    ref,
    data,
    content: data.content,
    sha256: actualSha,
  };
}

async function executePatch(db, rawRequest) {
  const startedAt = nowIso();
  const request = validateRequest(rawRequest);

  const source = await getSource(db, request.target);

  if (source.sha256 !== request.expectedSourceSha) {
    throw new ExecutorError(
      'STALE_SOURCE',
      'Source Vault sudah berubah sejak Medicine membuat approval.',
      {
        expectedSourceSha: request.expectedSourceSha,
        actualSourceSha: source.sha256,
      }
    );
  }

  let current = source.content;
  const appliedOperations = [];

  for (const operation of request.operations) {
    if (operation.filePath !== request.target) {
      throw new ExecutorError(
        'TARGET_OPERATION_MISMATCH',
        'Operation mengarah ke file yang berbeda.'
      );
    }

    const result = exactReplace(
      current,
      operation.before,
      operation.after
    );

    current = result.updatedSource;

    appliedOperations.push({
      filePath: operation.filePath,
      type: operation.type,
      line: operation.line,
      replacementCount: result.replacementCount,
      sourceIndex: result.sourceIndex,
      reason: operation.reason,
    });
  }

  const resultingSha = sha256(current);

  if (request.dryRun) {
    return {
      ok: true,
      status: 'DRY_RUN_VERIFIED',
      dryRun: true,
      target: request.target,
      source: {
        beforeSha256: source.sha256,
        afterSha256: resultingSha,
      },
      operations: appliedOperations,
      executorVersion: EXECUTOR_VERSION,
      startedAt,
      finishedAt: nowIso(),
    };
  }

  const batch = db.batch();

  const sourceRef = source.ref;
  batch.set(
    sourceRef,
    {
      content: current,
      sha256: resultingSha,
      filePath: request.target,
      previousSha256: source.sha256,
      updatedBy: request.actorUid,
      updatedByRequest: request.requestId,
      updatedAt: new Date(),
      executorVersion: EXECUTOR_VERSION,
    },
    { merge: true }
  );

  const auditRef = db
    .collection(COLLECTIONS.VALIDATIONS)
    .doc();

  batch.set(auditRef, {
    kind: 'INTERNAL_PATCH_EXECUTION',
    requestId: request.requestId,
    caseId: request.caseId,
    proposalId: request.proposalId,
    planId: request.planId,
    actorUid: request.actorUid,
    target: request.target,
    operation: 'REPLACE_EXACT',
    operations: appliedOperations,
    beforeSha256: source.sha256,
    afterSha256: resultingSha,
    status: 'PATCH_APPLIED',
    executorVersion: EXECUTOR_VERSION,
    createdAt: new Date(),
  });

  await batch.commit();

  return {
    ok: true,
    status: 'PATCH_APPLIED',
    dryRun: false,
    target: request.target,
    source: {
      beforeSha256: source.sha256,
      afterSha256: resultingSha,
      verified: true,
    },
    operations: appliedOperations,
    executorVersion: EXECUTOR_VERSION,
    startedAt,
    finishedAt: nowIso(),
  };
}

async function processRequest(db, requestId) {
  const requestRef = db
    .collection(COLLECTIONS.REQUESTS)
    .doc(requestId);

  const snap = await requestRef.get();

  if (!snap.exists) {
    throw new ExecutorError(
      'REQUEST_NOT_FOUND',
      `Patch request '${requestId}' tidak ditemukan.`
    );
  }

  const current = snap.data() || {};
  const status = String(current.status || '').toUpperCase();

  if (TERMINAL_STATUSES.has(status)) {
    return {
      ok: status === 'PATCH_APPLIED',
      status,
      skipped: true,
      reason: 'REQUEST_ALREADY_TERMINAL',
    };
  }

  const lockToken = `${EXECUTOR_VERSION}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;

  const locked = await db.runTransaction(async tx => {
    const latest = await tx.get(requestRef);
    if (!latest.exists) {
      throw new ExecutorError(
        'REQUEST_NOT_FOUND',
        `Patch request '${requestId}' tidak ditemukan.`
      );
    }

    const data = latest.data() || {};
    const latestStatus = String(data.status || '').toUpperCase();

    if (latestStatus !== 'PENDING_EXECUTION') {
      return false;
    }

    tx.update(requestRef, {
      status: 'EXECUTING',
      executorLock: lockToken,
      executorVersion: EXECUTOR_VERSION,
      executionStartedAt: new Date(),
    });

    return true;
  });

  if (!locked) {
    const latest = await requestRef.get();
    return {
      ok: latest.data()?.status === 'PATCH_APPLIED',
      status: latest.data()?.status || 'UNKNOWN',
      skipped: true,
      reason: 'REQUEST_NOT_PENDING',
    };
  }

  try {
    const result = await executePatch(db, {
      ...current,
      status: 'PENDING_EXECUTION',
    });

    await requestRef.update({
      status: result.status,
      result,
      executorLock: lockToken,
      executionFinishedAt: new Date(),
      updatedAt: new Date(),
    });

    return result;
  } catch (error) {
    const result = createResultError(error);

    await requestRef.update({
      status: result.status,
      result,
      executorLock: lockToken,
      executionFinishedAt: new Date(),
      updatedAt: new Date(),
    });

    return result;
  }
}

module.exports = {
  executePatch,
  processRequest,
};
