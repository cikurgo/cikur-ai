/**
 * ============================================================
 * BCGO INTERNAL EXECUTOR — ENTRY POINT
 * ============================================================
 *
 * Firebase is used only as the internal message bus / database.
 *
 * Flow:
 * Medicine
 *   -> medicine_patch_requests/{requestId}
 *   -> this trigger
 *   -> patchExecutor
 *   -> medicine_source_files/{filePath}
 *   -> medicine_validations
 *   -> request result
 *
 * No AI API.
 * No GitHub API.
 * No third-party API.
 * ============================================================
 */

'use strict';

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const { processRequest } = require('./patchExecutor');
const {
  COLLECTIONS,
  EXECUTOR_VERSION,
} = require('./config');

initializeApp();

const db = getFirestore();

exports.bcgoPatchExecutor = onDocumentCreated(
  `${COLLECTIONS.REQUESTS}/{requestId}`,
  async event => {
    const requestId = event.params.requestId;

    logger.info('[BCGO EXECUTOR] request received', {
      requestId,
      version: EXECUTOR_VERSION,
    });

    const result = await processRequest(db, requestId);

    logger.info('[BCGO EXECUTOR] request finished', {
      requestId,
      ok: result?.ok === true,
      status: result?.status || 'UNKNOWN',
    });

    return null;
  }
);

/**
 * Recovery trigger.
 *
 * Bila sebuah request pernah berubah menjadi EXECUTING tetapi proses
 * terputus, request tidak otomatis dieksekusi ulang secara buta.
 * Trigger ini hanya mencatat kondisi stale untuk recovery manual.
 *
 * Ini sengaja konservatif: Executor tidak melakukan retry source-write
 * tanpa pemeriksaan manusia / recovery procedure.
 */
exports.bcgoPatchExecutorWatch = onDocumentUpdated(
  `${COLLECTIONS.REQUESTS}/{requestId}`,
  async event => {
    const before = event.data?.before?.data() || {};
    const after = event.data?.after?.data() || {};

    if (
      before.status === 'PENDING_EXECUTION' &&
      after.status === 'EXECUTING'
    ) {
      logger.info('[BCGO EXECUTOR] execution lock acquired', {
        requestId: event.params.requestId,
      });
    }

    return null;
  }
);

/**
 * Lightweight health callable-style HTTPS endpoint is intentionally
 * NOT exposed here. The Medicine UI must use Firestore realtime state
 * instead of treating an HTTP endpoint as proof that execution succeeded.
 */
exports.bcgoExecutorInfo = {
  version: EXECUTOR_VERSION,
  mode: 'INTERNAL_FIRESTORE_SOURCE_VAULT',
  externalApi: false,
  collections: COLLECTIONS,
};
