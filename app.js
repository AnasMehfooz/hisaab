const AVATAR_COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ec4899", "#8b5cf6", "#06b6d4"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

let me = null;
let people = [];
let bills = [];
let expandedBillIds = new Set();
let selectedUploadPayer = null;
let selectedManualPayer = null;
let manualSplitAssignees = new Set();
let logsBeforeId = null;

// Rolling Month Carousel State
let currentDate = new Date();

const $ = (id) => document.getElementById(id);

function euros(amount) {
  return "€" + Number(amount || 0).toFixed(2);
}

function initials(name) {
  return (name || "?").trim().slice(0, 2).toUpperCase();
}

function colorFor(personId) {
  const idx = people.findIndex((p) => p.id === personId);
  if (idx >= 0) return AVATAR_COLORS[idx % AVATAR_COLORS.length];
  if (personId && personId.startsWith("guest_")) return "#ec4899";
  return "#6b7280";
}

function personName(personId) {
  const p = people.find((p) => p.id === personId);
  if (p) return p.name;
  if (personId && personId.startsWith("guest_")) return personId.replace("guest_", "") + " (Guest)";
  return personId || "?";
}

function timeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("Not authenticated");
  }
  if (!res.ok) {
    let detail = "Something went wrong";
    try {
      detail = (await res.json()).detail || detail;
    } catch (e) {}
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  return res.json();
}

function showSpinner(text, stepIdx = 0) {
  $("spinner-text").textContent = text || "Working…";
  $("spinner").classList.remove("hidden");
  [0, 1, 2].forEach(i => {
    const el = $(`step-${i}`);
    if (el) el.classList.toggle("active", i <= stepIdx);
  });
}

function hideSpinner() {
  $("spinner").classList.add("hidden");
}

function openModal(id) {
  $(id).classList.remove("hidden");
}

function closeModal(id) {
  $(id).classList.add("hidden");
}

document.querySelectorAll("[data-close-modal]").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
});

// ---------- Rolling Month Logic ----------

