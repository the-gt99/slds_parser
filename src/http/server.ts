import Fastify, { type FastifyInstance } from "fastify";

export interface DatabaseHealthClient {
  query(sql: string): Promise<unknown>;
}

export function createHttpServer(
  database: DatabaseHealthClient,
): FastifyInstance {
  const server = Fastify({ logger: true });

  server.get("/api/health", async (_request, reply) => {
    try {
      await database.query("SELECT 1");
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  return server;
}
