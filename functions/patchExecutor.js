'use strict';

/**
 * ============================================================
 * BCGO PATCH EXECUTOR
 * ============================================================
 *
 * Tugas:
 * - Membaca source file dari GitHub
 * - Memastikan SHA source masih sama
 * - Memastikan operasi adalah REPLACE_EXACT
 * - Memastikan teks lama ditemukan tepat 1 kali
 * - Melakukan perubahan hanya jika semua gate lolos
 * - Commit perubahan ke branch yang ditentukan
 *
 * PENTING:
 * File ini TIDAK boleh dipanggil langsung dari browser.
 * GitHub credential hanya boleh berada di Cloud Functions.
 * ============================================================
 */

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';

const DEFAULT_BRANCH = 'main';
const DEFAULT_TIMEOUT_MS = 30000;


/**
 * ------------------------------------------------------------
 * Utility
 * ------------------------------------------------------------
 */

function normalizeString(value) {
  return typeof value === 'string' ? value : '';
}


function requiredString(value, fieldName) {
  const valueNormalized = normalizeString(value).trim();

  if (!valueNormalized) {
    throw new Error(`MISSING_${fieldName.toUpperCase()}`);
  }

  return valueNormalized;
}


function createExecutorError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}


/**
 * ------------------------------------------------------------
 * GitHub request
 * ------------------------------------------------------------
 */

async function githubRequest(path, options = {}) {
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    throw createExecutorError(
      'GITHUB_TOKEN_MISSING',
      'GitHub credential belum tersedia di Cloud Functions.'
    );
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${GITHUB_API}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'BCGO-PatchExecutor',
        ...(options.headers || {})
      }
    });

    const text = await response.text();

    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = {
        raw: text
      };
    }

    if (!response.ok) {
      throw createExecutorError(
        `GITHUB_HTTP_${response.status}`,
        `GitHub API gagal: HTTP ${response.status}`,
        {
          status: response.status,
          response: data
        }
      );
    }

    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw createExecutorError(
        'GITHUB_TIMEOUT',
        'GitHub API timeout.'
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}


/**
 * ------------------------------------------------------------
 * Read GitHub source
 * ------------------------------------------------------------
 */

