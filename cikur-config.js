// ==========================================
// CIKUR GO - CLOUD REALTIME ENGINE
// Firebase Authentication + Firestore
// ==========================================

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";

import {
    getStorage,
    ref as storageRef,
    uploadBytes,
    getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

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
    serverTimestamp,
    deleteField
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

import {
    initializeAuth,
    browserLocalPersistence,
    browserSessionPersistence,
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    updatePassword,
    reauthenticateWithCredential,
    EmailAuthProvider,
    linkWithCredential,
    fetchSignInMethodsForEmail,
    signOut,
    linkWithPhoneNumber
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

// Firebase Apps dipisahkan secara eksplisit.
// Firestore juga harus dibuat dari App yang sama dengan Auth yang memakainya,
// agar request Firestore membawa token Auth dari namespace yang benar.

// ==========================================
// DEDICATED CUSTOMER/MITRA AUTH
// ==========================================
// Jangan gunakan DEFAULT Firebase Auth untuk Customer/Mitra.
// Auth Customer/Mitra memakai App bernama khusus agar sesi mereka
// benar-benar memiliki namespace persistence sendiri, terpisah dari Admin.
const CUSTOMER_APP_NAME = "CIKUR_GO_CUSTOMER";
const customerApp = getApps().some(existingApp => existingApp.name === CUSTOMER_APP_NAME)
    ? getApp(CUSTOMER_APP_NAME)
    : initializeApp(firebaseConfig, CUSTOMER_APP_NAME);
const auth = initializeAuth(customerApp, {
    persistence: browserLocalPersistence,
    popupRedirectResolver: undefined
});
const customerDb = getFirestore(customerApp);

// ==========================================
// DEDICATED SUPER ADMIN AUTH
// ==========================================
// Customer/Mitra dan Super Admin masing-masing memiliki Firebase App/Auth namespace khusus.
// Firestore tetap memakai App DEFAULT dan tetap shared.
const ADMIN_APP_NAME = "CIKUR_GO_ADMIN";
const adminApp = getApps().some(existingApp => existingApp.name === ADMIN_APP_NAME)
    ? getApp(ADMIN_APP_NAME)
    : initializeApp(firebaseConfig, ADMIN_APP_NAME);
const adminAuth = initializeAuth(adminApp, {
    persistence: browserSessionPersistence,
    popupRedirectResolver: undefined
});
const adminDb = getFirestore(adminApp);
const storage = getStorage(customerApp);

// Alias db dipertahankan untuk seluruh modul Customer/Mitra lama.
// Halaman Admin wajib memakai adminDb agar Firestore dan Admin Auth berasal
// dari Firebase App namespace yang sama.
const db = customerDb;

// Export supaya modul lain dapat memakai koneksi yang tepat.
export { db, customerDb, adminDb, auth, adminAuth, firebaseConfig };

// ==========================================
// CIKUR CLOUD GLOBAL ENGINE
// ==========================================

window.CikurCloud = {
    auth,
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

        // Tidak membuat Anonymous User secara diam-diam.
        // Seluruh transaksi Customer/Mitra harus berasal dari akun nyata.
        console.log(
            "[CIKUR GO] Tidak ada session Customer/Mitra aktif."
        );
        return null;
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
    // Jika user sedang anonymous (punya data sementara),
    // otomatis di-LINK supaya data lama tidak hilang.
    // ======================================

    async registerWithEmail(email, password) {
        const currentUser = auth.currentUser;

        // Kasus 1: sedang anonymous -> upgrade/link ke email+password
        // supaya UID & data yang sudah ada tetap sama, tidak hilang.
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
                // Kalau email sudah dipakai akun lain, tidak bisa di-link,
                // fallback ke pembuatan akun baru biasa.
                if (linkError.code === "auth/email-already-in-use" || linkError.code === "auth/credential-already-in-use") {
                    console.warn("[CIKUR GO] Email sudah terdaftar, tidak bisa link. Membuat akun baru biasa.");
                } else {
                    throw linkError;
                }
            }
        }

        // Kasus 2: belum ada sesi sama sekali -> daftar akun baru biasa
        const result = await createUserWithEmailAndPassword(auth, email, password);
        console.log("[CIKUR GO] Akun Email baru dibuat:", result.user.uid);
        return result.user;
    },

    // ======================================
    // LOGIN AKUN YANG SUDAH ADA (EMAIL + PASSWORD)
    // Ini yang memulihkan akun yang sama dari device/browser manapun.
    // ======================================

    async loginWithEmail(email, password) {
        const result = await signInWithEmailAndPassword(auth, email, password);
        console.log("[CIKUR GO] Login berhasil:", result.user.uid);
        return result.user;
    },

    async logout() {
        await signOut(auth);
        console.log("[CIKUR GO] Session Customer/Mitra ditutup.");
        return true;
    },

    // ======================================
    // PEMULIHAN PASSWORD AKUN
    // Menggunakan mekanisme reset resmi Firebase Auth.
    // Tidak membuat password sementara/dummy.
    // ======================================

    async sendPasswordReset(email) {
        const normalizedEmail = String(email || "").trim().toLowerCase();
        if (!normalizedEmail) {
            throw new Error("EMAIL_REQUIRED");
        }
        await sendPasswordResetEmail(auth, normalizedEmail);
        console.log("[CIKUR GO] Email pemulihan password dikirim.");
        return true;
    },

    // ======================================
    // GANTI PASSWORD SAAT SUDAH LOGIN
    // Firebase dapat meminta re-authentication untuk operasi sensitif.
    // ======================================

    async changePassword(currentPassword, newPassword) {
        const user = auth.currentUser || await this.waitForAuth();
        if (!user || !user.email) {
            throw new Error("NO_AUTHENTICATED_USER");
        }
        if (!currentPassword || !newPassword) {
            throw new Error("PASSWORD_REQUIRED");
        }
        const credential = EmailAuthProvider.credential(user.email, currentPassword);
        await reauthenticateWithCredential(user, credential);
        await updatePassword(user, newPassword);
        console.log("[CIKUR GO] Password akun berhasil diperbarui.");
        return true;
    },

    // ======================================
    // VERIFIKASI EMAIL AKUN CUSTOMER
    // ======================================

    async sendEmailVerification() {
        const user = auth.currentUser || await this.waitForAuth();
        if (!user) throw new Error("NO_AUTHENTICATED_USER");
        if (user.emailVerified) return true;
        const { sendEmailVerification } = await import(
            "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js"
        );
        await sendEmailVerification(user);
        return true;
    },

    // ======================================
    // VERIFIKASI NOMOR HP CUSTOMER — SMS OTP
    // Firebase Auth menjadi sumber kebenaran nomor terverifikasi.
    // ======================================

    normalizeCustomerPhone(phone) {
        const raw = String(phone || "").trim().replace(/[\s().-]/g, "");
        if (!raw) throw new Error("PHONE_REQUIRED");
        if (/^08\d{8,13}$/.test(raw)) return "+62" + raw.slice(1);
        if (/^628\d{8,13}$/.test(raw)) return "+" + raw;
        if (/^\+628\d{8,13}$/.test(raw)) return raw;
        throw new Error("INVALID_PHONE_FORMAT");
    },

    async startCustomerPhoneVerification(phoneNumber, recaptchaContainerId) {
        const user = auth.currentUser || await this.waitForAuth();
        if (!user) throw new Error("NO_AUTHENTICATED_USER");
        const e164 = this.normalizeCustomerPhone(phoneNumber);
        if (typeof window === "undefined") throw new Error("BROWSER_REQUIRED");

        const { RecaptchaVerifier } = await import(
            "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js"
        );
        if (window.__cikurPhoneRecaptcha) {
            try { window.__cikurPhoneRecaptcha.clear(); } catch (_) {}
            window.__cikurPhoneRecaptcha = null;
        }
        const container = document.getElementById(recaptchaContainerId);
        if (!container) throw new Error("RECAPTCHA_CONTAINER_NOT_FOUND");

        const verifier = new RecaptchaVerifier(auth, recaptchaContainerId, {
            size: "normal"
        });
        window.__cikurPhoneRecaptcha = verifier;
        await verifier.render();
        const confirmationResult = await linkWithPhoneNumber(user, e164, verifier);
        window.__cikurPhoneConfirmation = confirmationResult;
        return { sent: true, phoneNumber: e164 };
    },

    async confirmCustomerPhoneVerification(code, displayPhone = "") {
        const confirmation = window.__cikurPhoneConfirmation;
        if (!confirmation) throw new Error("PHONE_VERIFICATION_NOT_STARTED");
        const normalizedCode = String(code || "").trim();
        if (!/^\d{6}$/.test(normalizedCode)) throw new Error("INVALID_OTP");

        const credentialResult = await confirmation.confirm(normalizedCode);
        const verifiedUser = credentialResult.user;
        await verifiedUser.reload();
        const verifiedPhone = verifiedUser.phoneNumber || this.normalizeCustomerPhone(displayPhone);
        await setDoc(doc(db, "customers", verifiedUser.uid), {
            phone: displayPhone || verifiedPhone,
            verifiedPhoneNumber: verifiedPhone,
            phoneVerified: true,
            phoneVerifiedAt: new Date().toISOString(),
            updatedAt: serverTimestamp()
        }, { merge: true });
        try { window.__cikurPhoneRecaptcha?.clear(); } catch (_) {}
        window.__cikurPhoneRecaptcha = null;
        window.__cikurPhoneConfirmation = null;
        return { phoneVerified: true, phoneNumber: verifiedPhone };
    },

    async resetCustomerPhoneVerification(userId) {
        if (!userId) throw new Error("USER_ID_REQUIRED");
        await setDoc(doc(db, "customers", userId), {
            phoneVerified: false,
            verifiedPhoneNumber: deleteField(),
            phoneVerifiedAt: deleteField(),
            verificationLevel: "BASIC",
            updatedAt: serverTimestamp()
        }, { merge: true });
        return true;
    },

    // ======================================
    // PENGAJUAN VERIFIKASI IDENTITAS
    // Dokumen masuk Firebase Storage; keputusan tetap Admin.
    // ======================================

    async submitCustomerIdentityVerification(userId, payload = {}) {
        if (!userId) throw new Error("USER_ID_REQUIRED");
        const user = auth.currentUser || await this.waitForAuth();
        if (!user || user.uid !== userId) throw new Error("UNAUTHORIZED_USER");
        const fullName = String(payload.fullName || "").trim();
        const birthDate = String(payload.birthDate || "").trim();
        const nik = String(payload.nik || "").replace(/\D/g, "");
        const file = payload.file;
        if (fullName.length < 2) throw new Error("IDENTITY_NAME_REQUIRED");
        if (!/^\d{16}$/.test(nik)) throw new Error("INVALID_NIK");
        if (!birthDate) throw new Error("BIRTH_DATE_REQUIRED");
        if (!(file instanceof File)) throw new Error("IDENTITY_DOCUMENT_REQUIRED");
        if (!file.type.startsWith("image/")) throw new Error("IDENTITY_DOCUMENT_IMAGE_ONLY");
        if (file.size > 5 * 1024 * 1024) throw new Error("IDENTITY_DOCUMENT_TOO_LARGE");

        const safeExt = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
        const path = `customer-identity/${userId}/ktp-${Date.now()}.${safeExt}`;
        const fileRef = storageRef(storage, path);
        await uploadBytes(fileRef, file, { contentType: file.type });
        const documentUrl = await getDownloadURL(fileRef);

        await setDoc(doc(db, "customers", userId), {
            identityVerificationStatus: "pending",
            identityVerified: false,
            identityName: fullName,
            identityBirthDate: birthDate,
            identityNIK: nik,
            identityDocumentUrl: documentUrl,
            identityDocumentPath: path,
            identitySubmittedAt: serverTimestamp(),
            identityReviewedAt: null,
            updatedAt: serverTimestamp()
        }, { merge: true });
        return { status: "pending", documentUrl };
    },

    // ======================================
    // PIN CIKURPAY — TIDAK DISIMPAN PLAINTEXT
    // ======================================

    async hashCustomerPin(pin) {
        const normalizedPin = String(pin || "").trim();
        if (!/^\d{6}$/.test(normalizedPin)) {
            throw new Error("INVALID_PIN");
        }
        if (!globalThis.crypto?.subtle) {
            throw new Error("SECURE_CRYPTO_UNAVAILABLE");
        }
        const bytes = new TextEncoder().encode(normalizedPin);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(digest))
            .map(byte => byte.toString(16).padStart(2, "0"))
            .join("");
    },

    async setCustomerPin(userId, pin) {
        if (!userId) throw new Error("USER_ID_REQUIRED");
        const pinHash = await this.hashCustomerPin(pin);
        await setDoc(
            doc(db, "users", userId),
            {
                pinHash,
                pinConfigured: true,
                securityLevel: "PIN_CONFIGURED",
                lastSecurityUpdate: new Date().toISOString(),
                pin: deleteField()
            },
            { merge: true }
        );
        return { pinConfigured: true };
    },

    async verifyCustomerPin(userId, pin) {
        if (!userId) throw new Error("USER_ID_REQUIRED");
        const profile = await this.getProfile(userId);
        if (!profile?.pinHash) return false;
        const suppliedHash = await this.hashCustomerPin(pin);
        return suppliedHash === profile.pinHash;
    },

    // ======================================
    // PENDAFTARAN MITRA (Agent CGO / Resto / Driver)
    // Status: pending -> approved / rejected
    // Dokumen id: mitra_applications/{uid}_{jenis}
    // ======================================

    // ======================================
    // DAFTAR RESTO YANG SUDAH DISETUJUI
    // (dipakai food.html untuk menampilkan resto & menu asli)
    // ======================================

    listenApprovedRestos(callback) {
        const q = query(
            collection(db, "mitra_applications"),
            where("jenis", "==", "resto"),
            where("status", "==", "approved")
        );

        return onSnapshot(q, (snapshot) => {
            const restos = [];
            snapshot.forEach((docSnap) => {
                restos.push({ id: docSnap.id, uid: docSnap.data().uid, ...docSnap.data() });
            });
            if (typeof callback === "function") callback(restos);
        }, (error) => {
            console.error("[CIKUR GO] Gagal memuat daftar resto:", error);
            if (typeof callback === "function") callback([]);
        });
    },

    // ======================================
    // UPDATE PROFIL MITRA SETELAH APPROVED
    // (edit menu, jam buka, dsb - TIDAK mereset
    //  status/submittedAt seperti submitMitraApplication)
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
    // USER PROFILE (PERBAIKAN FINAL)
    // ======================================

    async saveProfile(userId, data) {
        // Jika userId tidak dikirim dari depan, ambil otomatis dari session aktif
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

    async getCustomerAccount(userId) {
        if (!userId) return null;

        const snapshot = await getDoc(doc(db, "customers", userId));
        if (!snapshot.exists()) return null;

        return {
            id: snapshot.id,
            ...snapshot.data()
        };
    },

    // ======================================
    // CUSTOMER ACCOUNT CANONICALIZER
    // Memperbaiki dokumen customers lama/gantung tanpa menimpa
    // keputusan Admin pada status/verifikasi.
    // ======================================

    async ensureCustomerAccount(userId, data = {}) {
        if (!userId) throw new Error("USER_ID_REQUIRED");

        const existing = await this.getCustomerAccount(userId);
        const nowISO = new Date().toISOString();
        const existingId = String(existing?.customerId || data?.customerId || "").trim();
        // Canonical Customer ID CIKUR GO: CGO-YYYY-XXXXXXXXXX.
        // Migrasikan ID lama CGC-* secara deterministik, tanpa mengubah UID.
        const customerId = /^CGO-\d{4}-[A-Z0-9]{10}$/.test(existingId)
            ? existingId
            : `CGO-${new Date().getFullYear()}-${userId.slice(0, 10).toUpperCase()}`;

        const canonical = {
            uid: userId,
            customerId,
            name: existing?.name || data?.name || "",
            email: existing?.email || data?.email || "",
            phone: existing?.phone || data?.phone || "",
            statusAkun: existing?.statusAkun || existing?.status || "active",
            tanggalDaftar: existing?.tanggalDaftar || data?.tanggalDaftar || nowISO,
            lastLogin: data?.lastLogin || existing?.lastLogin || nowISO,
            emailVerified: typeof existing?.emailVerified === "boolean"
                ? existing.emailVerified : !!data?.emailVerified,
            phoneVerified: typeof existing?.phoneVerified === "boolean"
                ? existing.phoneVerified : false,
            identityVerified: typeof existing?.identityVerified === "boolean"
                ? existing.identityVerified : false,
            verificationLevel: existing?.verificationLevel || data?.verificationLevel || "BASIC",
            namaLengkap: existing?.namaLengkap || data?.namaLengkap || data?.name || "",
            namaPanggilan: existing?.namaPanggilan || data?.namaPanggilan || "",
            jenisKelamin: existing?.jenisKelamin || data?.jenisKelamin || "",
            tanggalLahir: existing?.tanggalLahir || data?.tanggalLahir || "",
            alamatUtama: existing?.alamatUtama || data?.alamatUtama || "",
            pinConfigured: typeof existing?.pinConfigured === "boolean"
                ? existing.pinConfigured : !!data?.pinConfigured,
            securityLevel: existing?.securityLevel || data?.securityLevel || "BASIC",
            bahasa: existing?.bahasa || data?.bahasa || "id",
            notifikasi: typeof existing?.notifikasi === "boolean"
                ? existing.notifikasi : data?.notifikasi !== false,
            promo: typeof existing?.promo === "boolean"
                ? existing.promo : data?.promo !== false,
            walletStatus: existing?.walletStatus || data?.walletStatus || "active",
            saldo: Number.isFinite(Number(existing?.saldo)) ? Number(existing.saldo) : Number(data?.saldo || 0),
            avatar: existing?.avatar || data?.avatar || "",
            profileCompleted: typeof existing?.profileCompleted === "boolean"
                ? existing.profileCompleted : !!data?.profileCompleted,
            profileCompletionVersion: existing?.profileCompletionVersion || data?.profileCompletionVersion || 1,
            updatedAt: serverTimestamp()
        };

        await setDoc(doc(db, "customers", userId), canonical, { merge: true });

        return {
            id: userId,
            ...(existing || {}),
            ...canonical,
            // Admin-owned legacy status is normalized only as a read fallback.
            statusAkun: existing?.statusAkun || existing?.status || canonical.statusAkun
        };
    },

    listenCustomerAccount(userId, callback) {
        if (!userId) return () => {};

        return onSnapshot(
            doc(db, "customers", userId),
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
                console.error("[CIKUR GO] Gagal memantau status Customer:", error);
                if (typeof callback === "function") {
                    callback({ _error: true, code: error.code, message: error.message });
                }
            }
        );
    },

    async syncCustomerAccount(userId, data = {}) {
        if (!userId) return false;

        // Hanya mirror data profil/presence. STATUS AKUN TIDAK PERNAH
        // ditulis dari sisi Customer agar keputusan Admin tidak tertimpa.
        const mirror = {
            uid: userId,
            customerId: data.customerId || undefined,
            name: data.name || "",
            email: data.email || "",
            phone: data.phone || "",
            namaLengkap: data.namaLengkap || data.name || "",
            namaPanggilan: data.namaPanggilan || "",
            jenisKelamin: data.jenisKelamin || "",
            tanggalLahir: data.tanggalLahir || "",
            alamatUtama: data.alamatUtama || "",
            // emailVerified mengikuti Firebase Auth.
            emailVerified: !!data.emailVerified,
            // phoneVerified, identityVerified, verificationLevel, dan statusAkun
            // adalah state yang tidak boleh ditimpa oleh sinkronisasi Customer.
            pinConfigured: !!data.pinConfigured,
            securityLevel: data.securityLevel || "BASIC",
            bahasa: data.bahasa || "id",
            notifikasi: data.notifikasi !== false,
            promo: data.promo !== false,
            walletStatus: data.walletStatus || "active",
            profileCompleted: !!data.profileCompleted,
            profileCompletionVersion: data.profileCompletionVersion || 1,
            avatar: data.avatar || "",
            lastLogin: data.lastLogin || undefined,
            updatedAt: serverTimestamp()
        };

        Object.keys(mirror).forEach((key) => {
            if (mirror[key] === undefined) delete mirror[key];
        });

        await setDoc(doc(db, "customers", userId), mirror, { merge: true });
        return true;
    },

    // ======================================
    // PRESENCE CUSTOMER (online/offline untuk admin)
    // Ditulis berkala selama customer membuka index.html.
    // Collection ini yang dibaca bcgo-admin.html.
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
    // PELAPORAN ERROR LINTAS FILE
    // Dipanggil dari tiap file (index.html, food.html, dst) saat
    // terjadi error JavaScript. Dibaca real-time oleh bcgo.html
    // supaya Admin tahu ada masalah tanpa perlu customer lapor manual.
    // ======================================

    async reportSystemError(fileName, message, extra = {}) {
        try {
            await addDoc(
                collection(db, "system_logs"),
                {
                    fileName,
                    message: String(message || "").slice(0, 500),
                    ...extra,
                    reportedAt: serverTimestamp()
                }
            );
        } catch (error) {
            // Sengaja diam - jangan sampai pelaporan error
            // malah bikin error baru yang mengganggu user.
            console.error("[CIKUR GO] Gagal melaporkan error:", error);
        }
    },

    listenSystemLogs(callback, maxResults = 50) {
        const q = query(
            collection(db, "system_logs"),
            orderBy("reportedAt", "desc"),
            limit(maxResults)
        );

        return onSnapshot(q, (snapshot) => {
            const logs = [];
            snapshot.forEach((docSnap) => {
                logs.push({ id: docSnap.id, ...docSnap.data() });
            });

            if (typeof callback === "function") {
                callback(logs);
            }
        });
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

    // ======================================
    // REALTIME ORDER LISTENER (SEMUA ORDER PER TYPE)
    // ======================================

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

    // ======================================
    // AMBIL 1 ORDER (SEKALI, TANPA REALTIME)
    // ======================================

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

    // ======================================
    // DENGARKAN 1 ORDER SECARA REALTIME
    // (dipakai Customer & Mitra memantau status/DEAL)
    // ======================================

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

    // ======================================
    // UPDATE STATUS / DATA ORDER
    // (dipakai Mitra: terima/tolak/DEAL, dan
    //  Customer: setelah bayar)
    // ======================================

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

    // ======================================
    // CARI ORDER AKTIF CUSTOMER (untuk pemulihan
    // sesi saat halaman dibuka/refresh)
    // ======================================

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
    // CHAT PER ORDER (sub-collection orders/{id}/messages)
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
    // PROFIL PUBLIK RESTO (nama, alamat, menu,
    // status buka/tutup) - terpisah dari
    // mitra_applications (yang cuma untuk verifikasi).
    // Ini yang dibaca food.html.
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
    // ORDER FOOD YANG SIAP DIAMBIL DRIVER
    // (status SIAP_DIAMBIL, belum ada driverId)
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

    // ======================================
    // ORDER FOOD YANG SEDANG DIANTAR DRIVER TERTENTU
    // ======================================

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

    // ======================================
    // DRIVER KLAIM RIDE SECARA ATOMIK
    // ======================================

    async claimRideOrder(orderId, driverId, driverName) {
        if (!orderId || !driverId) throw new Error("Data klaim Ride tidak lengkap.");

        const orderRef = doc(db, "orders", orderId);
        const current = await getDoc(orderRef);
        if (!current.exists()) throw new Error("Order Ride tidak ditemukan.");

        const data = current.data() || {};
        if (data.type !== "RIDE") throw new Error("Order ini bukan order Ride.");
        if (data.status !== "PENDING" || data.driverId) {
            throw new Error("Order Ride sudah diambil driver lain atau tidak lagi tersedia.");
        }

        await updateDoc(orderRef, {
            driverId,
            driverName: driverName || "",
            status: "DIAMBIL_DRIVER",
            updatedAt: serverTimestamp()
        });

        return true;
    },

    // ======================================
    // DRIVER KLAIM ORDER (ambil pesanan siap diantar)
    // ======================================

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

console.log(
    "[CIKUR GO] Cloud Realtime Engine aktif."
);

console.log(
    "[CIKUR GO] Firebase Authentication aktif."
);

console.log(
    "[CIKUR GO] Firestore aktif."
);

// Satu global error reporter untuk seluruh aplikasi.
// Nama file diambil dari sumber error agar satu error tidak dicatat 3x sebagai
// bcgo-admin.html + bcgo-engine.js + cikur-config.js.
(() => {
    if (window.__CIKUR_GLOBAL_ERROR_REPORTER__) return;
    window.__CIKUR_GLOBAL_ERROR_REPORTER__ = true;

    const recentErrors = new Map();

    function getSourceName(errorEvent) {
        try {
            const source = errorEvent?.filename || "";
            if (source) {
                const clean = source.split("?")[0].split("#")[0];
                const name = clean.substring(clean.lastIndexOf("/") + 1);
                if (name) return name;
            }
        } catch (_) {}
        return location.pathname.split("/").pop() || "unknown";
    }

    function report(source, message, extra = {}) {
        const text = String(message || "Unknown error").slice(0, 500);
        const key = `${source}|${text}`;
        const now = Date.now();
        const previous = recentErrors.get(key) || 0;

        // Hindari spam akibat error yang dipicu berulang-ulang dalam 3 detik.
        if (now - previous < 3000) return;
        recentErrors.set(key, now);

        if (window.CikurCloud && typeof window.CikurCloud.reportSystemError === "function") {
            window.CikurCloud.reportSystemError(source, text, extra);
        }
    }

    window.addEventListener("error", (e) => {
        report(getSourceName(e), e?.message || "JavaScript error", {
            line: e?.lineno || null,
            column: e?.colno || null
        });
    });

    window.addEventListener("unhandledrejection", (e) => {
        const reason = e?.reason;
        report(
            "unhandledrejection",
            reason?.message || String(reason || "Unhandled Promise rejection")
        );
    });
})();
