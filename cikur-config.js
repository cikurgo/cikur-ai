// ==========================================
// CIKUR GO - CLOUD REALTIME ENGINE (TERHUBUNG)
// ==========================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, addDoc, onSnapshot, query, where, setDoc, doc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Konfigurasi asli Cikur Go Indonesia milikmu
const firebaseConfig = {
  apiKey: "AIzaSyBV2dQa-MoN5zPuNHA6Tda4L4aLoeL_QDw",
  authDomain: "cikur-go-indonesia.firebaseapp.com",
  projectId: "cikur-go-indonesia",
  storageBucket: "cikur-go-indonesia.firebasestorage.app",
  messagingSenderId: "1058616161176",
  appId: "1:1058616161176:web:3b3983d79cc722ab4e71ed",
  measurementId: "G-WCSSXJRS0B"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Fungsi Global untuk seluruh halaman Cikur Go
window.CikurCloud = {
    // 1. Simpan/Update Profil Pengguna
    async saveProfile(userId, data) {
        try {
            await setDoc(doc(db, "users", userId), data, { merge: true });
            console.log("Profil tersimpan di Cloud secara nyata!");
        } catch (e) {
            console.error("Gagal simpan profil:", e);
        }
    },

    // 2. Kirim Pesanan (ASSISTANT, FOOD, RIDE, 2IN1)
    async createOrder(type, orderDetails) {
        try {
            await addDoc(collection(db, "orders"), {
                type: type,
                ...orderDetails,
                status: "PENDING",
                timestamp: new Date()
            });
            console.log("Pesanan berhasil dikirim ke Cloud!");
            alert("Pesanan berhasil dikirim ke sistem Cikur Go!");
        } catch (e) {
            console.error("Gagal kirim pesanan:", e);
            alert("Gagal mengirim pesanan. Cek koneksi!");
        }
    },

    // 3. Pantau Pesanan Masuk Real-Time (Untuk Mitra/Resto/Driver)
    listenOrders(type, callback) {
        const q = query(collection(db, "orders"), where("type", "==", type));
        onSnapshot(q, (snapshot) => {
            let orders = [];
            snapshot.forEach((doc) => {
                orders.push({ id: doc.id, ...doc.data() });
            });
            callback(orders);
        });
    }
};

console.log("Cikur Go terhubung ke Cloud secara NYATA & HIDUP!");
