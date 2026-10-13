"use strict";

const COLORS = ["#00aa6c", "#ff5d5d", "#5b4fe9", "#f2b203", "#0b7ea8", "#d4479a", "#7a5c3a", "#2f2f2f"];
const GUEST_COLOR = "#9e9e9e";
const ME_KEY = "hisaab.me";

const state = {
  me: null,
  people: [],
  bills: [],
  settlement: null,
  open: new Set(),
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  uploadPayer: null,
  manualPayer: null,
  manualSplit: new Set(),
};

const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const eur = (n) => new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(Number(n) || 0);
const initials = (name) => (name || "?").replace(/\(.*?\)/g, "").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const isGuest = (id) => typeof id === "string" && id.startsWith("guest_");
const guestName = (id) => id.slice(6);

function colorFor(id) {
  if (isGuest(id)) return GUEST_COLOR;
  const i = state.people.findIndex((p) => p.id === id);
  return i >= 0 ? COLORS[i % COLORS.length] : "#bdbdbd";
}

function nameFor(id) {
  if (isGuest(id)) return `${guestName(id)} (guest)`;
  return state.people.find((p) => p.id === id)?.name ?? "Former member";
}

function avatar(id, name, cls = "avatar") {
  return h("span", { class: cls, style: `background:${colorFor(id)}`, "aria-hidden": "true" }, initials(name ?? nameFor(id)));
}

function monthKey(d = state.month) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (s < 60) return "just now";
  if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), "hour");
  if (s < 2592000) return rtf.format(-Math.floor(s / 86400), "day");
  return new Date(iso).toLocaleDateString();
}

// ---------- API ----------

async function api(path, { body, method = body ? "POST" : "GET", form } = {}) {
  const headers = form ? {} : { "Content-Type": "application/json" };
  if (state.me) headers["X-Hisaab-User"] = state.me.id;
  const res = await fetch(path, {
    method,
    headers,
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data?.detail || data?.error || `Request failed (${res.status})`);
  return data;
}

// ---------- UI helpers ----------

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
}

function spinner(text) {
  $("spinner-text").textContent = text || "Working…";
  $("spinner").classList.toggle("hidden", text === false);
}

function openModal(id) {
  $(id).classList.remove("hidden");
  document.body.style.overflow = "hidden";
  $(id).querySelector("input:not([type=checkbox]), button:not(.close)")?.focus();
}

function closeModal(id) {
  $(id).classList.add("hidden");
  if (!document.querySelector(".modal:not(.hidden)")) document.body.style.overflow = "";
}

document.querySelectorAll(".modal").forEach((m) => {
  m.addEventListener("click", (e) => {
    if (e.target === m || e.target.closest("[data-close]")) closeModal(m.id);
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelectorAll(".modal:not(.hidden)").forEach((m) => closeModal(m.id));
});

// Chip pickers: single (radio) or multi (checkbox) selection of people
function renderPicker(container, { selected, multi, onChange }) {
  container.replaceChildren(
    ...state.people.map((p) => {
      const isSel = multi ? selected().has(p.id) : selected() === p.id;
      return h(
        "button",
        {
          type: "button",
          class: "chip" + (isSel ? " selected" : ""),
          "aria-pressed": String(isSel),
          onclick: () => { onChange(p.id); renderPicker(container, { selected, multi, onChange }); },
        },
        avatar(p.id, p.name),
        p.name
      );
    })
  );
}

// ---------- Auth ----------

async function showLogin() {
  $("app-view").classList.add("hidden");
  $("login-view").classList.remove("hidden");
  try {
    const people = await api("/api/people");
    state.people = people;
    $("login-people").replaceChildren(
      ...people.map((p) =>
        h("button", { type: "button", class: "chip", onclick: () => login(p.name) }, avatar(p.id, p.name), p.name)
      )
    );
  } catch {}
  $("login-name").focus();
}

async function login(name) {
  $("login-error").textContent = "";
  try {
    const res = await api("/api/login", { body: { name } });
    state.me = { id: res.person_id, name: res.name };
    localStorage.setItem(ME_KEY, JSON.stringify(state.me));
    await startApp();
  } catch (err) {
    $("login-error").textContent = err.message;
  }
}

$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("login-name").value.trim();
  if (name) login(name);
});

