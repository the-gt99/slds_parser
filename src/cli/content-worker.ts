import { createApplication } from "../bootstrap.js";

const controller = new AbortController();
for (const signal of ["SIGINT","SIGTERM"] as const) process.once(signal,() => controller.abort());
// This role has one content lane and no collection, export or inventory lanes.
const application = createApplication({ ...process.env, WORKER_ROLE: "content-enrichment", WORKER_ID: "content-enrichment-worker" });
try { await application.worker.run(controller.signal); }
finally { await application.close(); }
