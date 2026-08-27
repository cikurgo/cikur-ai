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
    orderBy,
    limit,
    setDoc,
    updateDoc,
    doc,
    getDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

import {
    getAuth,
    onAuthStateChanged,
    signInAnonymously,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    EmailAuthProvider,
    linkWithCredential,
    fetchSignInMethodsForEmail
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";


// ==========================================
// FIREBASE CONFIGURATION
// ==========================================

const firebaseConfig = {
    apiKey: "AIzaSyBV2dQa-MoN5zPuNHA6Tda4L4aLoeL_QDw",
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

// Export supaya modul lain (mis. bcgo.js) bisa memakai
// KONEKSI YANG SAMA, bukan membuat Firebase App baru
export { db, auth, firebaseConfig };


// ==========================================
// GLOBAL ERROR REPORTER (SISTEM SARAF OTOMATIS)
// ==========================================

/**
 * Melaporkan error dari halaman manapun secara otomatis ke Firestore
 * agar bisa dipantau secara real-time oleh bcgo.html (Neural Monitor).
 */
export async function reportSystemError(sourceFile, errorMessage) {
    try {
        await addDoc(collection(db, "system_logs"), {
            source: sourceFile,
            error: errorMessage,
            timestamp: serverTimestamp(),
            status: "UNRESOLVED"
        });
    } catch (err) {
        console.error("[CIKUR GO] Gagal mengirim log error sistem:", err);
    }
}

// Tangkap error JavaScript global di halaman manapun yang memuat config ini
window.addEventListener("error", (event) => {
    const currentFileName = window.location.pathname.split("/").pop() || "index.html";
    reportSystemError(currentFileName, event.message);
});

// Tangkap error Async / Promise yang tidak tertangani
window.addEventListener("unhandledrejection", (event) => {
    const currentFileName = window.location.pathname.split("/").pop() || "index.html";
    reportSystemError(currentFileName, event.reason?.message || "Unhandled Promise Rejection");
});


// ==========================================
// CIKUR CLOUD GLOBAL ENGINE
// ==========================================

window.CikurCloud = {
    auth,
    reportSystemError, // Diexport juga ke objek global jika butuh dipanggil manual

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
        let user = auth.currentUser;
        if (user) {
            console.log(
                "[CIKUR GO] User aktif:",
                user.uid
            );
            return user;
        }
        
        user = await this.waitForAuth();
        if (user) {
            console.log(
                "[CIKUR GO] Session dipulihkan:",
                user.uid
            );
            return user;
        }

        console.log(
            "[CIKUR GO] Tidak ada session. Membuat Anonymous User baru..."
        );
        const credential = await signInAnonymously(auth);
        console.log(
            "[CIKUR GO] Anonymous User baru:",
            credential.user.uid
        );
        return credential.user;
    },

    // ======================================
    // CEK APAKAH EMAIL SUDAH TERDAFTAR
    // ======================================

    async checkEmailExists(email) {
        try {
            const methods = await fetchSignInMethodsForEmail(auth, email);
            return methods && methods.length > 0;
        } catch (error) {
            console.error("[CIKUR GO] Gagal cek email:", error);
            return false;
        }
    },

    // ======================================
    // REGISTRASI AKUN PERMANEN (EMAIL + PASSWORD)
    // ======================================

    async registerWithEmail(email, password) {
        const currentUser = auth.currentUser;

        if (currentUser && currentUser.isAnonymous) {
            const credential = EmailAuthProvider.credential(email, password);

            try {
                const linkedResult = await linkWithCredential(currentUser, credential);
                console.log(
                    "[CIKUR GO] Akun anonymous berhasil di-upgrade ke Email:",
                    linkedResult.user.uid
                );
                return linkedResult.user;
            } catch (linkError) {
                if (linkError.code === "auth/email-already-in-use" || linkError.code === "auth/credential-already-in-use") {
                    console.warn("[CIKUR GO] Email sudah terdaftar, tidak bisa link. Membuat akun baru biasa.");
                } else {
                    throw linkError;
                }
            }
        }

        const result = await createUserWithEmailAndPassword(auth, email, password);
        console.log("[CIKUR GO] Akun Email baru dibuat:", result.user.uid);
        return result.user;
    },

    // ======================================
    // LOGIN AKUN YANG SUDAH ADA (EMAIL + PASSWORD)
    // ======================================

    async loginWithEmail(email, password) {
        const result = await signInWithEmailAndPassword(auth, email, password);
        console.log("[CIKUR GO] Login berhasil:", result.user.uid);
        return result.user;
    },

    // ======================================
    // UPDATE PROFIL MITRA SETELAH APPROVED
    // ======================================

    async updateMitraProfile(userId, jenis, data) {
        if (!userId || !jenis) throw new Error("Data tidak lengkap.");

        await setDoc(
            doc(db, "mitra_applications", `${userId}_${jenis}`),
            {
                ...data,
                updatedAt: serverTimestamp()
            },
            { merge: true }
        );

        return true;
    },

    async submitMitraApplication(userId, jenis, formData) {
        if (!userId || !jenis) throw new Error("Data pendaftaran tidak lengkap.");

        await setDoc(
            doc(db, "mitra_applications", `${userId}_${jenis}`),
            {
                uid: userId,
                jenis,
                status: "pending",
                ...formData,
                submittedAt: serverTimestamp()
            },
            { merge: true }
        );

        return true;
    },

    listenMitraApplication(userId, jenis, callback) {
        if (!userId || !jenis) return () => {};

        return onSnapshot(
            doc(db, "mitra_applications", `${userId}_${jenis}`),
            (snapshot) => {
                if (!snapshot.exists()) {
                    if (typeof callback === "function") callback(null);
                    return;
                }
                if (typeof callback === "function") {
                    callback({ id: snapshot.id, ...snapshot.data() });
                }
            },
            (error) => {
                console.error("[CIKUR GO] Gagal memantau status pendaftaran Mitra:", error);
                if (typeof callback === "function") callback({ _error: true, code: error.code, message: error.message });
            }
        );
    },

    // ======================================
    // USER PROFILE
    // ======================================

    async saveProfile(userId, data) {
        if (!userId) {
            const currentUser = await this.ensureAuth();
            if (!currentUser) {
                throw new Error("User ID tidak tersedia dan sesi gagal dibuat.");
            }
            userId = currentUser.uid;
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

        const profileSnapshot = await getDoc(
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
    // PRESENCE CUSTOMER
    // ======================================

    async updateCustomerPresence(userId, data) {
        if (!userId) return;

        try {
            await setDoc(
                doc(db, "customers", userId),
                {
                    ...data,
                    lastSeen: serverTimestamp()
                },
                { merge: true }
            );
        } catch (error) {
            console.error("[CIKUR GO] Gagal memperbarui presence:", error);
        }
    },

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

        const firebaseUser = await this.ensureAuth();

        const orderData = {
            type,
            userId: firebaseUser.uid,
            ...orderDetails,
            status: "PENDING",
            timestamp: new Date()
        };

        const orderReference = await addDoc(
            collection(db, "orders"),
            orderData
        );

        return {
            id: orderReference.id,
            ...orderData
        };
    },

    listenOrders(
        type,
        callback
    ) {
        const q = query(
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
                            id: orderSnapshot.id,
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
    },

    async getOrder(orderId) {
        if (!orderId) return null;

        const orderSnapshot = await getDoc(
            doc(db, "orders", orderId)
        );

        if (!orderSnapshot.exists()) return null;

        return {
            id: orderSnapshot.id,
            ...orderSnapshot.data()
        };
    },

    listenOrder(orderId, callback) {
        if (!orderId) return () => {};

        return onSnapshot(
            doc(db, "orders", orderId),
            (orderSnapshot) => {
                if (!orderSnapshot.exists()) {
                    if (typeof callback === "function") callback(null);
                    return;
                }
                if (typeof callback === "function") {
                    callback({
                        id: orderSnapshot.id,
                        ...orderSnapshot.data()
                    });
                }
            }
        );
    },

    async updateOrderStatus(orderId, updateData) {
        if (!orderId) throw new Error("Order ID tidak tersedia.");

        await updateDoc(
            doc(db, "orders", orderId),
            {
                ...updateData,
                updatedAt: serverTimestamp()
            }
        );

        return true;
    },

    async getActiveOrderForCustomer(userId, type) {
        if (!userId || !type) return null;

        const q = query(
            collection(db, "orders"),
            where("userId", "==", userId),
            where("type", "==", type),
            where("status", "in", ["PENDING", "DEAL", "DEAL_CONFIRMED", "PAID"]),
            orderBy("timestamp", "desc"),
            limit(1)
        );

        const snapshot = await new Promise((resolve, reject) => {
            const unsubscribe = onSnapshot(
                q,
                (snap) => { unsubscribe(); resolve(snap); },
                (err) => { unsubscribe(); reject(err); }
            );
        });

        if (snapshot.empty) return null;

        const firstDoc = snapshot.docs[0];
        return { id: firstDoc.id, ...firstDoc.data() };
    },

    // ======================================
    // CHAT PER ORDER
    // ======================================

    async sendOrderMessage(orderId, sender, text) {
        if (!orderId) throw new Error("Order ID tidak tersedia.");
        if (!text || !text.trim()) throw new Error("Pesan tidak boleh kosong.");

        await addDoc(
            collection(db, "orders", orderId, "messages"),
            {
                sender,
                text: text.trim(),
                timestamp: serverTimestamp()
            }
        );

        return true;
    },

    listenOrderMessages(orderId, callback) {
        if (!orderId) return () => {};

        const q = query(
            collection(db, "orders", orderId, "messages"),
            orderBy("timestamp", "asc")
        );

        return onSnapshot(q, (snapshot) => {
            const messages = [];
            snapshot.forEach((msgSnapshot) => {
                messages.push({
                    id: msgSnapshot.id,
                    ...msgSnapshot.data()
                });
            });

            if (typeof callback === "function") {
                callback(messages);
            }
        });
    },

    // ======================================
    // PROFIL PUBLIK RESTO
    // ======================================

    async saveRestoProfile(userId, data) {
        if (!userId) throw new Error("User ID tidak tersedia.");

        await setDoc(
            doc(db, "resto_profiles", userId),
            {
                ...data,
                updatedAt: serverTimestamp()
            },
            { merge: true }
        );

        return true;
    },

    listenApprovedRestos(callback) {
        const q = query(
            collection(db, "resto_profiles"),
            where("approved", "==", true)
        );

        return onSnapshot(q, (snapshot) => {
            const restos = [];
            snapshot.forEach((docSnap) => {
                restos.push({ id: docSnap.id, ...docSnap.data() });
            });

            if (typeof callback === "function") {
                callback(restos);
            }
        });
    },

    // ======================================
    // ORDER FOOD
    // ======================================

    listenAvailableFoodOrders(callback) {
        const q = query(
            collection(db, "orders"),
            where("type", "==", "FOOD"),
            where("status", "==", "SIAP_DIAMBIL")
        );

        return onSnapshot(q, (snapshot) => {
            const orders = [];
            snapshot.forEach((docSnap) => {
                const data = docSnap.data();
                if (!data.driverId) {
                    orders.push({ id: docSnap.id, ...data });
                }
            });

            if (typeof callback === "function") {
                callback(orders);
            }
        });
    },

    listenDriverActiveFoodOrders(driverId, callback) {
        if (!driverId) return () => {};

        const q = query(
            collection(db, "orders"),
            where("type", "==", "FOOD"),
            where("driverId", "==", driverId),
            where("status", "in", ["DIAMBIL_DRIVER", "DIANTAR"])
        );

        return onSnapshot(q, (snapshot) => {
            const orders = [];
            snapshot.forEach((docSnap) => {
                orders.push({ id: docSnap.id, ...docSnap.data() });
            });

            if (typeof callback === "function") {
                callback(orders);
            }
        });
    },

    async claimFoodOrder(orderId, driverId, driverName) {
        if (!orderId || !driverId) throw new Error("Data klaim tidak lengkap.");

        await updateDoc(
            doc(db, "orders", orderId),
            {
                driverId,
                driverName: driverName || "",
                status: "DIAMBIL_DRIVER",
                updatedAt: serverTimestamp()
            }
        );

        return true;
    }

};


// ==========================================
// ENGINE STATUS
// ==========================================

console.log("[CIKUR GO] Cloud Realtime Engine aktif.");
console.log("[CIKUR GO] Firebase Authentication aktif.");
console.log("[CIKUR GO] Firestore aktif.");
console.log("[CIKUR GO] Global Error Reporter siap terhubung ke Neural Monitor.");