function currentMonth() {
  const y = currentDate.getFullYear();
  const m = String(currentDate.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function updateMonthDisplay() {
  const monthName = MONTH_NAMES[currentDate.getMonth()];
  const year = currentDate.getFullYear();
  $("month-display-text").textContent = `${monthName} ${year}`;
  $("month-input").value = currentMonth();
}

$("prev-month-btn").addEventListener("click", async () => {
  currentDate.setMonth(currentDate.getMonth() - 1);
  updateMonthDisplay();
  await refreshMonthData();
});

$("next-month-btn").addEventListener("click", async () => {
  currentDate.setMonth(currentDate.getMonth() + 1);
  updateMonthDisplay();
  await refreshMonthData();
});

// ---------- Init ----------

async function init() {
  try {
    const session = await api("/api/session");
    if (!session.authenticated) {
      window.location.href = "/login.html";
      return;
    }
    me = { id: session.person_id, name: session.name };
    $("whoami").textContent = me.name;

    updateMonthDisplay();

    await loadPeople();
    await showDashboard();
  } catch (e) {
    window.location.href = "/login.html";
  }
}

// ---------- People ----------

async function loadPeople() {
  people = await api("/api/people");
}

// ---------- People management modal ----------

$("manage-people-btn").addEventListener("click", () => {
  renderPeopleModal();
  openModal("people-modal");
});

function renderPeopleModal() {
  const list = $("people-list");
  list.innerHTML = "";
  people.forEach((p) => {
    const li = document.createElement("li");
    
    const nameRow = document.createElement("div");
    nameRow.className = "person-name-row";

    const badge = document.createElement("div");
    badge.className = "bill-avatar";
    badge.style.background = colorFor(p.id);
    badge.textContent = initials(p.name);

    const nameSpan = document.createElement("span");
    nameSpan.style.fontWeight = "600";
    nameSpan.textContent = p.name + (p.id === me.id ? " (you)" : "");

    nameRow.appendChild(badge);
    nameRow.appendChild(nameSpan);

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "4px";

    const resetBtn = document.createElement("button");
    resetBtn.className = "btn-link";
    resetBtn.textContent = "Reset";
    resetBtn.addEventListener("click", async () => {
      const newPassword = prompt(`Set a new password for ${p.name}:`);
      if (!newPassword) return;
      $("people-error").textContent = "";
      try {
        await api(`/api/people/${p.id}/reset-password`, {
          method: "POST",
          body: JSON.stringify({ new_password: newPassword }),
        });
        alert(`${p.name}'s password has been reset.`);
      } catch (err) {
        $("people-error").textContent = err.message;
      }
    });

    const delBtn = document.createElement("button");
    delBtn.className = "btn-danger";
    delBtn.textContent = "Remove";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Remove ${p.name} from household?`)) return;
      $("people-error").textContent = "";
      try {
        await api(`/api/people/${p.id}`, { method: "DELETE" });
        await loadPeople();
        renderPeopleModal();
        renderPayerButtons();
        renderBills();
        renderAnalytics();
      } catch (err) {
        $("people-error").textContent = err.message;
      }
    });

    actions.appendChild(resetBtn);
    actions.appendChild(delBtn);
    li.appendChild(nameRow);
    li.appendChild(actions);
    list.appendChild(li);
  });
}

$("people-add-btn").addEventListener("click", async () => {
  const nameInput = $("people-name-input");
  const passwordInput = $("people-password-input");
  const name = nameInput.value.trim();
  const password = passwordInput.value;
  $("people-error").textContent = "";
  if (!name || password.length < 4) {
    $("people-error").textContent = "Enter a name and a password (4+ characters)";
    return;
  }
  try {
    await api("/api/people", { method: "POST", body: JSON.stringify({ name, password }) });
    nameInput.value = "";
    passwordInput.value = "";
    await loadPeople();
    renderPeopleModal();
    renderPayerButtons();
    renderBills();
    renderAnalytics();
  } catch (err) {
    $("people-error").textContent = err.message;
  }
});

$("me-change-password-btn").addEventListener("click", async () => {
  const current_password = $("me-current-password").value;
  const new_password = $("me-new-password").value;
  $("me-password-error").textContent = "";
  if (!current_password || new_password.length < 4) {
    $("me-password-error").textContent = "Enter current password and new one (4+ chars)";
    return;
  }
  try {
    await api("/api/me/password", {
      method: "PATCH",
      body: JSON.stringify({ current_password, new_password }),
    });
    $("me-current-password").value = "";
    $("me-new-password").value = "";
    alert("Password changed successfully.");
  } catch (err) {
    $("me-password-error").textContent = err.message;
  }
});

// ---------- Activity log ----------

$("activity-log-btn").addEventListener("click", () => {
  logsBeforeId = null;
  $("logs-list").innerHTML = "";
  loadLogs();
  openModal("logs-modal");
});

$("logs-load-more-btn").addEventListener("click", () => loadLogs());

const LOG_DESCRIPTIONS = {
  "bill.upload": (e) => `uploaded a receipt (${e.details?.item_count ?? "?"} items)`,
  "bill.manual_add": (e) => `added a cash/quick expense`,
  "bill.delete": (e) => `deleted a bill`,
  "item.edit": (e) => `edited an item`,
  "item.delete": (e) => `deleted item "${e.details?.name ?? "?"}"`,
  "item.assign": () => `changed item assignments`,
  "person.create": (e) => `added ${e.details?.name ?? "a roommate"}`,
  "person.delete": (e) => `removed a roommate`,
};

function describeLog(entry) {
  const fn = LOG_DESCRIPTIONS[entry.action];
  return fn ? fn(entry) : entry.action;
}

async function loadLogs() {
  const params = new URLSearchParams({ limit: "50" });
  if (logsBeforeId) params.set("before_id", logsBeforeId);
  const entries = await api(`/api/logs?${params.toString()}`);
  const list = $("logs-list");
  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "log-row";
    
    const text = document.createElement("div");
    text.innerHTML = `<span class="log-actor">${entry.actor_name}</span> ${describeLog(entry)} <span style="color:var(--text-muted)">· ${timeAgo(entry.created_at)}</span>`;
    row.appendChild(text);

    if (entry.bill_image_path) {
      const link = document.createElement("a");
      link.href = entry.bill_image_path;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "View receipt photo ↗";
      row.appendChild(link);
    }
    list.appendChild(row);
  });
  if (entries.length > 0) {
    logsBeforeId = entries[entries.length - 1].id;
  }
  $("logs-load-more-btn").classList.toggle("hidden", entries.length < 50);
}

// ---------- Dashboard ----------

async function showDashboard() {
  $("dashboard-page").classList.remove("hidden");
  renderPayerButtons();
  await refreshMonthData();
}

async function refreshMonthData() {
  await Promise.all([loadBills(), loadSettlement()]);
}

$("logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  window.location.href = "/login.html";
});

function renderPayerButtons() {
  for (const [containerId, selectedGetter, onSelect] of [
    ["upload-payer-list", () => selectedUploadPayer, (id) => (selectedUploadPayer = id)],
    ["manual-payer-list", () => selectedManualPayer, (id) => (selectedManualPayer = id)],
  ]) {
    const container = $(containerId);
    if (!container) continue;
    container.innerHTML = "";
    people.forEach((p) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "avatar-btn";
      btn.textContent = initials(p.name);
      btn.title = p.name;
      const applyStyle = () => {
        const selected = selectedGetter() === p.id;
        btn.classList.toggle("selected", selected);
        btn.style.background = selected ? colorFor(p.id) : "";
      };
      applyStyle();
      btn.addEventListener("click", () => {
        onSelect(p.id);
        container.querySelectorAll(".avatar-btn").forEach((b) => {
          b.classList.remove("selected");
          b.style.background = "";
        });
        applyStyle();
      });
      container.appendChild(btn);
    });
  }

  // Render Cash Split People Selection Buttons (Unclicked by default)
  const splitContainer = $("manual-split-people");
  if (splitContainer) {
    splitContainer.innerHTML = "";
    people.forEach((p) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "avatar-btn";
      btn.textContent = initials(p.name);
      btn.title = p.name;

      const isSelected = manualSplitAssignees.has(p.id);
      btn.classList.toggle("selected", isSelected);
      if (isSelected) btn.style.background = colorFor(p.id);

      btn.addEventListener("click", () => {
        if (manualSplitAssignees.has(p.id)) {
          manualSplitAssignees.delete(p.id);
          btn.classList.remove("selected");
          btn.style.background = "";
        } else {
          manualSplitAssignees.add(p.id);
          btn.classList.add("selected");
          btn.style.background = colorFor(p.id);
        }
      });
      splitContainer.appendChild(btn);
    });
  }
}

// ---------- Guest Checkbox Toggle ----------
$("cash-guest-checkbox").addEventListener("change", (e) => {
  $("cash-guest-input-wrap").classList.toggle("hidden", !e.target.checked);
});

// ---------- Upload Flow ----------

$("upload-btn").addEventListener("click", () => {
  selectedUploadPayer = me ? me.id : null;
  renderPayerButtons();
  openModal("upload-modal");
});

$("upload-confirm-btn").addEventListener("click", () => {
  if (!selectedUploadPayer) {
    alert("Please select who paid first");
    return;
  }
  closeModal("upload-modal");
  $("file-input").click();
});

$("file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  const formData = new FormData();
  formData.append("payer_id", selectedUploadPayer);
  formData.append("month", currentMonth());
  formData.append("file", file);

  showSpinner("Reading & translating receipt with GPU AI…", 1);
  try {
    const newBill = await fetch("/api/bills/upload", { method: "POST", body: formData }).then(
      async (res) => {
        if (res.status === 401) {
          window.location.href = "/login.html";
          return null;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.detail || "Upload failed");
        }
        return res.json();
      }
    );
    if (newBill) expandedBillIds.add(newBill.id);
    await refreshMonthData();
  } catch (err) {
    alert(err.message);
  } finally {
    hideSpinner();
  }
});

// ---------- Cash Expense Flow ----------

$("manual-btn").addEventListener("click", () => {
  selectedManualPayer = me ? me.id : null;
  manualSplitAssignees = new Set(); // Unclicked by default as requested!
  $("cash-title-input").value = "";
  $("cash-amount-input").value = "";
  $("cash-guest-checkbox").checked = false;
  $("cash-guest-name").value = "";
  $("cash-guest-input-wrap").classList.add("hidden");
  $("manual-error").textContent = "";
  renderPayerButtons();
  openModal("manual-modal");
});

$("manual-submit-btn").addEventListener("click", async () => {
  $("manual-error").textContent = "";
  const title = $("cash-title-input").value.trim() || "Cash Expense";
  const amount = parseFloat($("cash-amount-input").value);

  if (!selectedManualPayer) {
    $("manual-error").textContent = "Please select who paid";
    return;
  }
  if (!(amount > 0)) {
    $("manual-error").textContent = "Please enter a valid amount (> 0)";
    return;
  }
  if (manualSplitAssignees.size === 0 && !$("cash-guest-checkbox").checked) {
    $("manual-error").textContent = "Select who this belongs to (click name avatar)";
    return;
  }

  let assignees = Array.from(manualSplitAssignees);

  if ($("cash-guest-checkbox").checked) {
    const guestName = $("cash-guest-name").value.trim();
    if (!guestName) {
      $("manual-error").textContent = "Enter guest name or uncheck guest option";
      return;
    }
    assignees.push(`guest_${guestName}`);
  }

  try {
    const newBill = await api("/api/bills/manual", {
      method: "POST",
      body: JSON.stringify({
        payer_id: selectedManualPayer,
        month: currentMonth(),
        items: [{
          name: title,
          price: amount,
          assignee_ids: assignees
        }],
      }),
    });
    expandedBillIds.add(newBill.id);
    closeModal("manual-modal");
    await refreshMonthData();
  } catch (err) {
    $("manual-error").textContent = err.message;
  }
});

// ---------- Bills List & Rendering ----------

async function loadBills() {
  bills = await api(`/api/bills?month=${encodeURIComponent(currentMonth())}`);
  renderBills();
  renderAnalytics();
}

function renderBills() {
  const container = $("bills-list");
  const label = $("bills-section-label");
  container.innerHTML = "";

  if (bills.length === 0) {
    label.textContent = "";
    const empty = document.createElement("div");
    empty.className = "card empty-state";
    empty.innerHTML = `
      <div class="empty-state-icon">🧾</div>
      <div>No bills for this month yet</div>
      <div style="font-size:0.8rem;color:var(--text-muted);margin-top:4px">Tap Upload Receipt or Cash Expense to add one.</div>
    `;
    container.appendChild(empty);
    return;
  }

  label.textContent = `Bills (${bills.length})`;
  bills.forEach((bill) => container.appendChild(renderBillCard(bill)));
}

function billTotal(bill) {
  return bill.items.reduce((sum, i) => sum + i.price, 0);
}

function renderBillCard(bill) {
  return expandedBillIds.has(bill.id) ? renderExpandedBillCard(bill) : renderCollapsedBillCard(bill);
}

function renderCollapsedBillCard(bill) {
  const card = document.createElement("div");
  card.className = "card bill-summary";

  const left = document.createElement("div");
  left.className = "bill-payer-row";

  const avatar = document.createElement("div");
  avatar.className = "bill-avatar";
  avatar.style.background = colorFor(bill.payer_id);
  avatar.textContent = initials(personName(bill.payer_id));

  const info = document.createElement("div");
  info.className = "bill-info";

  const title = document.createElement("div");
  title.className = "bill-title";
  title.textContent = `Paid by ${personName(bill.payer_id)}`;

  const meta = document.createElement("div");
  meta.className = "bill-meta";
  const date = new Date(bill.created_at);
  const typeStr = bill.image_path ? "Receipt" : "Cash Expense";
  meta.textContent = `${typeStr} · ${date.toLocaleDateString()} · ${bill.items.length} item${bill.items.length === 1 ? "" : "s"}`;

  info.appendChild(title);
  info.appendChild(meta);
  left.appendChild(avatar);
  left.appendChild(info);

  const right = document.createElement("div");
  right.className = "bill-amount";
  right.textContent = euros(billTotal(bill));

  card.appendChild(left);
  card.appendChild(right);
  card.addEventListener("click", () => {
    expandedBillIds.add(bill.id);
    renderBills();
  });

  return card;
}

function renderExpandedBillCard(bill) {
  const card = document.createElement("div");
  card.className = "card";

  const header = document.createElement("div");
  header.className = "bill-header";

  const metaWrap = document.createElement("div");
  const title = document.createElement("div");
  title.className = "bill-title";
  title.style.fontSize = "1.05rem";
  title.textContent = `Paid by ${personName(bill.payer_id)}`;

  const meta = document.createElement("div");
  meta.className = "bill-meta";
  const date = new Date(bill.created_at);
  const uploadedBy = bill.uploaded_by_id ? ` · Added by ${personName(bill.uploaded_by_id)}` : "";
  meta.textContent = `${bill.image_path ? "Receipt" : "Cash expense"} · ${date.toLocaleDateString()}${uploadedBy}`;

  metaWrap.appendChild(title);
  metaWrap.appendChild(meta);

  const delBillBtn = document.createElement("button");
  delBillBtn.className = "btn-danger";
  delBillBtn.textContent = "Delete Bill";
  delBillBtn.addEventListener("click", async () => {
    if (!confirm("Delete this entire bill and all its items?")) return;
    try {
      await api(`/api/bills/${bill.id}`, { method: "DELETE" });
      expandedBillIds.delete(bill.id);
      await refreshMonthData();
    } catch (err) {
      alert(err.message);
    }
  });

  header.appendChild(metaWrap);
  header.appendChild(delBillBtn);
  card.appendChild(header);

  if (bill.image_path) {
    const img = document.createElement("img");
    img.className = "receipt-thumb";
    img.src = bill.image_path;
    img.title = "Tap to enlarge";
    img.addEventListener("click", () => img.classList.toggle("expanded"));
    card.appendChild(img);
  }

  if (bill.items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.style.padding = "16px";
    empty.textContent = "No items extracted.";
    card.appendChild(empty);
  }

  bill.items.forEach((item) => card.appendChild(renderItemRow(bill, item)));

  const doneBtn = document.createElement("button");
  doneBtn.className = "btn-secondary";
  doneBtn.textContent = "Collapse";
  doneBtn.style.marginTop = "14px";
  doneBtn.style.width = "100%";
  doneBtn.addEventListener("click", () => {
    expandedBillIds.delete(bill.id);
    renderBills();
  });
  card.appendChild(doneBtn);

  return card;
}

function renderItemRow(bill, item) {
  const row = document.createElement("div");
  row.className = "item-row" + (item.needs_review ? " needs-review" : "");

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "item-name";
  nameInput.value = item.name;
  nameInput.addEventListener("change", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.value = item.name;
      return;
    }
    try {
      const updated = await api(`/api/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, needs_review: false }),
      });
      item.name = updated.name;
      item.needs_review = updated.needs_review;
      row.classList.remove("needs-review");
      reviewBadge.classList.add("hidden");
    } catch (err) {
      alert(err.message);
      nameInput.value = item.name;
    }
  });

  const priceInput = document.createElement("input");
  priceInput.type = "number";
  priceInput.step = "0.01";
  priceInput.className = "item-price";
  priceInput.value = item.price.toFixed(2);
  priceInput.addEventListener("change", async () => {
    const price = parseFloat(priceInput.value);
    if (!(price > 0)) {
      priceInput.value = item.price.toFixed(2);
      return;
    }
    try {
      const updated = await api(`/api/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ price }),
      });
      item.price = updated.price;
      priceInput.value = item.price.toFixed(2);
      updateSplitNote(splitNote, item);
      renderAnalytics();
    } catch (err) {
      alert(err.message);
      priceInput.value = item.price.toFixed(2);
    }
  });

  const delItemBtn = document.createElement("button");
  delItemBtn.className = "btn-danger";
  delItemBtn.textContent = "✕";
  delItemBtn.addEventListener("click", async () => {
    try {
      await api(`/api/items/${item.id}`, { method: "DELETE" });
      await refreshMonthData();
    } catch (err) {
      alert(err.message);
    }
  });

  const translationInput = document.createElement("input");
  translationInput.type = "text";
  translationInput.className = "item-translation";
  translationInput.placeholder = item.original_name ? `Original on receipt: ${item.original_name}` : "Notes / original name (optional)…";
  translationInput.value = item.translation || item.original_name || "";
  translationInput.addEventListener("change", async () => {
    const translation = translationInput.value.trim();
    try {
      const updated = await api(`/api/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ translation, needs_review: false }),
      });
      item.translation = updated.translation;
      item.needs_review = updated.needs_review;
      row.classList.remove("needs-review");
      reviewBadge.classList.add("hidden");
    } catch (err) {
      alert(err.message);
      translationInput.value = item.translation || "";
    }
  });

  const reviewBadge = document.createElement("button");
  reviewBadge.type = "button";
  reviewBadge.className = "review-badge" + (item.needs_review ? "" : " hidden");
  reviewBadge.textContent = "⚠️ Translated to English — click names below to assign";
  reviewBadge.addEventListener("click", async () => {
    try {
      const updated = await api(`/api/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ needs_review: false }),
      });
      item.needs_review = updated.needs_review;
      row.classList.remove("needs-review");
      reviewBadge.classList.add("hidden");
    } catch (err) {
      alert(err.message);
    }
  });

  const assignees = document.createElement("div");
  assignees.className = "assignees";
  
  // Render unclicked avatar buttons for standard household people
  people.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "avatar-btn";
    btn.textContent = initials(p.name);
    btn.title = `Assign to ${p.name}`;
    const isSelected = () => item.assignee_ids.includes(p.id);
    const applyStyle = () => {
      const sel = isSelected();
      btn.classList.toggle("selected", sel);
      btn.style.background = sel ? colorFor(p.id) : "";
    };
    applyStyle();
    btn.addEventListener("click", async () => {
      const next = isSelected()
        ? item.assignee_ids.filter((id) => id !== p.id)
        : [...item.assignee_ids, p.id];
      try {
        const updated = await api(`/api/items/${item.id}/assign`, {
          method: "POST",
          body: JSON.stringify({ person_ids: next }),
        });
        item.assignee_ids = updated.assignee_ids;
        applyStyle();
        updateSplitNote(splitNote, item);
        loadSettlement();
        renderAnalytics();
      } catch (err) {
        alert(err.message);
      }
    });
    assignees.appendChild(btn);
  });

  // Render buttons for any temporary guests assigned to this item
  const guestIds = item.assignee_ids.filter(id => id.startsWith("guest_"));
  guestIds.forEach((gid) => {
    const gName = gid.replace("guest_", "");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "avatar-btn selected";
    btn.textContent = initials(gName);
    btn.title = `${gName} (Guest)`;
    btn.style.background = "#ec4899";

    btn.addEventListener("click", async () => {
      const next = item.assignee_ids.filter((id) => id !== gid);
      try {
        const updated = await api(`/api/items/${item.id}/assign`, {
          method: "POST",
          body: JSON.stringify({ person_ids: next }),
        });
        item.assignee_ids = updated.assignee_ids;
        btn.remove();
        updateSplitNote(splitNote, item);
        loadSettlement();
        renderAnalytics();
      } catch (err) {
        alert(err.message);
      }
    });
    assignees.appendChild(btn);
  });

  // Add Guest for this specific item button
  const addGuestBtn = document.createElement("button");
  addGuestBtn.type = "button";
  addGuestBtn.className = "avatar-btn";
  addGuestBtn.textContent = "+👤";
  addGuestBtn.title = "Add temporary guest to this item";
  addGuestBtn.addEventListener("click", async () => {
    const gName = prompt("Enter temporary guest name for this item:");
    if (!gName || !gName.trim()) return;
    const gid = `guest_${gName.trim()}`;
    const next = [...item.assignee_ids, gid];
    try {
      const updated = await api(`/api/items/${item.id}/assign`, {
        method: "POST",
        body: JSON.stringify({ person_ids: next }),
      });
      item.assignee_ids = updated.assignee_ids;
      renderBills();
      loadSettlement();
      renderAnalytics();
    } catch (err) {
      alert(err.message);
    }
  });
  assignees.appendChild(addGuestBtn);

  const splitNote = document.createElement("div");
  splitNote.className = "split-note";
  updateSplitNote(splitNote, item);

  row.appendChild(nameInput);
  row.appendChild(priceInput);
  row.appendChild(delItemBtn);
  row.appendChild(translationInput);
  row.appendChild(reviewBadge);
  row.appendChild(assignees);
  row.appendChild(splitNote);

  return row;
}

function updateSplitNote(el, item) {
  const n = item.assignee_ids.length;
  if (n === 0) {
    el.textContent = "Unassigned — click names above to assign";
    el.style.color = "var(--warning)";
  } else if (n === 1) {
    el.textContent = `${personName(item.assignee_ids[0])} · ${euros(item.price)}`;
    el.style.color = "var(--text-muted)";
  } else {
    el.textContent = `Split ${n} ways · ${euros(item.price / n)} each`;
    el.style.color = "var(--text-muted)";
  }
}

// ---------- Settlement ----------

async function loadSettlement() {
  const settlement = await api(`/api/settlement?month=${encodeURIComponent(currentMonth())}`);
  renderSettlement(settlement);
}

function renderSettlement(settlement) {
  const container = $("settlement-content");
  container.innerHTML = "";

  if (settlement.unassigned_total > 0) {
    const warn = document.createElement("div");
    warn.className = "warning-banner";
    warn.textContent = `⚠️ ${euros(settlement.unassigned_total)} in items are unassigned and excluded from settlement calculations.`;
    container.appendChild(warn);
  }

  settlement.balances.forEach((b) => {
    const row = document.createElement("div");
    row.className = "balance-row";
    
    const label = document.createElement("div");
    label.className = "balance-label";
    label.textContent = `${b.name} — paid ${euros(b.paid)}, share ${euros(b.owed_share)}`;
    
    const net = document.createElement("div");
    net.className = "balance-net " + (b.net >= 0 ? "positive" : "negative");
    net.textContent = (b.net >= 0 ? "+" : "") + euros(b.net);

    row.appendChild(label);
    row.appendChild(net);
    container.appendChild(row);
  });

  const div = document.createElement("div");
  div.className = "divider";
  container.appendChild(div);

  if (settlement.transactions.length === 0) {
    const done = document.createElement("div");
    done.className = "transaction-line";
    done.style.color = "var(--positive)";
    done.style.fontWeight = "600";
    done.textContent = "✨ Everyone is settled up!";
    container.appendChild(done);
  } else {
    settlement.transactions.forEach((t) => {
      const line = document.createElement("div");
      line.className = "transaction-line";
      line.innerHTML = `
        <span class="transaction-arrow">
          <strong>${t.from_name}</strong>
          <span style="color:var(--accent)">→</span>
          <strong>${t.to_name}</strong>
        </span>
        <span class="transaction-amount">${euros(t.amount)}</span>
      `;
      container.appendChild(line);
    });
  }
}

// ---------- Analytics Chart ----------

function renderAnalytics() {
  const canvas = $("analytics-chart");
  const legendContainer = $("chart-legend");
  const totalEl = $("analytics-total");

  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const width = canvas.offsetWidth || 300;
  canvas.width = width * window.devicePixelRatio || 300;
  canvas.height = 120 * window.devicePixelRatio;

  const personTotals = {};
  let totalMonthSpend = 0;

  people.forEach(p => { personTotals[p.id] = 0; });

  bills.forEach(b => {
    b.items.forEach(item => {
      totalMonthSpend += item.price;
      const assignees = item.assignee_ids;
      if (assignees.length > 0) {
        const split = item.price / assignees.length;
        assignees.forEach(pid => {
          if (personTotals[pid] !== undefined) {
            personTotals[pid] += split;
          }
        });
      }
    });
  });

  totalEl.textContent = `Total: ${euros(totalMonthSpend)}`;

  const dpr = window.devicePixelRatio || 1;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, 120);

  legendContainer.innerHTML = "";

  people.forEach((p) => {
    const amount = personTotals[p.id] || 0;
    const color = colorFor(p.id);

    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `
      <div class="legend-dot" style="background:${color}"></div>
      <span>${p.name}: <strong>${euros(amount)}</strong></span>
    `;
    legendContainer.appendChild(item);
  });

  let currentX = 0;
  const totalShare = Object.values(personTotals).reduce((a, b) => a + b, 0) || 1;

  people.forEach((p) => {
    const amount = personTotals[p.id] || 0;
    if (amount <= 0) return;

    const segmentWidth = (amount / totalShare) * (width - 20);
    const color = colorFor(p.id);

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(currentX + 10, 40, Math.max(segmentWidth - 2, 4), 32, 6);
    ctx.fill();

    currentX += segmentWidth;
  });
}

init();
