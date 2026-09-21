name: 🐛 Bug Report
description: Laporkan masalah untuk membantu kami memperbaiki cikur-ai
title: "[BUG] "
labels: ["bug"]
assignees:
  - cikurgo

body:
  - type: markdown
    attributes:
      value: |
        Terima kasih telah melapor! Mohon isi detail di bawah ini agar kami bisa segera memperbaikinya.

  - type: textarea
    id: description
    attributes:
      label: Deskripsi Masalah
      description: Jelaskan apa yang terjadi secara singkat dan jelas.
      placeholder: Contoh: Tombol login tidak berfungsi setelah update terbaru...
    validations:
      required: true

  - type: textarea
    id: reproduction
    attributes:
      label: Langkah Reproduksi
      description: Langkah-langkah untuk memunculkan error tersebut.
      placeholder: |
        1. Buka halaman '...'
        2. Klik tombol '....'
        3. Scroll ke bawah sampai '....'
        4. Lihat error yang muncul
    validations:
      required: true

  - type: textarea
    id: expected
    attributes:
      label: Perilaku yang Diharapkan
      description: Apa yang seharusnya terjadi jika tidak ada bug?
    validations:
      required: true

  - type: dropdown
    id: device
    attributes:
      label: Device / Perangkat
      options:
        - HP Android
        - iPhone / iOS
        - Desktop / Laptop
        - Tablet
        - Lainnya
    validations:
      required: true

  - type: dropdown
    id: browser
    attributes:
      label: Browser
      options:
        - Chrome
        - Safari
        - Firefox
        - Edge
        - Lainnya
    validations:
      required: true

  - type: dropdown
    id: role
    attributes:
      label: Role Pengguna
      options:
        - Admin
        - Customer
        - Mitra
        - Guest
    validations:
      required: true

  - type: input
    id: url
    attributes:
      label: URL Halaman Error
      description: Link halaman tempat masalah terjadi (jika ada).
      placeholder: https://cikurgo.github.io/cikur-ai/...

  - type: textarea
    id: screenshot
    attributes:
      label: Screenshot
      description: Tempelkan screenshot atau drag & drop gambar di sini untuk memperjelas.

