// Charges for one user's trades on one day. Extract calculates them once and stores them in the
// batch file, so the PDF worker only adds them up and never needs a rate table or a database.
//
// Simplified equity-delivery rates, close to what Indian discount brokers publish. Real rates
// change with regulation and differ by segment (intraday, F&O); a broker would load them from config.

import type { Charges, Trade } from "../../shared/types.ts";

const RATES = {
  brokeragePct: 0.0003, // 0.03% of the trade value...
  brokerageCap: 20, //     ...but at most ₹20 per trade
  sttPct: 0.001, // Securities Transaction Tax: 0.1% on buy and sell
  exchangeTxnPct: { NSE: 0.0000297, BSE: 0.0000375 },
  sebiPct: 0.000001, // ₹10 per crore
  stampDutyBuyPct: 0.00015, // 0.015%, buy side only
  gstPct: 0.18, // 18% GST on brokerage + exchange + SEBI fees (not on taxes)
};

// Money in rupees with 2 decimals. Rounded at the end, per user, so rounding errors don't add up.
const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeCharges(trades: Trade[]): Charges {
  let brokerage = 0;
  let stt = 0;
  let exchangeTxn = 0;
  let sebi = 0;
  let stampDuty = 0;

  for (const t of trades) {
    const value = t.qty * t.price;
    brokerage += Math.min(value * RATES.brokeragePct, RATES.brokerageCap);
    stt += value * RATES.sttPct;
    exchangeTxn += value * RATES.exchangeTxnPct[t.exchange];
    sebi += value * RATES.sebiPct;
    if (t.side === "BUY") stampDuty += value * RATES.stampDutyBuyPct;
  }

  const gst = (brokerage + exchangeTxn + sebi) * RATES.gstPct;

  return {
    brokerage: round2(brokerage),
    stt: round2(stt),
    exchangeTxn: round2(exchangeTxn),
    gst: round2(gst),
    sebi: round2(sebi),
    stampDuty: round2(stampDuty),
  };
}
