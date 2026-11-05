import { icon } from "../icons.ts";

export function closeCustomSelects(root: HTMLElement, except?: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(".custom-select.open").forEach((picker) => {
    if (picker === except) return;
    picker.classList.remove("open");
    picker.querySelector<HTMLButtonElement>(".custom-select-trigger")?.setAttribute("aria-expanded", "false");
    const options = picker.querySelector<HTMLElement>(".custom-select-options");
    if (options) options.hidden = true;
  });
}

export function syncCustomSelect(picker: HTMLElement): void {
  const select = picker.querySelector<HTMLSelectElement>("select");
  const label = picker.querySelector<HTMLElement>(".custom-select-label");
  if (!select || !label) return;
  label.textContent = select.selectedOptions[0]?.textContent ?? "Choose an option…";
  const trigger = picker.querySelector<HTMLButtonElement>(".custom-select-trigger");
  if (trigger) trigger.setAttribute("aria-label", [trigger.dataset.selectLabel, label.textContent].filter(Boolean).join(": "));
  picker.querySelectorAll<HTMLButtonElement>(".custom-select-option").forEach((option) => {
    const selected = option.dataset.value === select.value;
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-selected", String(selected));
    const mark = option.querySelector<HTMLElement>(".custom-select-check");
    if (mark) mark.hidden = !selected;
  });
}

export function enhanceSelects(root: HTMLElement, scope: ParentNode = root): void {
  const document = root.ownerDocument;
  scope.querySelectorAll<HTMLSelectElement>("select:not([data-customized])").forEach((select, index) => {
    select.dataset.customized = "true";
    select.classList.add("native-select-source");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    const picker = document.createElement("span");
    picker.className = "custom-select";
    const listId = `custom-select-${index}-${Math.random().toString(36).slice(2)}`;
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "custom-select-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", listId);
    const label = select.labels?.[0];
    const labelText = label?.querySelector(":scope > span")?.textContent
      ?? [...(label?.childNodes ?? [])].filter(node => node.nodeType === 3).map(node => node.textContent).join(" ");
    trigger.dataset.selectLabel = (select.getAttribute("aria-label") || labelText || "").replace(/\s+/g, " ").trim();
    trigger.disabled = select.disabled;
    trigger.innerHTML = `<span class="custom-select-label"></span>${icon("chevron", "custom-select-chevron")}`;
    const options = document.createElement("span");
    options.id = listId;
    options.className = "custom-select-options";
    options.setAttribute("role", "listbox");
    if (trigger.dataset.selectLabel) options.setAttribute("aria-label", trigger.dataset.selectLabel);
    options.hidden = true;
    for (const nativeOption of select.options) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "custom-select-option";
      option.dataset.value = nativeOption.value;
      option.disabled = nativeOption.disabled;
      option.setAttribute("role", "option");
      const optionLabel = document.createElement("span");
      optionLabel.textContent = nativeOption.textContent;
      const check = document.createElement("span");
      check.className = "custom-select-check";
      check.innerHTML = icon("check");
      option.append(optionLabel, check);
      options.append(option);
    }
    select.insertAdjacentElement("afterend", picker);
    picker.append(select, trigger, options);
    syncCustomSelect(picker);
  });
}
