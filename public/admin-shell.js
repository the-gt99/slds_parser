const sections = [
  ["/overview", "Обзор", ["/overview"]],
  ["/classifier", "Классификация", ["/classifier", "/classifier-config"]],
  ["/data-schema", "Схема данных", ["/data-schema"]],
  ["/rules-v2", "Правила v2", ["/rules-v2"]],
  ["/content-templates", "Шаблоны контента", ["/content-templates"]],
  ["/products", "Товары", ["/products"]],
  ["/export-control", "Контроль экспорта", ["/export-control"]],
  ["/wordpress-catalog", "Каталог WordPress", ["/wordpress-catalog"]],
  ["/jobs", "Очередь и ошибки", ["/jobs"]],
  ["/wordpress-snapshots", "Снимки WordPress", ["/wordpress-snapshots"]],
];

function isActive(paths) {
  return paths.some((path) => location.pathname === path || (path === "/products" && location.pathname.startsWith("/products/")));
}

for (const navigation of document.querySelectorAll(".admin-nav")) {
  const links = sections.map(([href, label, paths]) => {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = label;
    if (isActive(paths)) {
      link.className = "active";
      link.setAttribute("aria-current", "page");
    }
    return link;
  });
  navigation.replaceChildren(...links);
}

for (const actions of document.querySelectorAll(".topbar-actions")) {
  const operator = actions.querySelector("#operator-name");
  if (!operator) continue;
  const settings = document.createElement("details");
  settings.className = "settings-menu";
  if (["/settings/parser", "/settings/proxies", "/runtime", "/proxies"].includes(location.pathname)) settings.classList.add("active");
  const trigger = document.createElement("summary");
  trigger.className = "settings-trigger";
  trigger.setAttribute("aria-label", "Настройки");
  trigger.title = "Настройки";
  trigger.innerHTML = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.86 1.86-.06-.06A1.7 1.7 0 0 0 16 18.4a1.7 1.7 0 0 0-1 1.56V20H9v-.04a1.7 1.7 0 0 0-1-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-1.86-1.86.06-.06A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3.04 14H3v-4h.04A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88L4.2 7.06 6.06 5.2l.06.06A1.7 1.7 0 0 0 8 5.6 1.7 1.7 0 0 0 9 4.04V4h6v.04A1.7 1.7 0 0 0 16 5.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 1.86 1.86-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.56 1H21v4h-.04A1.7 1.7 0 0 0 19.4 15Z"/></svg>';
  const menu = document.createElement("div");
  menu.className = "settings-dropdown";
  for (const [href, label] of [["/settings/parser", "Настройки парсера"], ["/settings/proxies", "Прокси"]]) {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = label;
    if (location.pathname === href || (href === "/settings/parser" && location.pathname === "/runtime") || (href === "/settings/proxies" && location.pathname === "/proxies")) link.setAttribute("aria-current", "page");
    menu.append(link);
  }
  settings.append(trigger, menu);
  actions.insertBefore(settings, operator);
  document.addEventListener("click", (event) => { if (!settings.contains(event.target)) settings.open = false; });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") settings.open = false; });
}
