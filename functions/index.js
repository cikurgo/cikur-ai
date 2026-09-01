'use strict';

const {
  onDocumentCreated
} = require('firebase-functions/v2/firestore');

const {
  onCall,
  HttpsError
} = require('firebase-functions/v2/https');

const {
  getFirestore,
  FieldValue
} = require('firebase-admin/firestore');

const {
  initializeApp
} = require('firebase-admin/app');

const {
  executePatchRequest,
  isTerminalStatus,
  readFile
} = require('./patchExecutor');

initializeApp();

const db = getFirestore();

const REGION =
  process.env.FUNCTIONS_REGION || 'asia-southeast2';

async function assertActiveAdmin(uid) {
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const snap = await db.collection('admin_users').doc(uid).get();
  if (!snap.exists || snap.data()?.active !== true) {
    throw new HttpsError('permission-denied', 'Active Admin access required.');
  }
}


/**
 * ============================================================
 * BCGO PATCH EXECUTOR
 * functions/index.js
 *
 * Peran:
 * 1. Memberikan SHA source kepada Medicine.
 * 2. Menerima medicine_patch_requests.
 * 3. Menyerahkan request ke PatchExecutor.
 * 4. Menyimpan hasil eksekusi ke Firestore.
 *
 * Credential GitHub TIDAK pernah dikirim ke browser.
 * ============================================================
 */

/**
 * ------------------------------------------------------------
 * SOURCE SNAPSHOT
 * ------------------------------------------------------------
 *
 * Medicine meminta SHA file sebelum membuat patch.
 *
 * Tujuannya:
 * Medicine mendiagnosis source pada keadaan tertentu.
 *
 * Jika source berubah setelah diagnosis:
 *
 *     expected SHA !== actual SHA
 *
 * maka patch akan DITOLAK.
 */
exports.getSourceSnapshot = onCall(
  {
    region: REGION
  },

  async (request) => {

    await assertActiveAdmin(request.auth?.uid);

    const files = Array.isArray(request.data?.files)
      ? request.data.files
      : [];

    if (files.length < 1 || files.length > 30) {
      throw new HttpsError(
        'invalid-argument',
        'files must contain 1-30 paths.'
      );
    }

    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPOSITORY;
    const branch =
      process.env.GITHUB_BASE_BRANCH || 'main';

    if (!owner || !repo) {
      throw new HttpsError(
        'failed-precondition',
        'GitHub repository configuration is missing.'
      );
    }

    const result = {};

    for (const file of files) {

      try {

        const source = await readFile(
          file,
          branch
        );

        result[file] = {
          sha: source.sha,
          ok: true
        };

      } catch (error) {

        result[file] = {
          sha: null,
          ok: false,
          error:
            error.code ||
            'SOURCE_READ_FAILED'
        };
      }
    }

    return {
      ok: true,
      repository: `${owner}/${repo}`,
      branch,
      files: result,
      capturedAt: new Date().toISOString()
    };
  }
);



// ============================================================
// EXECUTOR HEALTH
// ============================================================
exports.getExecutorStatus = onCall(
  { region: REGION },
  async (request) => {
    await assertActiveAdmin(request.auth?.uid);
    const configured = !!process.env.GITHUB_OWNER && !!process.env.GITHUB_REPOSITORY && !!process.env.GITHUB_TOKEN;
    return {
      ok: true,
      ready: configured,
      configured,
      region: REGION
    };
  }
);

/**
 * ------------------------------------------------------------
 * MEDICINE PATCH REQUEST TRIGGER
 * ------------------------------------------------------------
 *
 * Medicine menulis:
 *
 * medicine_patch_requests/{requestId}
 *
 * Trigger ini kemudian:
 *
 *     Firestore
 *         ↓
 *     PatchExecutor
 *         ↓
 *     Precision Gate
 *         ↓
 *     SHA protection
 *         ↓
 *     REPLACE_EXACT
 *         ↓
 *     DRY_RUN / LIVE
 *         ↓
 *     result
 */
exports.processMedicinePatchRequest =
  onDocumentCreated(
    {
      document:
        'medicine_patch_requests/{requestId}',
      region: REGION
    },

    async (event) => {

      const requestId =
        event.params.requestId;

      const snapshot =
        event.data;

      if (!snapshot) {
        return null;
      }

      const request =
        snapshot.data() || {};

      const requestRef =
        db
          .collection('medicine_patch_requests')
          .doc(requestId);


      /**
       * Jangan memproses ulang request terminal.
       */
      if (
        isTerminalStatus(
          request.executorStatus
        )
      ) {
        return null;
      }


      /**
       * Tandai bahwa Executor sudah menerima request.
       */
      await requestRef.set(
        {
          executorStatus: 'RECEIVED',

          executorRequestId:
            requestId,

          executorReceivedAt:
            FieldValue.serverTimestamp()

        },
        {
          merge: true
        }
      );


      try {

        /**
         * Jalankan seluruh pengaman dan
         * operasi patch di PatchExecutor.
         */
        const result =
          await executePatchRequest({
            ...request,
            requestId,
            owner: request.owner || process.env.GITHUB_OWNER,
            repo: request.repo || process.env.GITHUB_REPOSITORY,
            branch: request.branch || process.env.GITHUB_BASE_BRANCH || 'main'
          });


        /**
         * Simpan hasil ke request asli.
         */
        await requestRef.set(
          {
            executorStatus:
              result.status,

            executorResult:
              result,

            executorCompletedAt:
              FieldValue.serverTimestamp()

          },
          {
            merge: true
          }
        );


        /**
         * Salinan hasil khusus untuk
         * listener Medicine.
         */
        await db
          .collection('medicine_patch_results')
          .doc(requestId)
          .set(
            {
              requestId,

              caseId:
                request.caseId || null,

              proposalId:
                request.proposalId || null,

              status:
                result.status,

              ok:
                result.ok === true,

              result,

              createdAt:
                FieldValue.serverTimestamp()

            },
            {
              merge: true
            }
          );


        return result;

      } catch (error) {

        /**
         * Jangan biarkan kegagalan Executor
         * menghilangkan jejak diagnosis.
         */
        const result = {

          status: 'FAILED',

          ok: false,

          code:
            error.code ||
            'EXECUTOR_ERROR',

          message:
            error.message ||
            String(error)

        };


        await requestRef.set(
          {
            executorStatus: 'FAILED',

            executorResult:
              result,

            executorCompletedAt:
              FieldValue.serverTimestamp()

          },
          {
            merge: true
          }
        );


        await db
          .collection('medicine_patch_results')
          .doc(requestId)
          .set(
            {
              requestId,

              caseId:
                request.caseId || null,

              proposalId:
                request.proposalId || null,

              status: 'FAILED',

              ok: false,

              result,

              createdAt:
                FieldValue.serverTimestamp()

            },
            {
              merge: true
            }
          );


        /**
         * Error tetap dilempar supaya
         * Firebase mencatat kegagalan trigger.
         */
        throw error;
      }
    }
  );
