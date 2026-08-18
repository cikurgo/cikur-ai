// ==========================================
// CIKUR GO - CLOUD REALTIME ENGINE
// Firebase Authentication + Firestore
// ==========================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";

import {
    getFirestore,
    collection,
    addDoc,
    onSnapshot,
    query,
    where,
    setDoc,
    doc,
    getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

import {
    getAuth,
    onAuthStateChanged,
    signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";


// ==========================================
// FIREBASE CONFIGURATION
// ==========================================

const firebaseConfig = {
    apiKey: "AIzaSyBV2dQa-Mon5zPuNHA6Tda4L4aLoeL_QDw",
    authDomain: "cikur-go-indonesia.firebaseapp.com",
    projectId: "cikur-go-indonesia",
    storageBucket: "cikur-go-indonesia.firebasestorage.app",
    messagingSenderId: "1058616161176",
    appId: "1:1058616161176:web:3b3983d79cc722ab4e71ed",
    measurementId: "G-WCSSXJRS0B"
};

// ==========================================
// FIREBASE INITIALIZATION
// ==========================================

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// ==========================================
// CIKUR CLOUD GLOBAL ENGINE
// ==========================================

window.CikurCloud = {
    waitForAuth() {
    return new Promise((resolve) => {

        const unsubscribe = onAuthStateChanged(
            auth,
            (user) => {
                unsubscribe();
                console.log(
                    "[CIKUR GO] Auth state:",
                    user ? user.uid : "TIDAK ADA USER"
                );

                resolve(user);
            }
        );

    });
},
async ensureAuth() {
    // Cek user yang sudah ada terlebih dahulu
    let user = auth.currentUser;
    if (user) {
        console.log(
            "[CIKUR GO] User aktif:",
            user.uid
        );
        return user;
    }
    // Tunggu Firebase menyelesaikan pemulihan session
    user = await this.waitForAuth();
    if (user) {
        console.log(
            "[CIKUR GO] Session dipulihkan:",
            user.uid
        );
        return user;
    }
    // Jika benar-benar belum ada session,
    // baru buat Anonymous User baru.
    console.log(
        "[CIKUR GO] Tidak ada session. Membuat Anonymous User baru..."
    );
    const credential =
        await signInAnonymously(auth);
    console.log(
        "[CIKUR GO] Anonymous User baru:",
        credential.user.uid
    );
    return credential.user;
},
    // ======================================
    // USER PROFILE
    // ======================================

    async saveProfile(userId, data) {

        if (!userId) {
            throw new Error(
                "User ID tidak tersedia."
            );
        }

        await setDoc(
            doc(db, "users", userId),
            data,
            {
                merge: true
            }
        );

        return true;
    },

    async getProfile(userId) {

        if (!userId) {
            return null;
        }

        const profileSnapshot =
            await getDoc(
                doc(db, "users", userId)
            );

        if (!profileSnapshot.exists()) {
            return null;
        }

        return {
            id: profileSnapshot.id,
            ...profileSnapshot.data()
        };
    },


    // ======================================
    // ORDER
    // ======================================

    async createOrder(
        type,
        orderDetails
    ) {

        if (!type) {
            throw new Error(
                "Tipe pesanan tidak tersedia."
            );
        }

        const firebaseUser =
            await this.ensureAuth();

        const orderData = {

            type,

            userId:
                firebaseUser.uid,

            ...orderDetails,

            status: "PENDING",

            timestamp: new Date()
        };

        const orderReference =
            await addDoc(
                collection(db, "orders"),
                orderData
            );

        return {
            id: orderReference.id,
            ...orderData
        };
    },


    // ======================================
    // REALTIME ORDER LISTENER
    // ======================================

    listenOrders(
        type,
        callback
    ) {

        const q =
            query(
                collection(db, "orders"),
                where(
                    "type",
                    "==",
                    type
                )
            );

        return onSnapshot(
            q,
            (snapshot) => {

                const orders = [];

                snapshot.forEach(
                    (orderSnapshot) => {

                        orders.push({

                            id:
                                orderSnapshot.id,

                            ...orderSnapshot.data()

                        });

                    }
                );

                if (
                    typeof callback ===
                    "function"
                ) {
                    callback(orders);
                }

            }
        );
    }

};


// ==========================================
// ENGINE STATUS
// ==========================================

console.log(
    "[CIKUR GO] Cloud Realtime Engine aktif."
);

console.log(
    "[CIKUR GO] Firebase Authentication aktif."
);

console.log(
    "[CIKUR GO] Firestore aktif."
);
// ======================================
    // AUTO LOAD / SYNC PROFILE GLOBAL
    // ======================================

    async loadGlobalProfile(updateCallback) {
        try {
            const user = await this.ensureAuth();
            if (!user) return null;

            const profile = await this.getProfile(user.uid);
            if (profile) {
                console.log("[CIKUR GO] Profil berhasil dimuat dari Cloud:", profile);
                if (typeof updateCallback === "function") {
                    updateCallback(profile);
                }
                return profile;
            }
        } catch (err) {
            console.error("[CIKUR GO] Gagal memuat profil global:", err);
        }
        return null;
    }