$("me-btn").addEventListener("click", async () => {
  if (!confirm("Log out of Hisaab?")) return;
  await api("/api/logout", { method: "POST" }).catch(() => {});
  localStorage.removeItem(ME_KEY);
  state.me = null;
  showLogin();
});

// ---------- Data ----------

async function loadPeople() {
  state.people = await api("/api/people");
}

async function loadMonth() {
  const m = encodeURIComponent(monthKey());
  const [bills, settlement] = await Promise.all([api(`/api/bills?month=${m}`), api(`/api/settlement?month=${m}`)]);
  state.bills = bills;
  state.settlement = settlement;
  render();
}

async function refreshSettlement() {
  state.settlement = await api(`/api/settlement?month=${encodeURIComponent(monthKey())}`);
  renderStats();
  renderSettlement();
  renderBreakdown();
}

// ---------- Rendering ----------

const billTotal = (b) => b.items.reduce((s, i) => s + i.price, 0);
const needsWork = (i) => i.needs_review || i.assignee_ids.length === 0;

function render() {
  $("month-label").textContent = state.month.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  $("me-name").textContent = state.me.name;
  $("me-avatar").replaceWith(Object.assign(avatar(state.me.id, state.me.name, "avatar avatar-sm"), { id: "me-avatar" }));
  renderStats();
  renderBills();
  renderSettlement();
  renderBreakdown();
}

function renderStats() {
  const total = state.bills.reduce((s, b) => s + billTotal(b), 0);
  const mine = state.settlement?.balances.find((b) => b.person_id === state.me.id);
  const open = state.bills.flatMap((b) => b.items).filter(needsWork).length;
  const stat = (k, v, cls = "") => h("div", { class: "stat " + cls }, h("div", { class: "k" }, k), h("div", { class: "v" }, v));
  $("stats").replaceChildren(
    stat("Spent this month", eur(total)),
    stat("You paid", eur(mine?.paid)),
    stat("Your share", eur(mine?.owed_share)),
    open ? stat("Items to assign", String(open), "warn") : stat("Bills", String(state.bills.length))
  );
}

function renderBills() {
  const list = $("bills-list");
  $("bills-count").textContent = state.bills.length || "";
  if (!state.bills.length) {
    list.replaceChildren(
      h("div", { class: "empty" },
        h("div", { class: "big", "aria-hidden": "true" }, "🧾"),
        h("strong", {}, "No bills this month"),
        h("p", {}, "Scan a receipt or log a cash expense to get started."))
    );
    return;
  }
  list.replaceChildren(...state.bills.map(renderBill));
}

function shareBubbles(bill) {
  const assigned = bill.items.filter((i) => i.assignee_ids.length).length;
  const on = bill.items.length ? Math.round((assigned / bill.items.length) * 5) : 0;
  return h("span", { class: "bubbles", title: `${assigned}/${bill.items.length} items assigned` },
    ...Array.from({ length: 5 }, (_, i) => h("i", { class: i < on ? "on" : "" })));
}

