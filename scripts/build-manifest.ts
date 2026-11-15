// Layer 3: run the BuildManifest handler from the laptop, after `npm run extract`.
// In layer 4 it is a Lambda that Step Functions calls with the same { tradeDate }.
//
//   npm run build-manifest -- --date 2026-10-16

import { parseArgs } from "node:util";
import { handler } from "../packages/manifest/src/handler.ts";

const { values } = parseArgs({ options: { date: { type: "string", default: "2026-10-16" } } });

const result = await handler({ tradeDate: values.date });
console.log(JSON.stringify(result, null, 2));
