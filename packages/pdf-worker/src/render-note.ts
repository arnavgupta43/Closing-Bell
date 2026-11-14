// One user + trade date → a contract note PDF and its fingerprint (hash).
// Pure: no clock, no network, no database. Same input → same bytes.

import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import type { BatchUser, Charges } from "../../shared/types.ts";

const BROKER = "Closing Bell Broking Ltd.";

// ---------- 1. Calculate ----------

// Money is added up in paise (whole numbers) so 0.1 + 0.2 style float errors can't creep in.
const toPaise = (rupees: number) => Math.round(rupees * 100);
const toRupees = (paise: number) => paise / 100;

export type NoteLine = {
  tradeId: string;
  time: string;
  symbol: string;
  exchange: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  value: number; // qty × price
};

export type Note = {
  noteNo: string;
  tradeDate: string;
  client: { id: string; name: string; email: string };
  lines: NoteLine[];
  buyValue: number;
  sellValue: number;
  charges: Charges;
  totalCharges: number;
  net: number; // > 0: client receives, < 0: client pays
};

export function calculateNote(user: BatchUser, tradeDate: string): Note {
  const lines = user.trades.map((t) => ({
    tradeId: t.tradeId,
    time: t.time,
    symbol: t.symbol,
    exchange: t.exchange,
    side: t.side,
    qty: t.qty,
    price: t.price,
    value: toRupees(toPaise(t.qty * t.price)),
  }));

  const sumPaise = (values: number[]) => values.reduce((sum, v) => sum + toPaise(v), 0);

  const buyPaise = sumPaise(lines.filter((l) => l.side === "BUY").map((l) => l.value));
  const sellPaise = sumPaise(lines.filter((l) => l.side === "SELL").map((l) => l.value));
  const chargesPaise = sumPaise(Object.values(user.charges));

  // Fields are listed explicitly (not spread from input) so the object, and its hash,
  // always has the same key order.
  return {
    noteNo: `CN-${tradeDate.replaceAll("-", "")}-${user.id}`,
    tradeDate,
    client: { id: user.id, name: user.name, email: user.email },
    lines,
    buyValue: toRupees(buyPaise),
    sellValue: toRupees(sellPaise),
    charges: user.charges,
    totalCharges: toRupees(chargesPaise),
    net: toRupees(sellPaise - buyPaise - chargesPaise),
  };
}

// ---------- 2. Sign (simplified) ----------

// SHA-256 of the note's data: a fingerprint that changes if any trade, charge or total changes.
// We hash the data, not the PDF bytes, because the hash is printed inside the PDF.
// Production: a DSC certificate signature embedded in the PDF (talking point, not built).
export function hashNote(note: Note): string {
  return createHash("sha256").update(JSON.stringify(note)).digest("hex");
}

// ---------- 3. Render ----------

const money = (n: number) =>
  n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function renderNote(
  user: BatchUser,
  tradeDate: string,
): Promise<{ pdf: Buffer; hash: string }> {
  const note = calculateNote(user, tradeDate);
  const hash = hashNote(note);

  // CreationDate comes from tradeDate, not the clock: pdfkit would otherwise stamp "now"
  // into the file and the same note would produce different bytes on every run.
  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
    info: {
      Title: `Contract Note ${note.noteNo}`,
      Author: BROKER,
      CreationDate: new Date(`${tradeDate}T00:00:00Z`),
    },
  });

  // pdfkit streams the file out in chunks; collect them into one Buffer.
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  // Header
  doc.fontSize(16).font("Helvetica-Bold").text(BROKER);
  doc.fontSize(12).text("Contract Note");
  doc.moveDown(0.5).fontSize(9).font("Helvetica");
  doc.text(`Note No: ${note.noteNo}`);
  doc.text(`Trade Date: ${note.tradeDate}`);
  doc.moveDown();

  // Client
  doc.font("Helvetica-Bold").text("Client");
  doc.font("Helvetica").text(`${note.client.name} (${note.client.id})`);
  doc.text(note.client.email);
  doc.moveDown();

  // Trades
  doc.font("Helvetica-Bold").text("Trades");
  doc.moveDown(0.3);
  table(
    doc,
    ["Time", "Trade ID", "Symbol", "Exch", "Side", "Qty", "Price (INR)", "Value (INR)"],
    note.lines.map((l) => [
      l.time, l.tradeId, l.symbol, l.exchange, l.side,
      String(l.qty), money(l.price), money(l.value),
    ]),
  );
  doc.moveDown();

  // Charges and totals
  doc.font("Helvetica-Bold").text("Charges");
  doc.moveDown(0.3);
  table(doc, ["Item", "Amount (INR)"], [
    ["Brokerage", money(note.charges.brokerage)],
    ["STT", money(note.charges.stt)],
    ["Exchange transaction charges", money(note.charges.exchangeTxn)],
    ["GST", money(note.charges.gst)],
    ["SEBI fees", money(note.charges.sebi)],
    ["Stamp duty", money(note.charges.stampDuty)],
    ["Total charges", money(note.totalCharges)],
  ]);
  doc.moveDown();

  doc.font("Helvetica").text(`Buy value: ${money(note.buyValue)}`);
  doc.text(`Sell value: ${money(note.sellValue)}`);
  doc.font("Helvetica-Bold").text(
    note.net >= 0
      ? `Net amount receivable by client: INR ${money(note.net)}`
      : `Net amount payable by client: INR ${money(-note.net)}`,
  );
  doc.moveDown(2);

  // Signature block
  doc.font("Helvetica-Bold").text(`Digitally signed by ${BROKER}`);
  doc.font("Helvetica").fontSize(8).text(`SHA-256: ${hash}`);

  doc.end();
  return { pdf: await done, hash };
}

// A minimal table: equal-width columns, one row of text each. No borders, kept simple.
function table(doc: PDFKit.PDFDocument, header: string[], rows: string[][]) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const colWidth = width / header.length;

  const row = (cells: string[], bold: boolean) => {
    const y = doc.y;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8);
    cells.forEach((cell, i) => doc.text(cell, left + i * colWidth, y, { width: colWidth - 4 }));
    doc.x = left;
    doc.y = y + 14;
  };

  row(header, true);
  rows.forEach((cells) => row(cells, false));
  doc.fontSize(9);
}
