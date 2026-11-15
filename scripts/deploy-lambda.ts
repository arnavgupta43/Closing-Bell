// Creates (or updates) the pdf-worker Lambda in LocalStack from dist/pdf-worker.zip.
//
//   npm run deploy-lambda      (runs build-lambda first)
//
// Rerunnable: LocalStack forgets everything on restart, so run this after every `docker compose up`.
// In production this would be Terraform or CDK (desired state, reviewable in git, one-command teardown).

import { readFileSync } from "node:fs";
import {
  CreateFunctionCommand,
  GetFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionActiveV2,
  waitUntilFunctionUpdatedV2,
} from "@aws-sdk/client-lambda";
import { BUCKET, ensureBucket, makeS3Client } from "../packages/shared/s3.ts";
import { FUNCTION_NAME, makeLambdaClient } from "./lambda-client.ts";

const lambda = makeLambdaClient();
const zip = readFileSync("dist/pdf-worker.zip");

// Everything about the function except its code. Used for both create and update.
const config = {
  FunctionName: FUNCTION_NAME,
  Runtime: "nodejs22.x" as const,
  Handler: "index.handler", // file index.js, exported function `handler`
  // LocalStack doesn't check IAM, so any well-formed role ARN works. On real AWS (layer 8) this
  // role must exist and allow s3:GetObject/PutObject on the bucket and ses:SendRawEmail.
  Role: "arn:aws:iam::000000000000:role/pdf-worker",
  Timeout: 60, // seconds; default is 3, which a batch of PDFs + emails can exceed. Max is 900.
  MemorySize: 512, // MB; on AWS, CPU scales with memory, and PDF rendering is CPU work
  Environment: {
    Variables: {
      BUCKET,
      SMTP_HOST: "mailpit", // Mailpit's name on the Docker network, see LAMBDA_DOCKER_NETWORK
      SMTP_PORT: "1025",
    },
  },
};

await ensureBucket(makeS3Client());

// Does the function already exist? GetFunction throws ResourceNotFoundException if not.
let exists = true;
try {
  await lambda.send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
} catch (err) {
  if ((err as Error).name !== "ResourceNotFoundException") throw err;
  exists = false;
}

const wait = { client: lambda, maxWaitTime: 120 };

if (!exists) {
  await lambda.send(new CreateFunctionCommand({ ...config, Code: { ZipFile: zip } }));
  // A new function starts "Pending" while it is set up; invoking it then fails.
  await waitUntilFunctionActiveV2(wait, { FunctionName: FUNCTION_NAME });
  console.log(`created ${FUNCTION_NAME}`);
} else {
  // Code and config are separate API calls, and each must finish before the next starts.
  await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: FUNCTION_NAME, ZipFile: zip }));
  await waitUntilFunctionUpdatedV2(wait, { FunctionName: FUNCTION_NAME });
  await lambda.send(new UpdateFunctionConfigurationCommand(config));
  await waitUntilFunctionUpdatedV2(wait, { FunctionName: FUNCTION_NAME });
  console.log(`updated ${FUNCTION_NAME}`);
}
