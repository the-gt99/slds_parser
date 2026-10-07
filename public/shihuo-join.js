const button = document.getElementById("join");
const message = document.getElementById("join-status");
const resetButton = document.getElementById("new-request");
const storageKey = "shihuo-public-request-v1";

function requestKey() {
  const saved = localStorage.getItem(storageKey);
  if (saved && /^[a-f0-9]{64}$/u.test(saved)) return saved;
  const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(storageKey, key);
  return key;
}

button.onclick = async () => {
  button.disabled = true; resetButton.hidden = true; message.textContent = "Подготавливаем персональную инструкцию…";
  try {
    const response = await fetch("/api/shihuo/join", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestKey: requestKey() }) });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 410) resetButton.hidden = false;
      throw new Error(data.message || "Не удалось создать заявку. Попробуйте позже.");
    }
    const path = new URL(data.onboardingUrl).pathname;
    if (!/^\/shihuo\/onboarding\/[A-Za-z0-9_-]{40,60}$/u.test(path)) throw new Error("Сервер вернул некорректную ссылку.");
    location.assign(path);
  } catch (error) { message.textContent = error.message; button.disabled = false; }
};

resetButton.onclick = () => { localStorage.removeItem(storageKey); resetButton.hidden = true; void button.onclick(); };
if (localStorage.getItem(storageKey)) button.textContent = "Продолжить мою заявку";
