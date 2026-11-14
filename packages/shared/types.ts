// Data contracts shared by the pipeline. Shapes match docs/ARCHITECTURE.md §5.

export type Trade = {
  tradeId: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number; // rupees
  exchange: "NSE" | "BSE";
  time: string; // "HH:MM:SS", IST
};

// Calculated by Extract and carried in the batch file; the PDF worker only adds them up.
export type Charges = {
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  gst: number;
  sebi: number;
  stampDuty: number;
};

// One user inside a batch file: everything needed to produce their note, no DB lookup.
export type BatchUser = {
  id: string;
  email: string;
  name: string;
  trades: Trade[];
  charges: Charges;
};

// batches/<tradeDate>/batch-NNNN.json: written by Extract, read by the PDF worker.
export type Batch = {
  tradeDate: string;
  users: BatchUser[];
};

// What the PDF worker returns for one batch file. Goes to WrapUp, never to Postgres.
export type BatchResult = {
  key: string;
  sent: number;
  failed: { userId: string; reason: string }[];
};
