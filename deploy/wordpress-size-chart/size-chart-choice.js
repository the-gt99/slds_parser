(() => {
  const selector = document.querySelector("[data-size-chart-choice]");
  if (!selector) return;
  const container = document.getElementById(selector.getAttribute("aria-controls"));
  if (!container) return;
  const panels = Array.from(container.querySelectorAll("[data-size-chart-panel]"));
  const update = () => {
    for (const panel of panels) {
      const selected = selector.value !== "" && panel.dataset.sizeChartPanel === selector.value;
      panel.hidden = !selected;
      panel.style.display = selected ? "" : "none";
    }
  };
  selector.addEventListener("change", update);
  document.addEventListener("selectCallback", (event) => {
    if (event.detail?.select === selector) update();
  });
  update();
})();
