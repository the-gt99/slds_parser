import { createApplication } from "../bootstrap.js";

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());

const application = createApplication();
try {
  await application.worker.run(controller.signal);
} finally {
  await application.close();
}