function renderBill(bill) {
  const isOpen = state.open.has(bill.id);
  const pending = bill.items.filter(needsWork).length;
  const title = bill.image_path ? "Receipt" : bill.items[0]?.name || "Cash expense";
  const date = new Date(bill.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  const head = h("button", {
    type: "button", class: "bill-head", "aria-expanded": String(isOpen),
    onclick: () => { isOpen ? state.open.delete(bill.id) : state.open.add(bill.id); renderBills(); },
  },
    avatar(bill.payer_id),
    h("span", { class: "info" },
      h("div", { class: "bill-title" }, title, pending ? h("span", { class: "badge" }, `${pending} to assign`) : null),
      h("div", { class: "bill-meta" },
        `Paid by ${nameFor(bill.payer_id)} · ${date} · ${bill.items.length} item${bill.items.length === 1 ? "" : "s"}`,
        bill.items.length > 1 ? shareBubbles(bill) : null)),
    h("span", { class: "bill-total" }, eur(billTotal(bill))),
    chevron()
  );

  const card = h("article", { class: "bill" + (isOpen ? " open" : "") }, head);
  if (!isOpen) return card;

  const body = h("div", { class: "bill-body" });
  if (bill.image_path) {
    const img = h("img", { class: "receipt", src: bill.image_path, alt: "Receipt photo", loading: "lazy" });
    img.addEventListener("click", () => img.classList.toggle("big"));
    body.append(img);
  }
  if (!bill.items.length) body.append(h("p", { class: "muted", style: "padding:14px 0" }, "No items could be read from this receipt."));
  bill.items.forEach((item) => body.append(renderItem(item)));
  body.append(
    h("div", { class: "bill-foot" },
      h("button", { type: "button", class: "btn-text danger", onclick: () => deleteBill(bill) }, "Delete bill"),
      h("button", { type: "button", class: "btn btn-ghost", onclick: () => { state.open.delete(bill.id); renderBills(); } }, "Done"))
  );
  card.append(body);
  return card;
}

function chevron() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "chev");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M6 9l6 6 6-6");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "2.5");
  p.setAttribute("stroke-linecap", "round");
  svg.append(p);
  return svg;
}

function splitText(item) {
  const n = item.assignee_ids.length;
  if (!n) return ["Not assigned yet — tap who shares this", true];
  return [n === 1 ? `${nameFor(item.assignee_ids[0])} pays all` : `${eur(item.price / n)} each`, false];
}

function renderItem(item) {
  const row = h("div", { class: "item" + (item.needs_review ? " review" : "") });

  const patch = async (fields, input, revert) => {
    try {
      const updated = await api(`/api/items/${item.id}`, { method: "PATCH", body: { ...fields, needs_review: false } });
      Object.assign(item, { name: updated.name, price: updated.price, translation: updated.translation, needs_review: updated.needs_review });
      row.classList.remove("review");
      if ("price" in fields) { await refreshSettlement(); renderBills(); }
    } catch (err) {
      toast(err.message);
      input.value = revert;
    }
  };

  const name = h("input", { type: "text", class: "name", value: item.name, "aria-label": "Item name" });
  name.addEventListener("change", () => {
    const v = name.value.trim();
    v ? patch({ name: v }, name, item.name) : (name.value = item.name);
  });

  const price = h("input", { type: "number", class: "price", step: "0.01", min: "0", value: item.price.toFixed(2), "aria-label": "Price" });
  price.addEventListener("change", () => {
    const v = parseFloat(price.value);
    v > 0 ? patch({ price: v }, price, item.price.toFixed(2)) : (price.value = item.price.toFixed(2));
  });

  const note = h("input", { type: "text", class: "note", value: item.translation || "", placeholder: "Original text / note", "aria-label": "Note" });
  note.addEventListener("change", () => patch({ translation: note.value.trim() }, note, item.translation || ""));

  const del = h("button", { type: "button", class: "x", "aria-label": `Delete ${item.name}`, title: "Delete item",
    onclick: async () => {
      try { await api(`/api/items/${item.id}`, { method: "DELETE" }); await loadMonth(); } catch (err) { toast(err.message); }
    } }, "×");

  const [txt, warn] = splitText(item);
  const assign = h("div", { class: "assign" });

  const setAssignees = async (next) => {
    try {
      const updated = await api(`/api/items/${item.id}/assign`, { body: { person_ids: next } });
      item.assignee_ids = updated.assignee_ids;
      if (item.needs_review) {
        await api(`/api/items/${item.id}`, { method: "PATCH", body: { needs_review: false } });
        item.needs_review = false;
      }
      await refreshSettlement();
      renderBills();
    } catch (err) { toast(err.message); }
  };

  state.people.forEach((p) => {
    const sel = item.assignee_ids.includes(p.id);
    assign.append(h("button", {
      type: "button", class: "chip chip-sm" + (sel ? " selected" : ""), "aria-pressed": String(sel),
      onclick: () => setAssignees(sel ? item.assignee_ids.filter((id) => id !== p.id) : [...item.assignee_ids, p.id]),
    }, avatar(p.id, p.name), p.name));
  });
  item.assignee_ids.filter(isGuest).forEach((gid) => {
    assign.append(h("button", {
      type: "button", class: "chip chip-sm selected", title: "Remove guest",
      onclick: () => setAssignees(item.assignee_ids.filter((id) => id !== gid)),
    }, avatar(gid), `${guestName(gid)} ×`));
  });
  assign.append(
    h("button", { type: "button", class: "chip chip-sm chip-add", onclick: () => {
      const g = prompt("Guest name for this item:")?.trim();
      if (g && !item.assignee_ids.includes(`guest_${g}`)) setAssignees([...item.assignee_ids, `guest_${g}`]);
    } }, "+ Guest"),
    h("span", { class: "split-note" + (warn ? " warn" : "") }, txt)
  );

  row.append(h("div", { class: "item-top" }, name, price, del), note, assign);
  return row;
}

