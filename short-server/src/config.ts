import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 5000),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5432/postgres",
  jwtSecret: process.env.JWT_SECRET ?? "super-secret-change-me",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:5000",
};
