const token = location.pathname.split("/").filter(Boolean).at(-1);
const byId = (id) => document.getElementById(id);
const stepIds = ["certificate", "wireguard", "trust", "search", "verify", "complete"];
const numberedSteps = stepIds.slice(0, 5);
const trustedStages = new Set(["certificate_trusted", "challenge_not_found", "authorized_request_rejected", "profile_incomplete", "profile_captured", "verification_failed", "ready"]);
let currentStep = ""; let recommendedStep = ""; let manualStep = null; let lastProbeAt = 0;
let completionSent = false; let verificationAttempted = false; let verificationRunning = false;

async function request(path = "", options = {}) {
  const response = await fetch(`/api/shihuo/onboarding/${encodeURIComponent(token)}${path}`, { cache: "no-store", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Ссылка недействительна или истекла");
  return data;
}

function showStep(step) {
  for (const id of stepIds) byId(`step-${id}`).hidden = id !== step;
  currentStep = step;
  const number = numberedSteps.indexOf(step) + 1;
  byId("progress-label").textContent = step === "complete" ? "Настройка завершена" : `Шаг ${number} из 5`;
  byId("progress").hidden = false; byId("current-step").hidden = manualStep === null;
  for (const button of document.querySelectorAll("[data-onboarding-step]")) {
    const id = button.dataset.onboardingStep;
    button.classList.toggle("active", id === step);
    button.classList.toggle("done", numberedSteps.indexOf(id) < numberedSteps.indexOf(recommendedStep));
  }
}

function desiredStep(data) {
  if (data.status === "ready" || data.diagnosticStage === "ready") return "complete";
  if (data.profileCaptured) return "verify";
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
  lastProbeAt = Date.now(); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 7000);
  try { await fetch(`https://195.161.68.104/slds-shihuo-ca-check?t=${Date.now()}`, { cache: "no-store", mode: "cors", signal: controller.signal }); }
  catch { byId("trust-help").hidden = false; }
  finally { clearTimeout(timeout); }
}

async function verifyProfile() {
  if (verificationRunning || verificationAttempted) return;
  verificationRunning = true; verificationAttempted = true; byId("verify-retry").hidden = true;
  byId("verify-status").textContent = "Отправляем контрольный запрос к Shihuo…";
  try {
    const result = await request("/verify", { method: "POST" });
    if (!result.verified) { byId("verify-status").textContent = result.message; byId("verify-retry").hidden = false; }
    await refresh();
  } catch (error) { byId("verify-status").textContent = error.message; byId("verify-retry").hidden = false; }
  finally { verificationRunning = false; }
}

async function acknowledgeCompletion(data) {
  if (completionSent || data.completionAcknowledged) return;
  completionSent = true; await new Promise((resolve) => setTimeout(resolve, 1000));
  try { await request("/complete", { method: "POST" }); } catch { completionSent = false; }
}

async function refresh() {
  const data = await request();
  byId("device-name").textContent = `Устройство: ${data.name}`; byId("challenge").textContent = data.challenge;
  byId("ios-link").href = data.iosAppUrl; byId("android-link").href = data.androidAppUrl;
  recommendedStep = desiredStep(data); const visibleStep = manualStep ?? recommendedStep;
  showStep(visibleStep);
  if (recommendedStep === "search") byId("search-status").textContent = searchMessage(data.diagnosticStage, data.diagnosticMessage);
  if (data.diagnosticStage === "verification_failed") { byId("verify-status").textContent = data.diagnosticMessage || "Проверка не прошла."; byId("verify-retry").hidden = false; verificationAttempted = true; }
  await probeCertificate(data);
  if (recommendedStep === "verify" && data.diagnosticStage !== "verification_failed") void verifyProfile();
  if (recommendedStep === "complete") void acknowledgeCompletion(data);
}

byId("ca-link").href = `/api/shihuo/onboarding/${encodeURIComponent(token)}/ca`;
byId("config-link").href = `/api/shihuo/onboarding/${encodeURIComponent(token)}/config`;
byId("wg-qr").src = `/api/shihuo/onboarding/${encodeURIComponent(token)}/qr`;
for (const button of document.querySelectorAll("[data-onboarding-step]")) button.onclick = () => { manualStep = button.dataset.onboardingStep; showStep(manualStep); };
byId("current-step").onclick = () => { manualStep = null; showStep(recommendedStep); };
byId("certificate-next").onclick = async () => {
  const button = byId("certificate-next"); button.disabled = true;
  try { await request("/certificate-ack", { method: "POST" }); manualStep = null; await refresh(); }
  catch (error) { byId("fatal").textContent = error.message; byId("fatal").hidden = false; }
  finally { button.disabled = false; }
};
byId("copy").onclick = async () => { await navigator.clipboard.writeText(byId("challenge").textContent); byId("copy").textContent = "Скопировано"; };
byId("verify-retry").onclick = () => { verificationAttempted = false; void verifyProfile(); };

try { await refresh(); setInterval(() => void refresh().catch(() => {}), 2000); }
catch (error) { byId("fatal").textContent = error.message; byId("fatal").hidden = false; }