function renderSettlement() {
  const s = state.settlement;
  const el = $("settlement-content");
  if (!s) return el.replaceChildren();
  const nodes = [];
  if (!s.transactions.length) {
    nodes.push(h("div", { class: "settled" }, h("span", { class: "big", "aria-hidden": "true" }, "🎉"), "Everyone is square"));
  } else {
    s.transactions.forEach((t) => {
      const from = state.people.find((p) => p.name === t.from_name);
      nodes.push(h("div", { class: "tx" },
        avatar(from?.id ?? `guest_${t.from_name}`, t.from_name, "avatar avatar-sm"),
        h("span", { class: "txt" }, h("b", {}, t.from_name), " pays ", h("b", {}, t.to_name)),
        h("span", { class: "amt" }, eur(t.amount))));
    });
  }
  const bals = s.balances.filter((b) => b.paid > 0.005 || b.owed_share > 0.005);
  if (bals.length) {
    nodes.push(h("div", { class: "sub" }, "Balances"));
    bals.forEach((b) => nodes.push(h("div", { class: "bal" },
      h("span", {}, `${b.name} · paid ${eur(b.paid)}`),
      h("b", { class: b.net >= 0 ? "pos" : "neg" }, (b.net >= 0 ? "+" : "−") + eur(Math.abs(b.net))))));
  }
  if (s.unassigned_total > 0.005) {
    nodes.push(h("div", { class: "unassigned" }, `${eur(s.unassigned_total)} is still unassigned and not counted yet.`));
  }
  el.replaceChildren(...nodes);
}

function renderBreakdown() {
  const el = $("breakdown");
  const rows = (state.settlement?.balances ?? []).filter((b) => b.owed_share > 0.005).sort((a, b) => b.owed_share - a.owed_share);
  const total = rows.reduce((s, b) => s + b.owed_share, 0);
  if (!total) return el.replaceChildren(h("p", { class: "muted" }, "Assign items to see each person's share."));

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 42 42");
  svg.setAttribute("class", "donut");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Share of spending per person");
  let offset = 25;
  const ring = (color, pct, off) => {
    const c = document.createElementNS(ns, "circle");
    Object.entries({ cx: 21, cy: 21, r: 15.9155, fill: "none", stroke: color, "stroke-width": 6,
      "stroke-dasharray": `${pct} ${100 - pct}`, "stroke-dashoffset": off }).forEach(([k, v]) => c.setAttribute(k, v));
    return c;
  };
  svg.append(ring("#f2f2f2", 100, 0));
  rows.forEach((b) => {
    const pct = (b.owed_share / total) * 100;
    svg.append(ring(colorFor(b.person_id), Math.max(pct - 0.6, 0.1), offset));
    offset -= pct;
  });

  el.replaceChildren(h("div", { class: "donut-wrap" }, svg,
    h("div", { class: "legend" }, ...rows.map((b) =>
      h("div", {}, h("i", { style: `background:${colorFor(b.person_id)}` }), h("span", {}, b.name), h("span", {}, eur(b.owed_share)))))));
}

