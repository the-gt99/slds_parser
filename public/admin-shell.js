const sections = [
  ["/classifier", "Классификация", ["/classifier", "/classifier-config"]],
  ["/content-templates", "Шаблоны контента", ["/content-templates"]],
  ["/products", "Товары", ["/products"]],
  ["/export-control", "Контроль экспорта", ["/export-control"]],
  ["/wordpress-catalog", "Каталог WordPress", ["/wordpress-catalog"]],
  ["/operations", "Операции", ["/operations"]],
  ["/runtime", "Парсер", ["/runtime"]],
  ["/jobs", "Очередь и ошибки", ["/jobs"]],
  ["/wordpress-snapshots", "Снимки WordPress", ["/wordpress-snapshots"]],
  ["/proxies", "Прокси", ["/proxies"]],
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
