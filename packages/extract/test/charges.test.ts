import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCharges } from "../src/charges.ts";
import type { Trade } from "../../shared/types.ts";

const trade = (t: Partial<Trade>): Trade => ({
  tradeId: "T1", symbol: "INFY", side: "BUY", qty: 1, price: 1, exchange: "NSE", time: "10:00:00", ...t,
});

test("big NSE buy: brokerage capped at ₹20, stamp duty charged", () => {
  // value = 100 × 1000 = ₹1,00,000
  assert.deepEqual(computeCharges([trade({ qty: 100, price: 1000 })]), {
    brokerage: 20, // 0.03% would be ₹30, capped
    stt: 100,
    exchangeTxn: 2.97,
    gst: 4.15, // 18% of (20 + 2.97 + 0.1)
    sebi: 0.1,
    stampDuty: 15,
  });
});

test("small BSE sell: percentage brokerage, BSE rate, no stamp duty", () => {
  // value = 10 × 2000 = ₹20,000
  assert.deepEqual(computeCharges([trade({ side: "SELL", exchange: "BSE", qty: 10, price: 2000 })]), {
    brokerage: 6,
    stt: 20,
    exchangeTxn: 0.75,
    gst: 1.22, // 18% of (6 + 0.75 + 0.02)
    sebi: 0.02,
    stampDuty: 0,
  });
});

test("no trades, no charges", () => {
  assert.deepEqual(computeCharges([]), { brokerage: 0, stt: 0, exchangeTxn: 0, gst: 0, sebi: 0, stampDuty: 0 });
});
