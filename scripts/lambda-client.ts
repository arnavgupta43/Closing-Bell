// Lambda API client for the laptop scripts (deploy, invoke). Talks to LocalStack.

import { LambdaClient } from "@aws-sdk/client-lambda";
import { REGION, localEndpoint } from "../packages/shared/s3.ts";

export const FUNCTION_NAME = "pdf-worker";

export function makeLambdaClient(): LambdaClient {
  return new LambdaClient({
    region: REGION,
    endpoint: localEndpoint(),
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}
