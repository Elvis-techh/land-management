export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  frontendOrigins: string[];
};

const allowedEnvironments = new Set<AppConfig["nodeEnv"]>([
  "development",
  "test",
  "production",
]);

export function loadConfig(environment = process.env): AppConfig {
  const rawNodeEnv = environment.NODE_ENV ?? "development";
  const nodeEnv = allowedEnvironments.has(rawNodeEnv as AppConfig["nodeEnv"])
    ? (rawNodeEnv as AppConfig["nodeEnv"])
    : "development";
  const port = Number(environment.PORT ?? 3000);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return {
    nodeEnv,
    host: environment.HOST ?? "0.0.0.0",
    port,
    frontendOrigins: (environment.FRONTEND_ORIGIN ?? "http://localhost:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}

