// ==========================================
// CIKUR GO - CLOUD REALTIME ENGINE
// Firebase Authentication + Firestore
// ==========================================

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";

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
    getDocs,
    serverTimestamp,
    deleteField,
    runTransaction
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

import {
    initializeAuth,
    browserLocalPersistence,
    browserSessionPersistence,
    browserPopupRedirectResolver,
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
    linkWithPhoneNumber,
    GoogleAuthProvider,
    signInWithPopup
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
// Local persistence is preferred; session persistence is the browser-level
// fallback if the environment refuses the local storage mechanism.
// Both still belong exclusively to the Customer Auth namespace.
const customerApp = getApps().some(existingApp => existingApp.name === CUSTOMER_APP_NAME)
    ? getApp(CUSTOMER_APP_NAME)
    : initializeApp(firebaseConfig, CUSTOMER_APP_NAME);
const auth = initializeAuth(customerApp, {
    persistence: [browserLocalPersistence, browserSessionPersistence],
    popupRedirectResolver: browserPopupRedirectResolver
});
const customerDb = getFirestore(customerApp);

// ==========================================
// DEDICATED SUPER ADMIN AUTH
// ==========================================
// Customer/Mitra dan Super Admin masing-masing memiliki Firebase App/Auth namespace khusus.
// Admin memakai local persistence agar sesi Super Admin tetap tersedia
// ketika BCGO Admin & Data dibuka sebagai halaman/tab terpisah.
// Namespace Admin tetap terisolasi dari Customer/Mitra.
const ADMIN_APP_NAME = "CIKUR_GO_ADMIN";
// Local persistence is preferred; session persistence is the browser-level
// fallback if the environment refuses the local storage mechanism.
// Admin remains isolated from Customer Auth.
const adminApp = getApps().some(existingApp => existingApp.name === ADMIN_APP_NAME)
    ? getApp(ADMIN_APP_NAME)
    : initializeApp(firebaseConfig, ADMIN_APP_NAME);
const adminAuth = initializeAuth(adminApp, {
    persistence: [browserLocalPersistence, browserSessionPersistence],
    popupRedirectResolver: undefined
});
const adminDb = getFirestore(adminApp);

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
    adminAuth,

    /**
     * Menunggu auth Customer/Mitra settled setelah refresh.
     * - Jika currentUser sudah ada, langsung pakai (hindari race restore).
     * - Jika belum, tunggu event pertama onAuthStateChanged.
     * - Timeout aman agar UI tidak menggantung selamanya.
     */
    waitForAuth(timeoutMs = 8000) {
        if (auth.currentUser) {
            console.log("[CIKUR GO] Auth state (current):", auth.currentUser.uid);
            return Promise.resolve(auth.currentUser);
        }
        return new Promise((resolve) => {
            let done = false;
            const finish = (user) => {
                if (done) return;
                done = true;
                try { unsubscribe(); } catch (_) {}
                clearTimeout(timer);
                console.log(
                    "[CIKUR GO] Auth state:",
                    user ? user.uid : "TIDAK ADA USER"
                );
                resolve(user || null);
            };
            const unsubscribe = onAuthStateChanged(auth, (user) => finish(user));
            const timer = setTimeout(() => {
                // Setelah timeout, percaya currentUser (bisa sudah ter-restore).
                finish(auth.currentUser || null);
            }, Math.max(1500, Number(timeoutMs) || 8000));
        });
    },

    /**
     * Sama seperti waitForAuth, tapi untuk namespace Admin (CIKUR_GO_ADMIN).
     * Dipakai bcgo-admin / data-cgo / bcgo monitor.
     */
    waitForAdminAuth(timeoutMs = 8000) {
        if (adminAuth.currentUser) {
            console.log("[CIKUR GO] Admin auth state (current):", adminAuth.currentUser.uid);
            return Promise.resolve(adminAuth.currentUser);
        }
        return new Promise((resolve) => {
            let done = false;
            const finish = (user) => {
                if (done) return;
                done = true;
                try { unsubscribe(); } catch (_) {}
                clearTimeout(timer);
                console.log(
                    "[CIKUR GO] Admin auth state:",
                    user ? user.uid : "TIDAK ADA ADMIN"
                );
                resolve(user || null);
            };
            const unsubscribe = onAuthStateChanged(adminAuth, (user) => finish(user));
            const timer = setTimeout(() => {
                finish(adminAuth.currentUser || null);
            }, Math.max(1500, Number(timeoutMs) || 8000));
        });
    },

    async ensureAuth() {
        let user = auth.currentUser;
        if (user) {
            console.log("[CIKUR GO] User aktif:", user.uid);
            return user;
        }

        user = await this.waitForAuth();
        if (user) {
            console.log("[CIKUR GO] Session dipulihkan:", user.uid);
            return user;
        }

        // Tidak membuat Anonymous User secara diam-diam.
        console.log("[CIKUR GO] Tidak ada session Customer/Mitra aktif.");
        return null;
    },

    async ensureAdminAuth() {
        let user = adminAuth.currentUser;
        if (user) return user;
        user = await this.waitForAdminAuth();
        return user || null;
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

    async loginWithGoogle() {
        const provider = new GoogleAuthProvider();
        const result = await signInWithPopup(auth, provider);
        console.log("[CIKUR GO] Login Google berhasil:", result.user.uid);
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
    // ======================================
    // KOMPRESI GAMBAR → BASE64 (Firestore only, tanpa Storage)
    // Max ~900px, quality 0.65 agar dokumen < 1MB
    // ======================================

    async fileToCompressedDataUrl(file, maxWidth = 900, quality = 0.65) {
        if (!(file instanceof File)) throw new Error("FILE_REQUIRED");
        if (!file.type.startsWith("image/")) throw new Error("IMAGE_ONLY");
        if (file.size > 8 * 1024 * 1024) throw new Error("FILE_TOO_LARGE");

        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error("READ_FAILED"));
            reader.readAsDataURL(file);
        });

        // Kompres lewat canvas
        const img = await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("IMAGE_LOAD_FAILED"));
            image.src = dataUrl;
        });

        let { width, height } = img;
        if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        const compressed = canvas.toDataURL("image/jpeg", quality);

        // Guard ukuran string (~750KB aman untuk beberapa foto per dokumen)
        if (compressed.length > 900000) {
            const tighter = canvas.toDataURL("image/jpeg", 0.45);
            if (tighter.length > 900000) throw new Error("IMAGE_STILL_TOO_LARGE");
            return tighter;
        }
        return compressed;
    },

    // Kompatibel dengan pemanggilan lama uploadMitraDocument → { url, path }
    // url = data URL base64; path = null (tidak pakai Storage)
    async uploadMitraDocument(userId, file, docType = "ktp") {
        if (!userId) throw new Error("USER_ID_REQUIRED");
        const url = await this.fileToCompressedDataUrl(file);
        return { url, path: null, storage: "firestore-base64", docType };
    },

    async uploadMitraDocuments(userId, filesMap = {}) {
        if (!userId) throw new Error("USER_ID_REQUIRED");
        const result = { _paths: {} };
        const entries = Object.entries(filesMap).filter(([, f]) => f instanceof File);
        for (const [key, file] of entries) {
            const uploaded = await this.uploadMitraDocument(userId, file, key);
            result[key] = uploaded.url;
            result._paths[key] = null;
        }
        return result;
    },

    // PENGAJUAN VERIFIKASI IDENTITAS (base64 di Firestore, tanpa Storage)
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
        if (file.size > 8 * 1024 * 1024) throw new Error("IDENTITY_DOCUMENT_TOO_LARGE");

        const documentUrl = await this.fileToCompressedDataUrl(file, 900, 0.65);

        await setDoc(doc(db, "customers", userId), {
            identityVerificationStatus: "pending",
            identityVerified: false,
            identityName: fullName,
            identityBirthDate: birthDate,
            identityNIK: nik,
            identityDocumentUrl: documentUrl,
            identityDocumentPath: null,
            identityStorage: "firestore-base64",
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
    // LOKASI LIVE DRIVER (untuk tracking peta customer)
    // Ditulis berkala oleh driver.html selagi driver online,
    // dibaca realtime oleh ride.html/food.html saat order diklaim.
    // ======================================

    async updateDriverLiveLocation(driverId, lat, lon) {
        if (!driverId || !Number.isFinite(lat) || !Number.isFinite(lon)) return;

        try {
            await setDoc(
                doc(db, "users", driverId),
                {
                    liveLocation: { lat, lon, updatedAt: serverTimestamp() }
                },
                { merge: true }
            );
        } catch (error) {
            console.error("[CIKUR GO] Gagal memperbarui lokasi live driver:", error);
        }
    },

    listenDriverLocation(driverId, callback) {
        if (!driverId) return () => {};

        return onSnapshot(doc(db, "users", driverId), (snap) => {
            if (!snap.exists()) { callback(null); return; }
            callback(snap.data().liveLocation || null);
        });
    },

    // ======================================
    // SALDO / WALLET CIKURPAY
    // CATATAN: ini adalah wallet INTERNAL CIKUR GO (saldo tersimpan &
    // terpotong secara konsisten di Firestore). Untuk isi saldo dari uang
    // asli (transfer bank/QRIS/e-wallet), nanti tinggal disambungkan ke
    // payment gateway (mis. Midtrans/Xendit) yang memanggil topUpSaldo()
    // ini setelah pembayaran gateway dikonfirmasi sukses.
    // Pakai runTransaction supaya aman walau tombol dipencet dobel/cepat.
    // ======================================

    async topUpSaldo(userId, amount, method = "MANUAL") {
        if (!userId) {
            const currentUser = await this.ensureAuth();
            if (!currentUser) throw new Error("Sesi tidak ditemukan. Silakan login kembali.");
            userId = currentUser.uid;
        }

        amount = Number(amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error("Jumlah top up tidak valid.");
        }

        const userRef = doc(db, "users", userId);
        const newBalance = await runTransaction(db, async (tx) => {
            const snap = await tx.get(userRef);
            const currentSaldo = Number(snap.data()?.saldo || 0);
            const updated = currentSaldo + amount;
            tx.set(userRef, { saldo: updated }, { merge: true });
            return updated;
        });

        await addDoc(collection(db, "walletTransactions"), {
            userId,
            type: "TOPUP",
            amount,
            method,
            balanceAfter: newBalance,
            timestamp: serverTimestamp()
        });

        return newBalance;
    },

    async payWithSaldo(userId, amount, orderId, description = "") {
        if (!userId) {
            const currentUser = await this.ensureAuth();
            if (!currentUser) throw new Error("Sesi tidak ditemukan. Silakan login kembali.");
            userId = currentUser.uid;
        }

        amount = Number(amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error("Jumlah pembayaran tidak valid.");
        }

        const userRef = doc(db, "users", userId);
        const newBalance = await runTransaction(db, async (tx) => {
            const snap = await tx.get(userRef);
            const currentSaldo = Number(snap.data()?.saldo || 0);
            if (currentSaldo < amount) {
                throw new Error("Saldo CikurPay tidak cukup. Silakan top up terlebih dahulu.");
            }
            const updated = currentSaldo - amount;
            tx.set(userRef, { saldo: updated }, { merge: true });
            return updated;
        });

        await addDoc(collection(db, "walletTransactions"), {
            userId,
            type: "PAYMENT",
            amount: -amount,
            orderId: orderId || null,
            description,
            balanceAfter: newBalance,
            timestamp: serverTimestamp()
        });

        if (orderId) {
            await updateDoc(doc(db, "orders", orderId), {
                paymentStatus: "PAID",
                paidWithSaldo: true
            }).catch(() => {});
        }

        return newBalance;
    },

    listenWalletTransactions(userId, callback, max = 20) {
        if (!userId) return () => {};

        const q = query(
            collection(db, "walletTransactions"),
            where("userId", "==", userId),
            orderBy("timestamp", "desc"),
            limit(max)
        );

        return onSnapshot(q, (snap) => {
            callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        });
    },

    // ======================================
    // NOTIFIKASI / INBOX CUSTOMER
    // Dibuat OTOMATIS oleh createOrder() & updateOrderStatus()
    // di bawah, jadi Inbox index.html selalu sinkron dengan
    // kejadian nyata di food.html/ride.html/driver.html/resto.html.
    // ======================================

    async createNotification(userId, title, body, meta = {}) {
        if (!userId) return;
        try {
            await addDoc(collection(db, "notifications"), {
                userId,
                title,
                body,
                meta,
                isRead: false,
                timestamp: serverTimestamp()
            });
        } catch (error) {
            console.error("[CIKUR GO] Gagal membuat notifikasi:", error);
        }
    },

    listenNotifications(userId, callback, max = 30) {
        if (!userId) return () => {};

        const q = query(
            collection(db, "notifications"),
            where("userId", "==", userId),
            orderBy("timestamp", "desc"),
            limit(max)
        );

        return onSnapshot(q, (snap) => {
            callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        });
    },

    async markNotificationRead(notificationId) {
        if (!notificationId) return;
        try {
            await updateDoc(doc(db, "notifications", notificationId), { isRead: true });
        } catch (error) {
            console.error("[CIKUR GO] Gagal menandai notifikasi:", error);
        }
    },

    async markAllNotificationsRead(userId) {
        if (!userId) return;
        try {
            const q = query(collection(db, "notifications"), where("userId", "==", userId), where("isRead", "==", false));
            const snap = await new Promise((resolve, reject) => {
                const unsub = onSnapshot(q, (s) => { unsub(); resolve(s); }, (e) => { unsub(); reject(e); });
            });
            await Promise.all(snap.docs.map(d => updateDoc(doc(db, "notifications", d.id), { isRead: true })));
        } catch (error) {
            console.error("[CIKUR GO] Gagal menandai semua notifikasi:", error);
        }
    },

    // ======================================
    // SEMUA ORDER AKTIF CUSTOMER LINTAS MODUL
    // (FOOD + RIDE + ASSISTANT digabung, untuk tab "Pesanan")
    // ======================================

    listenAllActiveOrdersForCustomer(userId, callback) {
        if (!userId) return () => {};

        const q = query(
            collection(db, "orders"),
            where("userId", "==", userId),
            where("status", "not-in", ["SELESAI", "DITOLAK_RESTO", "DIBATALKAN_CUSTOMER", "DIBATALKAN"]),
            orderBy("timestamp", "desc"),
            limit(20)
        );

        return onSnapshot(q, (snap) => {
            callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        });
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

        const orderTypeLabelMap = { FOOD: "CIKUR Food", RIDE: "CIKUR Ride", ASSISTANT: "CIKUR Assistant" };
        this.createNotification(
            firebaseUser.uid,
            "Pesanan Dibuat",
            `Pesanan ${orderTypeLabelMap[type] || type} kamu berhasil dibuat dan sedang diproses.`,
            { orderId: orderReference.id, type, status: "PENDING" }
        ).catch(() => {});

        return {
            id: orderReference.id,
            ...orderData
        };
    },

    // ======================================
    // BUNDLE 2IN1 (FOOD + ASSISTANT DINE-IN)
    // Membuat SEPASANG order (FOOD & ASSISTANT) sekaligus,
    // lalu menautkannya lewat satu dokumen "bundles".
    // ======================================

    async create2in1Bundle(bundleDetails) {
        const {
            customerName,
            customerPhone,
            restoId,
            restoName,
            items,
            foodSubtotal,
            foodTotal,
            foodNotes,
            assistantFee,
            serviceFee,
            grandTotal,
            paymentMethod,
            packageKey,
            packageName,
            schedule,
            location,
            assistantNotes
        } = bundleDetails || {};

        if (!Array.isArray(items) || !items.length) {
            throw new Error("Data menu 2IN1 tidak lengkap.");
        }

        const firebaseUser = await this.ensureAuth();
        if (!firebaseUser) {
            throw new Error("Sesi Customer tidak ditemukan. Silakan login kembali.");
        }

        // 1. Buat order FOOD
        const foodOrder = await this.createOrder("FOOD", {
            restoId: restoId || "",
            restoName: restoName || "Mitra Resto Cikur",
            customerName,
            customerPhone,
            items,
            subtotal: Number(foodSubtotal) || 0,
            deliveryFee: 0,
            total: Number(foodTotal) || 0,
            paymentMethod,
            notes: foodNotes || "",
            address: location || null,
            mode: "2IN1"
        });

        // 2. Buat order ASSISTANT (dine-in), ditautkan ke order FOOD di atas
        const assistantOrder = await this.createOrder("ASSISTANT", {
            service: "ASSISTANT",
            packageKey: packageKey || "dine",
            packageName: packageName || "DINE-IN ASSISTANT",
            source: "CIKURGO_2IN1",
            customer: { name: customerName, phone: customerPhone },
            schedule: schedule || {},
            location: location || null,
            notes: assistantNotes || "",
            pricing: {
                basePrice: Number(assistantFee) || 0,
                serviceFee: Number(serviceFee) || 0,
                total: (Number(assistantFee) || 0) + (Number(serviceFee) || 0)
            },
            linkedFoodOrderId: foodOrder.id
        });

        // 3. Simpan dokumen bundle penghubung
        const bundleRef = await addDoc(collection(db, "bundles"), {
            type: "2IN1",
            userId: firebaseUser.uid,
            customerName,
            customerPhone,
            foodOrderId: foodOrder.id,
            assistantOrderId: assistantOrder.id,
            grandTotal: Number(grandTotal) || 0,
            paymentMethod,
            status: "PENDING",
            timestamp: new Date()
        });

        // 4. Tautkan balik bundleId ke masing-masing order
        await updateDoc(doc(db, "orders", foodOrder.id), {
            bundleId: bundleRef.id,
            linkedAssistantOrderId: assistantOrder.id
        });
        await updateDoc(doc(db, "orders", assistantOrder.id), {
            bundleId: bundleRef.id,
            linkedFoodOrderId: foodOrder.id
        });

        return {
            bundleId: bundleRef.id,
            foodOrder,
            assistantOrder
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

        if (updateData?.status) {
            try {
                const orderSnap = await getDoc(doc(db, "orders", orderId));
                if (orderSnap.exists()) {
                    const orderData = orderSnap.data();
                    const orderTypeLabelMap = { FOOD: "CIKUR Food", RIDE: "CIKUR Ride", ASSISTANT: "CIKUR Assistant" };
                    const statusTextMap = {
                        DIAMBIL_DRIVER: "driver sudah menuju lokasi kamu",
                        DIMASAK: "sedang disiapkan resto",
                        SIAP_DIAMBIL: "siap diambil driver",
                        DIANTAR: "sedang diantar ke lokasi kamu",
                        SELESAI: "telah selesai",
                        DITOLAK_RESTO: "ditolak oleh resto",
                        DIBATALKAN_CUSTOMER: "dibatalkan oleh customer",
                        DIBATALKAN: "dibatalkan"
                    };
                    const statusText = statusTextMap[updateData.status] || updateData.status;
                    this.createNotification(
                        orderData.userId,
                        (orderTypeLabelMap[orderData.type] || orderData.type) + " — Update Status",
                        `Pesanan kamu ${statusText}.`,
                        { orderId, type: orderData.type, status: updateData.status }
                    ).catch(() => {});
                }
            } catch (notifyError) {
                console.error("[CIKUR GO] Gagal membuat notifikasi status order:", notifyError);
            }
        }

        return true;
    },

    /**
     * Batalkan order oleh customer (Gojek-style early cancel).
     * FOOD: boleh saat PENDING / DIMASAK
     * RIDE: boleh saat PENDING (belum di-claim driver)
     * Mengembalikan objek { refunded, refundAmount } bila CikurPay.
     */
    async cancelOrderByCustomer(orderId, userId, reason = "") {
        if (!orderId || !userId) throw new Error("Data pembatalan tidak lengkap.");

        const orderRef = doc(db, "orders", orderId);
        const snap = await getDoc(orderRef);
        if (!snap.exists()) throw new Error("Pesanan tidak ditemukan.");

        const data = snap.data() || {};
        if (data.userId !== userId) throw new Error("Pesanan ini bukan milik akun kamu.");

        const status = data.status;
        const type = data.type;
        const allowedFood = ["PENDING", "DIMASAK"];
        const allowedRide = ["PENDING"];
        const allowed = type === "FOOD" ? allowedFood : type === "RIDE" ? allowedRide : ["PENDING"];

        if (!allowed.includes(status)) {
            throw new Error(
                type === "RIDE"
                    ? "Ride hanya bisa dibatalkan sebelum driver menerima order."
                    : "Pesanan food hanya bisa dibatalkan sebelum siap diambil driver."
            );
        }

        await updateDoc(orderRef, {
            status: "DIBATALKAN_CUSTOMER",
            cancelledAt: serverTimestamp(),
            cancelReason: String(reason || "").slice(0, 200),
            updatedAt: serverTimestamp()
        });

        let refunded = false;
        let refundAmount = 0;
        const pay = String(data.paymentMethod || "");
        const alreadyPaid = data.paymentStatus === "PAID" || /cikurpay|saldo/i.test(pay);
        const amount = Number(data.fare || data.total || 0);

        if (alreadyPaid && amount > 0 && data.userId) {
            try {
                // topUpSaldo sebagai pengembalian (internal wallet)
                if (typeof this.topUpSaldo === "function") {
                    await this.topUpSaldo(data.userId, amount, "REFUND_CANCEL");
                    refunded = true;
                    refundAmount = amount;
                    await updateDoc(orderRef, {
                        paymentStatus: "REFUNDED",
                        refundAmount: amount,
                        updatedAt: serverTimestamp()
                    });
                }
            } catch (refundErr) {
                console.error("[CIKUR GO] Refund gagal:", refundErr);
            }
        }

        try {
            await this.sendOrderMessage(
                orderId,
                "system",
                refunded
                    ? `Pesanan dibatalkan customer. Saldo Rp ${refundAmount.toLocaleString("id-ID")} dikembalikan.`
                    : "Pesanan dibatalkan oleh customer."
            );
        } catch (_) {}

        try {
            await this.createNotification(
                data.userId,
                "Pesanan dibatalkan",
                refunded
                    ? `Pembatalan berhasil. Refund Rp ${refundAmount.toLocaleString("id-ID")} masuk CikurPay.`
                    : "Pembatalan berhasil.",
                { orderId, type, status: "DIBATALKAN_CUSTOMER" }
            );
        } catch (_) {}

        return { ok: true, refunded, refundAmount };
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
            where("status", "not-in", ["SELESAI", "DITOLAK_RESTO", "DIBATALKAN_CUSTOMER", "DIBATALKAN"]),
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
    // SETTLEMENT RIDE (dipanggil driver saat menyelesaikan ride)
    //  - Tunai    : saldo driver dipotong sebesar komisi aplikator (platformFee)
    //  - CikurPay : saldo driver ditambah pendapatan driver (driverEarning)
    // Aman dipanggil berulang: order yang sudah settled dilewati.
    // ======================================

    async settleRideOrder(orderId, driverId) {
        if (!orderId || !driverId) throw new Error("Data order/driver tidak lengkap.");
        await this.ensureAuth();

        const orderRef = doc(db, "orders", orderId);
        const userRef = doc(db, "users", driverId);

        const result = await runTransaction(db, async (tx) => {
            const orderSnap = await tx.get(orderRef);
            if (!orderSnap.exists()) throw new Error("Order tidak ditemukan.");
            const o = orderSnap.data();
            if (o.driverId !== driverId) throw new Error("Order ini bukan milik kamu.");
            if (o.settled) return { skipped: true, reason: "already" };

            const earning = Number(o.driverEarning);
            const fee = Number(o.platformFee);
            if (!Number.isFinite(earning) || !Number.isFinite(fee)) return { skipped: true, reason: "nosplit" };

            const isCash = o.paymentStatus !== "PAID" && !/cikurpay|saldo/i.test(String(o.paymentMethod || ""));
            const userSnap = await tx.get(userRef);
            const saldo = Number(userSnap.data()?.saldo || 0);
            const delta = isCash ? -fee : earning;
            const newSaldo = saldo + delta;

            tx.set(userRef, { saldo: newSaldo }, { merge: true });
            tx.update(orderRef, { settled: true, settledAt: new Date() });
            return { skipped: false, isCash, delta, newSaldo };
        });

        if (!result.skipped) {
            await addDoc(collection(db, "walletTransactions"), {
                userId: driverId,
                type: result.isCash ? "COMMISSION" : "RIDE_EARNING",
                amount: result.delta,
                orderId,
                description: result.isCash ? "Komisi aplikator order tunai" : "Pendapatan ride (CikurPay)",
                balanceAfter: result.newSaldo,
                timestamp: serverTimestamp()
            }).catch(() => {});
        }
        return result;
    },

    // ======================================
    // RIWAYAT ORDER CUSTOMER (semua status, terbaru dulu)
    // Sengaja hanya pakai 2 filter "==" supaya tidak butuh index gabungan;
    // pengurutan dilakukan di sisi klien.
    // ======================================

    async listOrderHistory(userId, type, maxResults = 30) {
        if (!userId) return [];

        const q = query(
            collection(db, "orders"),
            where("userId", "==", userId),
            where("type", "==", type || "RIDE")
        );

        const snapshot = await new Promise((resolve, reject) => {
            const unsubscribe = onSnapshot(
                q,
                (snap) => { unsubscribe(); resolve(snap); },
                (err) => { unsubscribe(); reject(err); }
            );
        });

        const list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        const ms = (o) => (o.timestamp && o.timestamp.toMillis ? o.timestamp.toMillis() : 0);
        return list.sort((a, b) => ms(b) - ms(a)).slice(0, maxResults);
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

    /**
     * Snapshot sekali: resto approved (untuk otak CGO discovery).
     * Tidak mengarang — hanya data Firestore yang terbaca.
     */
    async listApprovedRestosOnce() {
        const q = query(
            collection(db, "resto_profiles"),
            where("approved", "==", true)
        );
        const snap = await getDocs(q);
        const restos = [];
        snap.forEach((docSnap) => {
            restos.push({ id: docSnap.id, ...docSnap.data() });
        });
        return restos;
    },

    /**
     * Agent CGO approved + online (untuk radar / discovery customer).
     * Field presence.location atau liveLocation dipakai untuk jarak.
     * Jika rules menolak, lempar error — adapter discovery menangani sebagai UNKNOWN.
     */
    async listOnlineAgentsOnce() {
        const q = query(
            collection(db, "mitra_applications"),
            where("jenis", "==", "agent"),
            where("status", "==", "approved")
        );
        const snap = await getDocs(q);
        const agents = [];
        const now = Date.now();
        snap.forEach((docSnap) => {
            const d = docSnap.data() || {};
            const online = d.isOnline === true || d.operationalStatus === "online" || (d.presence && d.presence.active === true);
            if (!online) return;
            const loc = (d.presence && d.presence.location) || d.liveLocation || null;
            const lat = Number(loc && (loc.lat ?? loc.latitude));
            const lng = Number(loc && (loc.lng ?? loc.longitude ?? loc.lon));
            const hasGeo = Number.isFinite(lat) && Number.isFinite(lng);
            let updatedMs = 0;
            const rawTs = (d.presence && d.presence.updatedAt) || (loc && loc.updatedAt) || d.updatedAt;
            try {
                if (rawTs && typeof rawTs.toMillis === "function") updatedMs = rawTs.toMillis();
                else if (rawTs) updatedMs = Date.parse(rawTs) || 0;
            } catch (_) {}
            const ageMs = updatedMs ? Math.max(0, now - updatedMs) : null;
            agents.push({
                id: docSnap.id,
                agentId: String(d.uid || docSnap.id.replace(/_agent$/, "")),
                name: String(d.namaPanggilan || d.name || d.agentName || "Agent CGO"),
                type: "agent",
                isOnline: true,
                available: d.presence?.available !== false,
                location: hasGeo ? { lat, lng, accuracy: loc?.accuracy ?? null } : null,
                ageMs,
                updatedAt: rawTs || null
            });
        });
        return agents;
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
    // ORDER RIDE YANG MENUNGGU DRIVER (PENDING, belum ada driverId)
    // ======================================

    listenAvailableRideOrders(callback) {
        const q = query(
            collection(db, "orders"),
            where("type", "==", "RIDE"),
            where("status", "==", "PENDING")
        );

        return onSnapshot(q, (snapshot) => {
            const orders = [];
            snapshot.forEach((docSnap) => {
                const data = docSnap.data();
                if (!data.driverId) {
                    orders.push({ id: docSnap.id, ...data });
                }
            });
            if (typeof callback === "function") callback(orders);
        });
    },

    // ======================================
    // ORDER RIDE YANG SEDANG DITANGANI DRIVER TERTENTU
    // ======================================

    listenDriverActiveRideOrders(driverId, callback) {
        if (!driverId) return () => {};

        const q = query(
            collection(db, "orders"),
            where("type", "==", "RIDE"),
            where("driverId", "==", driverId),
            where("status", "in", ["DIAMBIL_DRIVER", "DIANTAR"])
        );

        return onSnapshot(q, (snapshot) => {
            const orders = [];
            snapshot.forEach((docSnap) => {
                orders.push({ id: docSnap.id, ...docSnap.data() });
            });
            if (typeof callback === "function") callback(orders);
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