async function readFile(owner, repo, filePath, branch) {
  const encodedPath = filePath
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');

  const encodedBranch = encodeURIComponent(branch);

  const result = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodedBranch}`,
    {
      method: 'GET'
    }
  );

  if (!result || result.type !== 'file') {
    throw createExecutorError(
      'TARGET_NOT_FILE',
      `Target bukan file: ${filePath}`
    );
  }

  if (!result.content || !result.sha) {
    throw createExecutorError(
      'SOURCE_CONTENT_MISSING',
      `GitHub tidak mengembalikan content/sha untuk ${filePath}`
    );
  }

  const content = Buffer.from(
    result.content.replace(/\n/g, ''),
    'base64'
  ).toString('utf8');

  return {
    path: result.path,
    sha: result.sha,
    content,
    branch
  };
}


/**
 * ------------------------------------------------------------
 * SHA protection
 * ------------------------------------------------------------
 */

function assertSha(expectedSha, actualSha) {
  if (!expectedSha) {
    throw createExecutorError(
      'EXPECTED_SHA_MISSING',
      'Medicine wajib memberikan expectedSha.'
    );
  }

  if (expectedSha !== actualSha) {
    throw createExecutorError(
      'SHA_MISMATCH',
      'Source berubah setelah diagnosis. Patch dibatalkan demi keamanan.',
      {
        expectedSha,
        actualSha
      }
    );
  }
}


/**
 * ------------------------------------------------------------
 * EXACT REPLACE
 * ------------------------------------------------------------
 *
 * Tidak menggunakan regex.
 * Tidak menggunakan fuzzy match.
 * Tidak menggunakan "contains lalu kira-kira".
 *
 * Harus:
 *
 * oldText ditemukan tepat 1 kali.
 *
 * ------------------------------------------------------------
 */

function exactReplace(source, oldText, newText) {
  const oldValue = normalizeString(oldText);
  const newValue = normalizeString(newText);

  if (!oldValue) {
    throw createExecutorError(
      'OLD_TEXT_MISSING',
      'oldText wajib tersedia.'
    );
  }

  const firstIndex = source.indexOf(oldValue);

  if (firstIndex === -1) {
    throw createExecutorError(
      'OLD_TEXT_NOT_FOUND',
      'Target source tidak ditemukan secara exact.'
    );
  }

  const secondIndex = source.indexOf(
    oldValue,
    firstIndex + oldValue.length
  );

  if (secondIndex !== -1) {
    throw createExecutorError(
      'OLD_TEXT_NOT_UNIQUE',
      'Target source ditemukan lebih dari satu kali. Patch dibatalkan.'
    );
  }

  const before = source.slice(0, firstIndex);
  const after = source.slice(firstIndex + oldValue.length);

  const updatedSource = before + newValue + after;

  return {
    updatedSource,
    replacementCount: 1,
    index: firstIndex
  };
}


/**
 * ------------------------------------------------------------
 * Safety validation
 * ------------------------------------------------------------
 */

function validatePatchRequest(request) {
  if (!request || typeof request !== 'object') {
    throw createExecutorError(
      'INVALID_PATCH_REQUEST',
      'Patch request tidak valid.'
    );
  }

  const operation = requiredString(
    request.operation,
    'operation'
  );

  if (operation !== 'REPLACE_EXACT') {
    throw createExecutorError(
      'OPERATION_NOT_ALLOWED',
      `Operation '${operation}' tidak diizinkan.`
    );
  }

  const owner = requiredString(
    request.owner || request.repoOwner,
    'owner'
  );

  const repo = requiredString(
    request.repo || request.repoName,
    'repo'
  );

  const filePath = requiredString(
    request.filePath || request.path,
    'filePath'
  );

  const branch = normalizeString(
    request.branch
  ).trim() || DEFAULT_BRANCH;

  const expectedSha = requiredString(
    request.expectedSha || request.sha,
    'expectedSha'
  );

  const oldText = requiredString(
    request.oldText,
    'oldText'
  );

  if (typeof request.newText !== 'string') {
    throw createExecutorError(
      'NEW_TEXT_MISSING',
      'newText wajib berupa string.'
    );
  }

  return {
    operation,
    owner,
    repo,
    filePath,
    branch,
    expectedSha,
    oldText,
    newText: request.newText,
    commitMessage:
      normalizeString(request.commitMessage).trim() ||
      `BCGO Medicine exact repair: ${filePath}`
  };
}


/**
 * ------------------------------------------------------------
 * Execute GitHub update
 * ------------------------------------------------------------
 */

async function updateFile({
  owner,
  repo,
  filePath,
  branch,
  sha,
  content,
  commitMessage
}) {
  const encodedPath = filePath
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');

  const body = {
    message: commitMessage,
    content: Buffer.from(content, 'utf8').toString('base64'),
    sha,
    branch
  };

  const result = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  return {
    commitSha: result?.commit?.sha || null,
    fileSha: result?.content?.sha || null,
    path: result?.content?.path || filePath,
    branch
  };
}


/**
 * ------------------------------------------------------------
 * PUBLIC EXECUTOR
 * ------------------------------------------------------------
 */

async function executeSinglePatchRequest(request) {
  const startedAt = new Date().toISOString();

  const config = validatePatchRequest(request);

  console.log('[BCGO PATCH EXECUTOR] START', {
    operation: config.operation,
    owner: config.owner,
    repo: config.repo,
    filePath: config.filePath,
    branch: config.branch
  });

  /**
   * 1. Ambil source terbaru dari GitHub.
   */
  const source = await readFile(
    config.owner,
    config.repo,
    config.filePath,
    config.branch
  );

  /**
   * 2. SHA protection.
   *
   * Jika source berubah sejak Medicine membuat diagnosis,
   * patch langsung dibatalkan.
   */
  assertSha(
    config.expectedSha,
    source.sha
  );

  /**
   * 3. Exact replacement.
   *
   * Tidak boleh fuzzy.
   * Tidak boleh replacement massal.
   */
  const replacement = exactReplace(
    source.content,
    config.oldText,
    config.newText
  );

  /**
   * 4. Jangan commit jika ternyata hasil tidak berubah.
   */
  if (replacement.updatedSource === source.content) {
    throw createExecutorError(
      'NO_SOURCE_CHANGE',
      'Patch tidak menghasilkan perubahan source.'
    );
  }

  /**
   * 5. Commit ke branch yang sama.
   */
  const commit = await updateFile({
    owner: config.owner,
    repo: config.repo,
    filePath: config.filePath,
    branch: config.branch,
    sha: source.sha,
    content: replacement.updatedSource,
    commitMessage: config.commitMessage
  });

  const finishedAt = new Date().toISOString();

  console.log('[BCGO PATCH EXECUTOR] SUCCESS', {
    filePath: config.filePath,
    branch: config.branch,
    commitSha: commit.commitSha
  });

  return {
    ok: true,
    status: 'PATCH_APPLIED',

    operation: config.operation,

    target: {
      owner: config.owner,
      repo: config.repo,
      filePath: config.filePath,
      branch: config.branch
    },

    source: {
      expectedSha: config.expectedSha,
      actualSha: source.sha,
      verified: true
    },

    replacement: {
      mode: 'REPLACE_EXACT',
      count: replacement.replacementCount,
      sourceIndex: replacement.index
    },

    commit: {
      sha: commit.commitSha,
      fileSha: commit.fileSha,
      path: commit.path,
      branch: commit.branch
    },

    startedAt,
    finishedAt
  };
}


/**
 * ------------------------------------------------------------
 * PUBLIC EXECUTOR — request adapter
 * ------------------------------------------------------------
 *
 * Medicine sends a repair plan containing one or more exact
 * operations. The browser never writes source. This adapter
 * validates every operation, reads the target once, checks the
 * diagnosis SHA, applies all exact replacements in memory, and
 * commits only after the complete preflight succeeds.
 */
async function executePatchRequest(request) {
  if (!request || typeof request !== 'object') {
    throw createExecutorError('INVALID_PATCH_REQUEST', 'Patch request tidak valid.');
  }

  const operations = Array.isArray(request.operations) && request.operations.length
    ? request.operations
    : [request];

  if (operations.length > 20) {
    throw createExecutorError('TOO_MANY_OPERATIONS', 'Maksimal 20 operasi per request.');
  }

  const configs = operations.map((operation, index) => {
    try {
      return validatePatchRequest({
        ...request,
        ...operation,
        operation: operation.operation || 'REPLACE_EXACT'
      });
    } catch (error) {
      error.message = `Operation ${index + 1}: ${error.message}`;
      throw error;
    }
  });

  const targetFiles = [...new Set(configs.map(x => x.filePath))];
  if (targetFiles.length !== 1) {
    throw createExecutorError(
      'MULTI_FILE_NOT_SUPPORTED',
      'Satu patch request harus menargetkan satu file agar eksekusi tetap atomik.'
    );
  }

  const first = configs[0];
  const startedAt = new Date().toISOString();
  const source = await readFile(first.owner, first.repo, first.filePath, first.branch);

  // Every operation must refer to the same diagnosis snapshot.
  for (const config of configs) {
    assertSha(config.expectedSha, source.sha);
  }

  let updatedSource = source.content;
  const replacements = [];

  // Full preflight: every exact target must be valid before GitHub is touched.
  for (const config of configs) {
    const replacement = exactReplace(updatedSource, config.oldText, config.newText);
    if (replacement.updatedSource === updatedSource) {
      throw createExecutorError('NO_SOURCE_CHANGE', `Patch tidak menghasilkan perubahan source pada ${config.filePath}.`);
    }
    updatedSource = replacement.updatedSource;
    replacements.push({
      mode: 'REPLACE_EXACT',
      count: replacement.replacementCount,
      sourceIndex: replacement.index,
      filePath: config.filePath
    });
  }

  if (updatedSource === source.content) {
    throw createExecutorError('NO_SOURCE_CHANGE', 'Patch tidak menghasilkan perubahan source.');
  }

  const commitMessage = normalizeString(request.commitMessage).trim() ||
    `BCGO Medicine exact repair: ${first.filePath}`;

  const commit = await updateFile({
    owner: first.owner,
    repo: first.repo,
    filePath: first.filePath,
    branch: first.branch,
    sha: source.sha,
    content: updatedSource,
    commitMessage
  });

  const finishedAt = new Date().toISOString();

  return {
    ok: true,
    status: 'PATCH_APPLIED',
    requestId: request.requestId || null,
    operation: 'REPLACE_EXACT',
    target: {
      owner: first.owner,
      repo: first.repo,
      filePath: first.filePath,
      branch: first.branch
    },
    source: {
      expectedSha: first.expectedSha,
      actualSha: source.sha,
      verified: true
    },
    replacement: replacements,
    changedFiles: [first.filePath],
    commit: {
      sha: commit.commitSha,
      fileSha: commit.fileSha,
      path: commit.path,
      branch: commit.branch
    },
    startedAt,
    finishedAt
  };
}


/**
 * ------------------------------------------------------------
 * Terminal status helper
 * ------------------------------------------------------------
 */

function isTerminalStatus(status) {
  return [
    'PATCH_APPLIED',
    'PATCH_REJECTED',
    'PATCH_BLOCKED',
    'FAILED',
    'CANCELLED'
  ].includes(
    normalizeString(status).trim().toUpperCase()
  );
}


/**
 * ------------------------------------------------------------
 * Exports
 * ------------------------------------------------------------
 */

module.exports = {
  executePatchRequest,
  isTerminalStatus,
  readFile,
  exactReplace
};