// ---------- Actions ----------

async function deleteBill(bill) {
  if (!confirm("Delete this bill and all its items?")) return;
  try {
    await api(`/api/bills/${bill.id}`, { method: "DELETE" });
    state.open.delete(bill.id);
    await loadMonth();
    toast("Bill deleted");
  } catch (err) { toast(err.message); }
}

function shiftMonth(delta) {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() + delta, 1);
  loadMonth().catch((e) => toast(e.message));
}
$("prev-month").addEventListener("click", () => shiftMonth(-1));
$("next-month").addEventListener("click", () => shiftMonth(1));

// Upload receipt
$("upload-btn").addEventListener("click", () => {
  state.uploadPayer = state.me.id;
  renderPicker($("upload-payers"), { selected: () => state.uploadPayer, onChange: (id) => (state.uploadPayer = id) });
  openModal("upload-modal");
});

$("upload-confirm").addEventListener("click", () => {
  if (!state.uploadPayer) return toast("Pick who paid first");
  closeModal("upload-modal");
  $("file-input").click();
});

$("file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const form = new FormData();
  form.append("payer_id", state.uploadPayer);
  form.append("month", monthKey());
  form.append("file", file);
  spinner("Reading & translating your receipt…");
  try {
    const bill = await api("/api/bills/upload", { form, method: "POST" });
    state.open.add(bill.id);
    await loadMonth();
    toast(bill.items.length ? `Found ${bill.items.length} items — assign them below` : "Receipt saved, but no items were read");
  } catch (err) {
    toast(err.message);
  } finally {
    spinner(false);
  }
});

// Cash expense
$("manual-btn").addEventListener("click", () => {
  state.manualPayer = state.me.id;
  state.manualSplit = new Set(state.people.map((p) => p.id));
  $("cash-title").value = "";
  $("cash-amount").value = "";
  $("cash-guest-check").checked = false;
  $("cash-guest-name").value = "";
  $("cash-guest-name").classList.add("hidden");
  $("manual-error").textContent = "";
  renderPicker($("manual-payers"), { selected: () => state.manualPayer, onChange: (id) => (state.manualPayer = id) });
  renderPicker($("manual-split"), {
    multi: true,
    selected: () => state.manualSplit,
    onChange: (id) => (state.manualSplit.has(id) ? state.manualSplit.delete(id) : state.manualSplit.add(id)),
  });
  openModal("manual-modal");
});

$("cash-guest-check").addEventListener("change", (e) => {
  $("cash-guest-name").classList.toggle("hidden", !e.target.checked);
  if (e.target.checked) $("cash-guest-name").focus();
});

$("manual-submit").addEventListener("click", async () => {
  const err = $("manual-error");
  err.textContent = "";
  const amount = parseFloat($("cash-amount").value);
  const assignees = [...state.manualSplit];
  if ($("cash-guest-check").checked) {
    const g = $("cash-guest-name").value.trim();
    if (!g) return (err.textContent = "Enter the guest's name or untick the guest option");
    assignees.push(`guest_${g}`);
  }
  if (!state.manualPayer) return (err.textContent = "Pick who paid");
  if (!(amount > 0)) return (err.textContent = "Enter an amount above 0");
  if (!assignees.length) return (err.textContent = "Pick at least one person to split with");
  try {
    const bill = await api("/api/bills/manual", {
      body: {
        payer_id: state.manualPayer,
        month: monthKey(),
        items: [{ name: $("cash-title").value.trim() || "Cash expense", price: amount, assignee_ids: assignees }],
      },
    });
    state.open.add(bill.id);
    closeModal("manual-modal");
    await loadMonth();
    toast("Expense added");
  } catch (e) {
    err.textContent = e.message;
  }
});

