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

// batches/<tradeDate>/batch-RR-PPPP.json (range, page): written by Extract, read by the PDF worker.
export type Batch = {
  tradeDate: string;
  users: BatchUser[];
};

// manifest/<tradeDate>/manifest.json: written by BuildManifest after every extractor finished.
// The day's fixed to-do list: one PDF worker run per entry in `files`.
export type Manifest = {
  tradeDate: string;
  files: string[]; // full S3 keys, each one is a PDF worker input { key }
};

// What the PDF worker returns for one batch file. Goes to WrapUp, never to Postgres.
export type BatchResult = {
  key: string;
  sent: number;
  failed: { userId: string; reason: string }[];
};
