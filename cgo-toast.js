/**
 * CIKUR GO — Shared Modern Toast
 * Satu file untuk semua halaman. Override window.alert agar konsisten.
 */
(function () {
    if (window.__CGO_TOAST_READY__) return;
    window.__CGO_TOAST_READY__ = true;

    const STYLE_ID = "cgo-modern-toast-style";
    const CSS = `
.cgo-modern-toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom,0px));transform:translate(-50%,18px);width:min(390px,calc(100% - 24px));z-index:2147483646;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .22s ease,transform .3s cubic-bezier(.16,1,.3,1),visibility .22s ease;font-family:inherit;}
.cgo-modern-toast.show{opacity:1;visibility:visible;transform:translate(-50%,0);}
.cgo-modern-toast-card{position:relative;display:flex;align-items:center;gap:11px;padding:12px 38px 12px 12px;background:rgba(255,255,255,.98);border:1px solid rgba(15,23,42,.08);border-radius:17px;box-shadow:0 16px 38px rgba(15,23,42,.18),0 5px 14px rgba(15,23,42,.08);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);overflow:hidden;}
.cgo-modern-toast-icon{width:38px;height:38px;flex:0 0 38px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:#dcfce7;color:#16a34a;font-size:18px;font-weight:900;}
.cgo-modern-toast-title{font-size:12px;font-weight:800;color:#0f172a;margin-bottom:2px;}
.cgo-modern-toast-message{font-size:10.5px;line-height:1.4;font-weight:600;color:#64748b;}
.cgo-modern-toast-close{position:absolute;right:8px;top:8px;width:24px;height:24px;border:0;border-radius:50%;background:#f1f5f9;color:#64748b;font-size:16px;line-height:1;cursor:pointer;}
.cgo-modern-toast.warning .cgo-modern-toast-icon{background:#fef3c7;color:#d97706;}
.cgo-modern-toast.error .cgo-modern-toast-icon{background:#fee2e2;color:#e50914;}
@media(max-width:440px){.cgo-modern-toast{width:calc(100% - 20px);bottom:calc(14px + env(safe-area-inset-bottom,0px));}}
`.trim();

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    function ensureDom() {
        let box = document.getElementById("cgoModernToast");
        if (box) return box;
        box = document.createElement("div");
        box.id = "cgoModernToast";
        box.className = "cgo-modern-toast";
        box.setAttribute("aria-hidden", "true");
        box.innerHTML = `
<div class="cgo-modern-toast-card">
  <div id="cgoModernToastIcon" class="cgo-modern-toast-icon">✓</div>
  <div style="min-width:0;">
   <div id="cgoModernToastTitle" class="cgo-modern-toast-title">CIKUR GO</div>
   <div id="cgoModernToastMessage" class="cgo-modern-toast-message"></div>
  </div>
  <button id="cgoModernToastClose" class="cgo-modern-toast-close" type="button" aria-label="Tutup">×</button>
</div>`;
        document.body.appendChild(box);
        return box;
    }

    let timer = null;

    function hide() {
        clearTimeout(timer);
        const box = document.getElementById("cgoModernToast");
        if (!box) return;
        box.classList.remove("show");
        box.setAttribute("aria-hidden", "true");
    }

    function show(type, title, message) {
        ensureStyle();
        const box = ensureDom();
        const icon = document.getElementById("cgoModernToastIcon");
        const titleEl = document.getElementById("cgoModernToastTitle");
        const msgEl = document.getElementById("cgoModernToastMessage");
        const close = document.getElementById("cgoModernToastClose");

        clearTimeout(timer);
        box.classList.remove("success", "warning", "error");
        box.classList.add(type || "success");
        if (icon) icon.textContent = type === "error" ? "×" : type === "warning" ? "!" : "✓";
        if (titleEl) titleEl.textContent = title || "CIKUR GO";
        if (msgEl) msgEl.textContent = String(message || "");
        box.classList.add("show");
        box.setAttribute("aria-hidden", "false");
        timer = setTimeout(hide, 3600);
        if (close && !close.__cgoBound) {
            close.__cgoBound = true;
            close.addEventListener("click", hide);
        }
    }

    window.showCGOModernNotification = show;
    window.closeCGOModernNotification = hide;

    window.alert = function (text) {
        const s = String(text || "");
        let type = "success";
        let t = "Berhasil";
        if (/gagal|error|salah|ditolak|tidak berhasil/i.test(s)) {
            type = "error";
            t = "Terjadi Kesalahan";
        } else if (/harus|belum|tidak cocok|wajib|silakan|perhatian/i.test(s)) {
            type = "warning";
            t = "Perhatian";
        }
        show(type, t, s);
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () {
            ensureStyle();
            ensureDom();
        });
    } else {
        ensureStyle();
        ensureDom();
    }
})();