// People
function renderPeople() {
  $("people-list").replaceChildren(
    ...state.people.map((p) =>
      h("li", {}, avatar(p.id, p.name), h("span", {}, p.name + (p.id === state.me.id ? " (you)" : "")),
        p.id === state.me.id ? null : h("button", { type: "button", class: "btn-text danger", onclick: () => removePerson(p) }, "Remove")))
  );
}

async function removePerson(p) {
  if (!confirm(`Remove ${p.name} from the household? Their past splits stay in old bills.`)) return;
  try {
    await api(`/api/people/${p.id}`, { method: "DELETE" });
    await loadPeople();
    renderPeople();
    await loadMonth();
  } catch (err) { $("people-error").textContent = err.message; }
}

$("people-btn").addEventListener("click", () => {
  $("people-error").textContent = "";
  renderPeople();
  openModal("people-modal");
});

$("people-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("people-name").value.trim();
  if (!name) return;
  if (state.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    $("people-error").textContent = `${name} is already in the household`;
    return;
  }
  try {
    await api("/api/people", { body: { name } });
    $("people-name").value = "";
    $("people-error").textContent = "";
    await loadPeople();
    renderPeople();
    await loadMonth();
  } catch (err) { $("people-error").textContent = err.message; }
});

// Activity
const LOG_TEXT = {
  "bill.upload": (d) => `scanned a receipt (${d.item_count ?? "?"} items)`,
  "bill.manual_add": () => "added a cash expense",
  "bill.delete": () => "deleted a bill",
  "item.edit": () => "edited an item",
  "item.delete": (d) => `deleted "${d.name ?? "an item"}"`,
  "item.assign": () => "changed who shares an item",
  "person.create": (d) => `added ${d.name ?? "a roommate"}`,
  "person.delete": () => "removed a roommate",
};

$("activity-btn").addEventListener("click", async () => {
  const list = $("logs-list");
  list.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  openModal("logs-modal");
  try {
    const logs = await api("/api/logs");
    list.replaceChildren(
      ...(logs.length
        ? logs.map((l) => h("div", { class: "log" },
            h("b", {}, l.actor_name), " ", (LOG_TEXT[l.action] ?? (() => l.action))(l.details || {}), " ",
            h("small", {}, "· " + timeAgo(l.created_at)),
            l.bill_image_path ? h("a", { href: l.bill_image_path, target: "_blank", rel: "noopener" }, "View receipt ↗") : null))
        : [h("p", { class: "muted" }, "Nothing has happened yet.")])
    );
  } catch (err) {
    list.replaceChildren(h("p", { class: "error" }, err.message));
  }
});

// AI settings
$("ai-btn").addEventListener("click", async () => {
  $("ai-error").textContent = "";
  $("ai-key").value = "";
  try {
    const s = await api("/api/settings");
    $("ai-key").placeholder = s.gemini_key_set ? `Current: ${s.masked_key}` : "AIza…";
  } catch {}
  openModal("ai-modal");
});

$("ai-save").addEventListener("click", async () => {
  const key = $("ai-key").value.trim();
  if (!key) return ($("ai-error").textContent = "Paste an API key first");
  try {
    await api("/api/settings", { body: { gemini_key: key } });
    closeModal("ai-modal");
    toast("Gemini key saved — receipts will use Gemini Vision");
  } catch (err) { $("ai-error").textContent = err.message; }
});

// Nav highlight
document.querySelectorAll(".nav-link[data-target]").forEach((a) =>
  a.addEventListener("click", () => {
    document.querySelectorAll(".nav-link[data-target]").forEach((x) => x.classList.toggle("active", x === a));
  })
);

// ---------- Boot ----------

async function startApp() {
  $("login-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");
  await loadPeople();
  // Person may have been removed since last visit
  if (!state.people.some((p) => p.id === state.me.id)) {
    localStorage.removeItem(ME_KEY);
    return showLogin();
  }
  await loadMonth();
}

(function boot() {
  try { state.me = JSON.parse(localStorage.getItem(ME_KEY)); } catch { state.me = null; }
  (state.me ? startApp() : showLogin()).catch((err) => {
    console.error(err);
    showLogin();
  });
})();
