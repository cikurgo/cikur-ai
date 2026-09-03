/*
 * BCGO AUTH — Central Authentication & Admin Authority
 *
 * Tanggung jawab file ini HANYA keamanan/session:
 * - Firebase Authentication
 * - login / register / logout
 * - pemantauan session realtime
 * - verifikasi admin_users/{uid}.active
 * - broadcast status AUTH_READY / AUTHORIZED / PENDING / SIGNED_OUT
 *
 * Dashboard (bcgo-admin.html) tidak lagi mengelola lifecycle auth sendiri.
 * Firebase connection tetap berasal dari cikur-config.js.
 */

import { db, auth } from "./cikur-config.js";
import {
    doc,
    getDoc,
    setDoc,
    serverTimestamp
} from "./lib/firebase/firebase-firestore.js";
import {
    onAuthStateChanged,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut
} from "./lib/firebase/firebase-auth.js";

const listeners = new Map();

const state = {
    ready: false,
    status: "initializing",
    user: null,
    admin: false,
    error: null
};

function emit(event, payload = {}) {
    const detail = { ...payload, state: getState() };

    const bucket = listeners.get(event);
    if (bucket) {
        for (const callback of [...bucket]) {
            try { callback(detail); } catch (error) {
                console.error(`[BCGOAuth] listener error (${event})`, error);
            }
        }
    }

    window.dispatchEvent(new CustomEvent(`bcgo-auth:${event}`, { detail }));
}

function getState() {
    return {
        ready: state.ready,
        status: state.status,
        user: state.user,
        admin: state.admin,
        error: state.error
    };
}

function normalizeError(error) {
    return {
        code: error?.code || "auth/unknown",
        message: error?.message || "Terjadi kesalahan autentikasi."
    };
}

async function verifyAdmin(user) {
    if (!user?.uid) {
        return { approved: false, reason: "NO_USER" };
    }

    try {
        const snap = await getDoc(doc(db, "admin_users", user.uid));

        if (!snap.exists()) {
            return { approved: false, reason: "NOT_ADMIN" };
        }

        const data = snap.data() || {};
        if (data.active !== true) {
            return { approved: false, reason: "ADMIN_INACTIVE", data };
        }

        return { approved: true, reason: "AUTHORIZED", data };
    } catch (error) {
        console.error("[BCGOAuth] Admin verification failed:", error);
        return {
            approved: false,
            reason: "VERIFICATION_ERROR",
            error: normalizeError(error)
        };
    }
}

async function handleAuthUser(user) {
    state.error = null;
    state.user = user || null;
    state.admin = false;

    if (!user) {
        state.status = "signed_out";
        emit("signed_out", { user: null });
        return;
    }

    const result = await verifyAdmin(user);

    if (result.approved) {
        state.status = "authorized";
        state.admin = true;
        emit("authorized", {
            user,
            adminData: result.data || null
        });
        return;
    }

    // Jika verifikasi Firestore gagal, jangan menyamakan error jaringan/
    // permission dengan akun yang memang bukan admin.
    if (result.reason === "VERIFICATION_ERROR") {
        state.status = "verification_error";
        state.error = result.error || null;
        emit("verification_error", {
            user,
            error: result.error || null
        });
        return;
    }

    state.status = "pending";
    emit("pending", {
        user,
        reason: result.reason
    });
}

async function initialize() {
    try {
        onAuthStateChanged(auth, async (user) => {
            try {
                await handleAuthUser(user);
            } catch (error) {
                state.status = "verification_error";
                state.error = normalizeError(error);
                emit("verification_error", {
                    user,
                    error: state.error
                });
            } finally {
                if (!state.ready) {
                    state.ready = true;
                    emit("ready");
                }
            }
        });
    } catch (error) {
        state.ready = true;
        state.status = "verification_error";
        state.error = normalizeError(error);
        emit("ready");
        emit("verification_error", { error: state.error });
    }
}

async function login(email, password) {
    if (!email || !password) {
        const error = new Error("Email dan password wajib diisi.");
        error.code = "auth/missing-credentials";
        throw error;
    }

    // Jangan verifikasi admin di sini.
    // onAuthStateChanged adalah satu-satunya pemilik lifecycle session.
    return signInWithEmailAndPassword(auth, email, password);
}

async function register(email, password) {
    if (!email || !password) {
        const error = new Error("Email dan password wajib diisi.");
        error.code = "auth/missing-credentials";
        throw error;
    }

    const credential = await createUserWithEmailAndPassword(auth, email, password);
    const user = credential.user;

    try {
        await setDoc(doc(db, "admin_requests", user.uid), {
            uid: user.uid,
            email: user.email || email,
            status: "pending",
            requestedAt: serverTimestamp()
        });
    } catch (error) {
        // Jangan meninggalkan session admin baru dalam keadaan aktif jika
        // permintaan akses gagal disimpan.
        try { await signOut(auth); } catch (_) {}
        throw error;
    }

    await signOut(auth);

    emit("registration_submitted", {
        email: user.email || email,
        uid: user.uid
    });

    return { user, submitted: true };
}

async function logout() {
    await signOut(auth);
}

function on(event, callback) {
    if (typeof callback !== "function") return () => {};

    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(callback);

    return () => listeners.get(event)?.delete(callback);
}

const BCGOAuth = Object.freeze({
    initialize,
    login,
    register,
    logout,
    verifyAdmin,
    on,
    getState,
    get currentUser() { return state.user; },
    get isAdmin() { return state.admin; },
    get status() { return state.status; }
});

window.BCGOAuth = BCGOAuth;

// Satu kali saja. File ini menjadi satu-satunya pemilik auth observer.
initialize();
