/*
============================================================
 CIKUR GO — BCGO ADMIN AUTHORITY
 File : bcgo-auth.js

 Tanggung jawab:
 - Firebase Authentication session
 - Login
 - Logout
 - Admin registration
 - admin_users verification
 - Session restore
 - Auth state lifecycle
 - Admin authorization

 TIDAK:
 - mengubah dashboard
 - menjalankan BCGO
 - menjalankan Medicine
 - menjalankan Executor
============================================================
*/

import {
    db,
    auth
} from "./cikur-config.js";

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


const BCGO_AUTH = {
    currentUser: null,
    adminVerified: false,
    initialized: false,
    destroyed: false,

    unsubscribeAuth: null,

    callbacks: {
        ready: [],
        authorized: [],
        unauthorized: [],
        logout: [],
        error: []
    }
};


/* ============================================================
   CALLBACK SYSTEM
============================================================ */

function emit(type, payload = null) {

    const list = BCGO_AUTH.callbacks[type];

    if (!Array.isArray(list)) {
        return;
    }

    for (const callback of list) {

        try {
            callback(payload);
        } catch (error) {

            console.error(
                "[BCGO AUTH] Callback error:",
                error
            );
        }
    }
}


function on(type, callback) {

    if (!BCGO_AUTH.callbacks[type]) {
        BCGO_AUTH.callbacks[type] = [];
    }

    BCGO_AUTH.callbacks[type].push(callback);

    return () => {

        const list = BCGO_AUTH.callbacks[type];

        const index = list.indexOf(callback);

        if (index !== -1) {
            list.splice(index, 1);
        }
    };
}


/* ============================================================
   ADMIN VERIFICATION
============================================================ */

async function verifyAdmin(user) {

    if (!user || !user.uid) {
        return {
            ok: false,
            reason: "NO_USER"
        };
    }

    try {

        const adminRef = doc(
            db,
            "admin_users",
            user.uid
        );

        const snapshot = await getDoc(adminRef);

        if (!snapshot.exists()) {

            return {
                ok: false,
                reason: "NOT_ADMIN"
            };
        }

        const data = snapshot.data();

        if (data?.active !== true) {

            return {
                ok: false,
                reason: "ADMIN_INACTIVE"
            };
        }

        return {
            ok: true,
            reason: "AUTHORIZED",
            data
        };

    } catch (error) {

        console.error(
            "[BCGO AUTH] Admin verification failed:",
            error
        );

        return {
            ok: false,
            reason: "VERIFICATION_ERROR",
            error
        };
    }
}


/* ============================================================
   AUTH STATE HANDLER
============================================================ */

async function handleAuthState(user) {

    if (BCGO_AUTH.destroyed) {
        return;
    }

    BCGO_AUTH.currentUser = user || null;
    BCGO_AUTH.adminVerified = false;


    /*
    ------------------------------------------------------------
    Tidak ada user
    ------------------------------------------------------------
    */

    if (!user) {

        emit("unauthorized", {
            reason: "NO_SESSION"
        });

        emit("ready", {
            authenticated: false,
            authorized: false
        });

        return;
    }


    /*
    ------------------------------------------------------------
    Verifikasi administrator
    ------------------------------------------------------------
    */

    const result = await verifyAdmin(user);


    if (BCGO_AUTH.destroyed) {
        return;
    }


    /*
    ------------------------------------------------------------
    Error Firestore / verification
    ------------------------------------------------------------
    */

    if (result.reason === "VERIFICATION_ERROR") {

        BCGO_AUTH.adminVerified = false;

        emit("error", result.error);

        emit("ready", {
            authenticated: true,
            authorized: false,
            verificationError: true
        });

        return;
    }


    /*
    ------------------------------------------------------------
    Bukan admin / belum aktif
    ------------------------------------------------------------
    */

    if (!result.ok) {

        BCGO_AUTH.adminVerified = false;

        emit("unauthorized", {
            user,
            reason: result.reason
        });

        emit("ready", {
            authenticated: true,
            authorized: false
        });

        return;
    }


    /*
    ------------------------------------------------------------
    ADMIN AKTIF
    ------------------------------------------------------------
    */

    BCGO_AUTH.adminVerified = true;

    emit("authorized", {
        user,
        admin: result.data
    });

    emit("ready", {
        authenticated: true,
        authorized: true
    });
}


/* ============================================================
   INITIALIZE
============================================================ */

function initialize() {

    if (BCGO_AUTH.initialized) {
        return;
    }

    BCGO_AUTH.initialized = true;

    BCGO_AUTH.unsubscribeAuth =
        onAuthStateChanged(
            auth,
            handleAuthState
        );
}


/* ============================================================
   LOGIN
============================================================ */

async function login(email, password) {

    if (!email || !password) {

        throw new Error(
            "Email dan password wajib diisi."
        );
    }

    try {

        /*
        Penting:
        Login hanya melakukan sign-in.

        Tidak melakukan verifyAdmin di sini.

        Setelah Firebase mengubah session,
        onAuthStateChanged() menjadi satu-satunya
        jalur verifikasi authorization.
        */

        const credential =
            await signInWithEmailAndPassword(
                auth,
                email,
                password
            );

        return credential.user;

    } catch (error) {

        emit("error", error);

        throw error;
    }
}


/* ============================================================
   REGISTER ADMIN
============================================================ */

async function register(email, password) {

    if (!email || !password) {

        throw new Error(
            "Email dan password wajib diisi."
        );
    }

    try {

        const credential =
            await createUserWithEmailAndPassword(
                auth,
                email,
                password
            );

        const user = credential.user;


        await setDoc(
            doc(
                db,
                "admin_requests",
                user.uid
            ),
            {
                uid: user.uid,
                email: user.email,
                status: "pending",
                requestedAt: serverTimestamp()
            }
        );


        /*
        Registrasi bukan berarti langsung menjadi admin.
        */

        await signOut(auth);

        return user;

    } catch (error) {

        emit("error", error);

        throw error;
    }
}


/* ============================================================
   LOGOUT
============================================================ */

async function logout() {

    try {

        BCGO_AUTH.adminVerified = false;
        BCGO_AUTH.currentUser = null;

        await signOut(auth);

        emit("logout");

    } catch (error) {

        emit("error", error);

        throw error;
    }
}


/* ============================================================
   GETTERS
============================================================ */

function getUser() {

    return BCGO_AUTH.currentUser;
}


function isAuthenticated() {

    return !!BCGO_AUTH.currentUser;
}


function isAdmin() {

    return BCGO_AUTH.adminVerified === true;
}


/* ============================================================
   DESTROY
============================================================ */

function destroy() {

    BCGO_AUTH.destroyed = true;

    if (typeof BCGO_AUTH.unsubscribeAuth === "function") {

        BCGO_AUTH.unsubscribeAuth();

        BCGO_AUTH.unsubscribeAuth = null;
    }

    BCGO_AUTH.currentUser = null;
    BCGO_AUTH.adminVerified = false;
}


/* ============================================================
   PUBLIC API
============================================================ */

window.BCGOAuth = {

    initialize,

    login,

    register,

    logout,

    getUser,

    isAuthenticated,

    isAdmin,

    destroy,

    on
};


/* ============================================================
   AUTO INITIALIZE
============================================================ */

initialize();
