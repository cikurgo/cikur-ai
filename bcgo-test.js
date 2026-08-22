/**
 * ============================================================
 * BCGO — TEST ENGINE
 * Brain CIKUR GO
 * ============================================================
 *
 * File ini HANYA untuk pengujian BCGO Engine.
 *
 * Tidak digunakan oleh:
 * - agentcgo.html
 * - resto.html
 * - driver.html
 *
 * Tidak digunakan sebagai database.
 * Tidak digunakan sebagai sistem produksi.
 * ============================================================
 */

"use strict";


/* ============================================================
   LOAD BCGO ENGINE
============================================================ */

const {
    bcgoEvaluatePartner
} = require("./bcgo-engine.js");


/* ============================================================
   TEST 1 — ASSISTANT
============================================================ */

console.log("\n");
console.log("==============================================");
console.log(" BCGO TEST 01 — ASSISTANT");
console.log("==============================================");


const assistantTest = {

    partnerType: "assistant",

    name: "Test Assistant",

    phone: "081234567890",

    address: "Pandeglang",

    serviceType: "Assistant"
};


const assistantResult =
    bcgoEvaluatePartner(assistantTest);


console.log(
    JSON.stringify(
        assistantResult,
        null,
        2
    )
);


/* ============================================================
   TEST 2 — RESTAURANT
============================================================ */

console.log("\n");
console.log("==============================================");
console.log(" BCGO TEST 02 — RESTAURANT");
console.log("==============================================");


const restaurantTest = {

    partnerType: "restaurant",

    name: "Test Owner",

    phone: "081234567890",

    address: "Pandeglang",

    businessName: "Test Resto"
};


const restaurantResult =
    bcgoEvaluatePartner(restaurantTest);


console.log(
    JSON.stringify(
        restaurantResult,
        null,
        2
    )
);


/* ============================================================
   TEST 3 — DRIVER
============================================================ */

console.log("\n");
console.log("==============================================");
console.log(" BCGO TEST 03 — DRIVER");
console.log("==============================================");


const driverTest = {

    partnerType: "driver",

    name: "Test Driver",

    phone: "081234567890",

    address: "Pandeglang",

    vehicleType: "Motor"
};


const driverResult =
    bcgoEvaluatePartner(driverTest);


console.log(
    JSON.stringify(
        driverResult,
        null,
        2
    )
);


/* ============================================================
   TEST FINISHED
============================================================ */

console.log("\n");
console.log("==============================================");
console.log(" BCGO TEST FINISHED");
console.log("==============================================");

console.log(
    "BCGO Engine berhasil dipanggil untuk:"
);

console.log("- Assistant");
console.log("- Restaurant");
console.log("- Driver");

console.log("\n");
