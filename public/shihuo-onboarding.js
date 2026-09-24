const token = location.pathname.split("/").filter(Boolean).at(-1);
const byId = (id) => document.getElementById(id);
const stepIds = ["certificate", "wireguard", "trust", "search", "complete"];
const trustedStages = new Set(["certificate_trusted", "challenge_not_found", "authorized_request_rejected", "profile_incomplete", "ready"]);
let currentStep = "";
let lastProbeAt = 0;
let completionSent = false;

async function request(path = "", options = {}) {
  const response = await fetch(`/api/shihuo/onboarding/${encodeURIComponent(token)}${path}`, { cache: "no-store", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Ссылка недействительна или истекла");
  return data;
}

function showStep(step) {
  for (const id of stepIds) byId(`step-${id}`).hidden = id !== step;
  currentStep = step;
  const number = { certificate: 1, wireguard: 2, trust: 3, search: 4, complete: 5 }[step];
  byId("progress-label").textContent = step === "complete" ? "Настройка завершена" : `Шаг ${number} из 4`;
  byId("progress").hidden = false;
}

function desiredStep(data) {
  if (data.status === "ready" || data.diagnosticStage === "ready") return "complete";
  const certificateWasProven = trustedStages.has(data.diagnosticStage);
  if (!data.certificateAcknowledged && !certificateWasProven) return "certificate";
  if (!data.wireguardConnected) return "wireguard";
  if (certificateWasProven) return "search";
  return "trust";
}

function searchMessage(stage, message) {
  if (stage === "authorized_request_rejected") return "Выйдите из аккаунта Shihuo и повторите поиск.";
  if (stage === "profile_incomplete") return message || "Запрос найден, но в нём не хватает данных. Повторите поиск.";
  if (stage === "challenge_not_found") return "VPN и сертификат работают. Ожидаем поиск именно по этому артикулу…";
  return "Ожидаем поисковый запрос…";
}

async function probeCertificate(data) {
  if (!data.wireguardConnected || trustedStages.has(data.diagnosticStage) || Date.now() - lastProbeAt < 5000) return;
  lastProbeAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    await fetch(`https://ipv4only.arpa/slds-shihuo-ca-check?t=${Date.now()}`, { cache: "no-store", mode: "cors", signal: controller.signal });
  } catch {
    if (currentStep === "trust") byId("trust-help").hidden = false;
  } finally { clearTimeout(timeout); }
}

async function acknowledgeCompletion(data) {
  if (completionSent || data.completionAcknowledged) return;
  completionSent = true;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  try { await request("/complete", { method: "POST" }); }
  catch { completionSent = false; }
}

async function refresh() {
  const data = await request();
  byId("device-name").textContent = `Устройство: ${data.name}`;
  byId("challenge").textContent = data.challenge;
  byId("ios-link").href = data.iosAppUrl;
  byId("android-link").href = data.androidAppUrl;
  const step = desiredStep(data);
  if (step !== currentStep) showStep(step);
  if (step === "search") byId("search-status").textContent = searchMessage(data.diagnosticStage, data.diagnosticMessage);
  await probeCertificate(data);
  if (step === "complete") void acknowledgeCompletion(data);
}

byId("ca-link").href = `/api/shihuo/onboarding/${encodeURIComponent(token)}/ca`;
byId("config-link").href = `/api/shihuo/onboarding/${encodeURIComponent(token)}/config`;
byId("wg-qr").src = `/api/shihuo/onboarding/${encodeURIComponent(token)}/qr`;
byId("certificate-next").onclick = async () => {
  const button = byId("certificate-next");
  button.disabled = true;
  try { await request("/certificate-ack", { method: "POST" }); await refresh(); }
  catch (error) { byId("fatal").textContent = error.message; byId("fatal").hidden = false; }
  finally { button.disabled = false; }
};
byId("copy").onclick = async () => {
  await navigator.clipboard.writeText(byId("challenge").textContent);
  byId("copy").textContent = "Скопировано";
};

try {
  await refresh();
  setInterval(() => void refresh().catch(() => {}), 2000);
} catch (error) {
  byId("fatal").textContent = error.message;
  byId("fatal").hidden = false;
}
