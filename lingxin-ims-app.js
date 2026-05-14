(function () {
  "use strict";

  const STORAGE_KEY = "hardware_ims_v5";
  const LEGACY_STORAGE_KEYS = ["hardware_ims_v4", "hardware_ims_v3"];
  const BACKUP_FILE_VERSION = 2;
  const REMINDER_DAYS = 7;
  const REMINDER_KEY = "hardware_ims_backup_reminder_v1";
  const CLOUD_SYNC_KEY = "hardware_ims_cloud_sync_v1";

  function uid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "id_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
  }

  function money(n) {
    const x = Number(n) || 0;
    return "¥" + x.toFixed(2);
  }

  function num(n) {
    const x = Number(n);
    return Number.isFinite(x) ? x : 0;
  }

  function todayISO() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function cmpDate(a, b) {
    return String(a).localeCompare(String(b));
  }

  function defaultState() {
    const whId = uid();
    const catId = uid();
    return {
      categories: [{ id: catId, name: "未分类" }],
      warehouses: [{ id: whId, name: "默认仓" }],
      purchases: [],
      sales: [],
      adjustments: [],
      transfers: [],
      receipts: [],
      settings: { backupReminderEnabled: true, lastBackupPromptAt: null },
    };
  }

  function loadRaw() {
    try {
      const t = localStorage.getItem(STORAGE_KEY);
      if (t) return JSON.parse(t);
    } catch (e) {}
    for (const k of LEGACY_STORAGE_KEYS) {
      try {
        const t = localStorage.getItem(k);
        if (t) return JSON.parse(t);
      } catch (e2) {}
    }
    return null;
  }

  function migrateIfNeeded(raw) {
    if (!raw || typeof raw !== "object") return defaultState();
    const s = { ...defaultState(), ...raw };
    if (!Array.isArray(s.categories) || !s.categories.length) s.categories = defaultState().categories;
    if (!Array.isArray(s.warehouses) || !s.warehouses.length) s.warehouses = defaultState().warehouses;
    if (!Array.isArray(s.purchases)) s.purchases = [];
    if (!Array.isArray(s.sales)) s.sales = [];
    if (!Array.isArray(s.adjustments)) s.adjustments = [];
    if (!Array.isArray(s.transfers)) s.transfers = [];
    if (!Array.isArray(s.receipts)) s.receipts = [];
    if (!s.settings || typeof s.settings !== "object") s.settings = { backupReminderEnabled: true, lastBackupPromptAt: null };
    const defWh = s.warehouses[0].id;
    const defCat = s.categories[0].id;
    s.purchases = s.purchases.map((p) => ({
      ...p,
      warehouseId: p.warehouseId || p.warehouse || defWh,
      categoryId: p.categoryId || p.category || defCat,
      qty: num(p.qty),
      price: num(p.price),
    }));
    s.sales = s.sales.map((x) => ({
      ...x,
      warehouseId: x.warehouseId || x.warehouse || defWh,
      categoryId: x.categoryId || x.category || defCat,
      paymentType: x.paymentType === "credit" ? "credit" : "cash",
      customerName: x.customerName || "",
      paidAtSale: num(x.paidAtSale),
      qty: num(x.qty),
      price: num(x.price),
      arReceiptAllocated: num(x.arReceiptAllocated),
      arManualPaid: num(x.arManualPaid),
    }));
    s.adjustments = s.adjustments.map((a) => ({
      ...a,
      warehouseId: a.warehouseId || a.warehouse || defWh,
      qty: num(a.qty),
    }));
    s.transfers = s.transfers.map((t) => ({
      ...t,
      qty: num(t.qty),
    }));
    s.receipts = s.receipts.map((r) => ({
      ...r,
      amount: num(r.amount),
    }));
    return s;
  }

  function whName(state, id) {
    const w = state.warehouses.find((x) => x.id === id);
    return w ? w.name : "—";
  }

  function catName(state, id) {
    const c = state.categories.find((x) => x.id === id);
    return c ? c.name : "—";
  }

  function productKey(p) {
    return String(p || "").trim();
  }

  function cellKey(warehouseId, product) {
    return warehouseId + "|||" + productKey(product);
  }

  function getCell(map, k) {
    if (!map.has(k)) map.set(k, { qty: 0, totalCost: 0 });
    return map.get(k);
  }

  function avgUnit(cell) {
    if (cell.qty <= 0) return 0;
    return cell.totalCost / cell.qty;
  }

  /** @returns {{ inv: Map<string,{qty:number,totalCost:number}>, saleCogs: Map<string,number> }} */
  function buildLedger(state) {
    const inv = new Map();
    const saleCogs = new Map();

    function evList() {
      const out = [];
      state.purchases.forEach((p) =>
        out.push({ ord: 1, date: p.date, id: p.id, kind: "purchase", row: p })
      );
      state.transfers.forEach((t) =>
        out.push({ ord: 2, date: t.date, id: t.id, kind: "transfer", row: t })
      );
      state.adjustments.forEach((a) =>
        out.push({ ord: 3, date: a.date, id: a.id, kind: "adjustment", row: a })
      );
      state.sales.forEach((s) => out.push({ ord: 4, date: s.date, id: s.id, kind: "sale", row: s }));
      out.sort((a, b) => cmpDate(a.date, b.date) || a.ord - b.ord || String(a.id).localeCompare(String(b.id)));
      return out;
    }

    for (const ev of evList()) {
      if (ev.kind === "purchase") {
        const p = ev.row;
        const k = cellKey(p.warehouseId, p.product);
        const c = getCell(inv, k);
        const q = Math.max(0, num(p.qty));
        const price = Math.max(0, num(p.price));
        c.qty += q;
        c.totalCost += q * price;
      } else if (ev.kind === "transfer") {
        const t = ev.row;
        const q = Math.max(0, num(t.qty));
        if (!t.fromWarehouseId || !t.toWarehouseId || t.fromWarehouseId === t.toWarehouseId) continue;
        const kf = cellKey(t.fromWarehouseId, t.product);
        const kt = cellKey(t.toWarehouseId, t.product);
        const cf = getCell(inv, kf);
        const ct = getCell(inv, kt);
        const take = Math.min(q, Math.max(0, cf.qty));
        if (take <= 0) continue;
        const av = avgUnit(cf);
        const costMove = take * av;
        cf.qty -= take;
        cf.totalCost -= costMove;
        ct.qty += take;
        ct.totalCost += costMove;
      } else if (ev.kind === "adjustment") {
        const a = ev.row;
        const k = cellKey(a.warehouseId, a.product);
        const c = getCell(inv, k);
        const q = num(a.qty);
        if (q > 0) {
          const av = avgUnit(c);
          c.qty += q;
          c.totalCost += q * av;
        } else {
          let need = -q;
          need = Math.min(need, Math.max(0, c.qty));
          if (need <= 0) continue;
          const av = avgUnit(c);
          c.qty -= need;
          c.totalCost -= need * av;
        }
      } else if (ev.kind === "sale") {
        const s = ev.row;
        const k = cellKey(s.warehouseId, s.product);
        const c = getCell(inv, k);
        const need = Math.max(0, num(s.qty));
        const take = Math.min(need, Math.max(0, c.qty));
        const av = avgUnit(c);
        const cost = take * av;
        c.qty -= take;
        c.totalCost -= cost;
        saleCogs.set(s.id, cost);
      }
    }
    return { inv, saleCogs };
  }

  function recomputeSaleCosts(state) {
    const { saleCogs } = buildLedger(state);
    state.sales.forEach((s) => {
      s.amount = +(num(s.qty) * num(s.price)).toFixed(2);
      s.costAtSale = +(saleCogs.get(s.id) || 0).toFixed(2);
    });
  }

  function recomputeArReceiptAllocations(state) {
    state.sales.forEach((s) => {
      s.arReceiptAllocated = 0;
    });
    const receipts = [...state.receipts].sort(
      (a, b) => cmpDate(a.date, b.date) || String(a.id).localeCompare(String(b.id))
    );
    const arSales = state.sales
      .filter((s) => creditRemaining(s) > 0.0001 && String(s.customerName || "").trim())
      .sort((a, b) => cmpDate(a.date, b.date) || String(a.id).localeCompare(String(b.id)));

    for (const r of receipts) {
      let left = Math.max(0, num(r.amount));
      const cust = String(r.customerName || "").trim();
      if (!cust) continue;
      for (const s of arSales) {
        if (left <= 0) break;
        if (String(s.customerName || "").trim() !== cust) continue;
        const creditTotal = Math.max(0, num(s.amount) - num(s.paidAtSale));
        const open = Math.max(0, creditTotal - num(s.arReceiptAllocated));
        const x = Math.min(open, left);
        s.arReceiptAllocated = num(s.arReceiptAllocated) + x;
        left -= x;
      }
    }
  }

  function syncAllComputed(state) {
    recomputeSaleCosts(state);
    recomputeArReceiptAllocations(state);
  }

  function saveState(state) {
    syncAllComputed(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function loadCloudConfig() {
    try {
      const t = localStorage.getItem(CLOUD_SYNC_KEY);
      return t ? JSON.parse(t) : null;
    } catch {
      return null;
    }
  }

  function saveCloudConfig(cfg) {
    localStorage.setItem(CLOUD_SYNC_KEY, JSON.stringify(cfg));
  }

  async function cloudPull(cfg) {
    const url = String(cfg?.url || "").replace(/\/+$/, "");
    const anonKey = String(cfg?.anonKey || "");
    const bucket = String(cfg?.bucket || "lingxin-ims");
    const objectPath = String(cfg?.objectPath || "");
    if (!url || !anonKey || !objectPath) throw new Error("云同步未配置完整（URL/Key/同步码）");

    const objUrl = `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath}`;
    const res = await fetch(objUrl, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("云端下载失败：" + res.status);
    const text = await res.text();
    const parsed = JSON.parse(text);
    return migrateIfNeeded(parsed?.data || parsed);
  }

  async function cloudPush(cfg, state) {
    const url = String(cfg?.url || "").replace(/\/+$/, "");
    const anonKey = String(cfg?.anonKey || "");
    const bucket = String(cfg?.bucket || "lingxin-ims");
    const objectPath = String(cfg?.objectPath || "");
    if (!url || !anonKey || !objectPath) throw new Error("云同步未配置完整（URL/Key/同步码）");
    syncAllComputed(state);
    const payload = JSON.stringify({ savedAt: new Date().toISOString(), data: state });
    const objUrl = `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath}`;
    const res = await fetch(objUrl, {
      method: "PUT",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
        "x-upsert": "true",
      },
      body: payload,
    });
    if (!res.ok) throw new Error("云端上传失败：" + res.status);
    return true;
  }

  function creditRemaining(s) {
    const total = Math.max(0, num(s.amount) - Math.max(0, num(s.paidAtSale)));
    const applied = Math.max(0, num(s.arReceiptAllocated)) + Math.max(0, num(s.arManualPaid));
    return Math.max(0, total - applied);
  }

  function arCustomerBalances(state) {
    const map = new Map();
    state.sales.forEach((s) => {
      const bal = creditRemaining(s);
      if (bal <= 0) return;
      const c = String(s.customerName || "").trim() || "（未填写客户）";
      map.set(c, (map.get(c) || 0) + bal);
    });
    return map;
  }

  function collectProducts(state) {
    const set = new Set();
    state.purchases.forEach((p) => set.add(productKey(p.product)));
    state.sales.forEach((s) => set.add(productKey(s.product)));
    state.adjustments.forEach((a) => set.add(productKey(a.product)));
    state.transfers.forEach((t) => set.add(productKey(t.product)));
    return Array.from(set).filter(Boolean).sort();
  }

  function collectCustomers(state) {
    const set = new Set();
    state.sales.forEach((s) => {
      if (String(s.customerName || "").trim()) set.add(String(s.customerName).trim());
    });
    state.receipts.forEach((r) => {
      if (String(r.customerName || "").trim()) set.add(String(r.customerName).trim());
    });
    return Array.from(set).sort();
  }

  function fillSelect(sel, items, extraBlank) {
    const cur = sel.value;
    sel.innerHTML = "";
    if (extraBlank) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = extraBlank;
      sel.appendChild(o);
    }
    items.forEach((it) => {
      const o = document.createElement("option");
      o.value = it.id;
      o.textContent = it.name;
      sel.appendChild(o);
    });
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  }

  function fillDatalist(dl, values) {
    dl.innerHTML = "";
    values.forEach((v) => {
      const o = document.createElement("option");
      o.value = v;
      dl.appendChild(o);
    });
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function optionsHtml(items, selectedId) {
    return items
      .map((it) => `<option value="${escapeHtml(it.id)}"${it.id === selectedId ? " selected" : ""}>${escapeHtml(it.name)}</option>`)
      .join("");
  }

  function openModal(title, bodyHtml, onSave) {
    const overlay = document.getElementById("modalOverlay");
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div class="modal-title">${escapeHtml(title)}</div>
          <button type="button" class="btn-link" data-modal-close>关闭</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-footer">
          <button type="button" class="btn-secondary" data-modal-cancel>取消</button>
          <button type="button" class="btn-primary" data-modal-save>保存</button>
        </div>
      </div>
    `;
    overlay.classList.add("show");
    overlay.setAttribute("aria-hidden", "false");

    function close() {
      overlay.classList.remove("show");
      overlay.setAttribute("aria-hidden", "true");
      overlay.innerHTML = "";
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);

    overlay.addEventListener(
      "click",
      (e) => {
        if (e.target === overlay) close();
      },
      { once: false }
    );
    overlay.querySelectorAll("[data-modal-close],[data-modal-cancel]").forEach((b) =>
      b.addEventListener("click", close)
    );
    overlay.querySelector("[data-modal-save]").addEventListener("click", async () => {
      try {
        const ok = await onSave(overlay);
        if (ok !== false) close();
      } catch (err) {
        alert(err && err.message ? err.message : String(err));
      }
    });
  }

  function ledgerAvailableAfterRemovingSale(saleId, warehouseId, product) {
    // compute available stock if a given sale is temporarily removed (for editing)
    const saved = state.sales;
    state.sales = state.sales.filter((x) => x.id !== saleId);
    const avail = stockAvailable(warehouseId, product);
    state.sales = saved;
    return avail;
  }

  function maybeBackupReminder() {
    try {
      const raw = localStorage.getItem(REMINDER_KEY);
      const o = raw ? JSON.parse(raw) : {};
      if (o.disabled) return;
      const last = o.lastPrompt ? new Date(o.lastPrompt).getTime() : 0;
      const now = Date.now();
      if (!last || now - last > REMINDER_DAYS * 86400000) {
        if (confirm("已超过 " + REMINDER_DAYS + " 天未提示备份。是否现在导出 JSON 备份？\n（点取消可稍后在顶部「导出备份」）")) {
          document.getElementById("backupExportBtn").click();
        }
        o.lastPrompt = new Date().toISOString();
        localStorage.setItem(REMINDER_KEY, JSON.stringify(o));
      }
    } catch (e) {}
  }

  function exportBackup(state) {
    syncAllComputed(state);
    const payload = {
      version: BACKUP_FILE_VERSION,
      exportedAt: new Date().toISOString(),
      app: "玲鑫建材进销存",
      data: state,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "玲鑫进销存备份_" + todayISO() + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importBackup(text) {
    const j = JSON.parse(text);
    const data = j.data && typeof j.data === "object" ? j.data : j;
    const s = migrateIfNeeded(data);
    saveState(s);
    return s;
  }

  /** -------- Chart (minimal canvas) -------- */
  function drawTrendChart(canvas, labels, revenue, expense, profit) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
    const h = canvas.height = (canvas.clientHeight || 280) * (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, w, h);
    const pad = 36 * (window.devicePixelRatio || 1);
    const n = Math.max(1, labels.length);
    const innerW = w - pad * 2;
    const innerH = h - pad * 2;
    const xs = (i) => pad + (innerW * (n === 1 ? 0.5 : i / (n - 1)));
    const all = [...revenue, ...expense, ...profit];
    const maxY = Math.max(1, ...all.map(Math.abs));
    const y0 = pad + innerH;
    const y1 = pad;
    const mapY = (v) => y0 - (innerH * (v + maxY)) / (2 * maxY);

    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--border") || "#e2e8f0";
    ctx.lineWidth = 1 * (window.devicePixelRatio || 1);
    ctx.beginPath();
    ctx.moveTo(pad, mapY(0));
    ctx.lineTo(pad + innerW, mapY(0));
    ctx.stroke();

    function line(arr, color) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = xs(i);
        const y = mapY(num(arr[i]));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    line(revenue, "#2563eb");
    line(expense, "#d97706");
    line(profit, "#16a34a");

    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted") || "#64748b";
    ctx.font = 11 * (window.devicePixelRatio || 1) + "px sans-serif";
    ctx.fillText("0", 4, mapY(0) + 4);
    ctx.fillText(maxY.toFixed(0), 4, y1 + 10);
  }

  /** -------- Analytics helpers -------- */
  function inRange(date, start, end) {
    if (start && date < start) return false;
    if (end && date > end) return false;
    return true;
  }

  function weekKey(iso) {
    const d = new Date(iso + "T12:00:00");
    const onejan = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
    return d.getFullYear() + "-W" + String(week).padStart(2, "0");
  }

  function monthKey(iso) {
    return iso.slice(0, 7);
  }

  function filterRows(state, start, end, warehouseId, categoryId) {
    const wh = warehouseId || "";
    const cat = categoryId || "";
    const ok = (row) => {
      if (!inRange(row.date, start, end)) return false;
      if (wh && row.warehouseId !== wh) return false;
      if (cat && row.categoryId !== cat) return false;
      return true;
    };
    return {
      purchases: state.purchases.filter(ok),
      sales: state.sales.filter(ok),
    };
  }

  /** -------- DOM App -------- */
  let state = migrateIfNeeded(loadRaw());
  saveState(state);

  const els = {
    themeBtn: document.getElementById("themeBtn"),
    cloudSyncBtn: document.getElementById("cloudSyncBtn"),
    backupExportBtn: document.getElementById("backupExportBtn"),
    backupImportBtn: document.getElementById("backupImportBtn"),
    backupFileInput: document.getElementById("backupFileInput"),
    productList: document.getElementById("productList"),
    customerList: document.getElementById("customerList"),
    tabBtns: document.querySelectorAll(".tab-btn"),
    panels: document.querySelectorAll(".panel"),
    pDate: document.getElementById("pDate"),
    pSupplier: document.getElementById("pSupplier"),
    pProduct: document.getElementById("pProduct"),
    pCategory: document.getElementById("pCategory"),
    pWarehouse: document.getElementById("pWarehouse"),
    pQty: document.getElementById("pQty"),
    pPrice: document.getElementById("pPrice"),
    purchaseForm: document.getElementById("purchaseForm"),
    purchaseSearch: document.getElementById("purchaseSearch"),
    purchaseCategoryFilter: document.getElementById("purchaseCategoryFilter"),
    purchaseTbody: document.getElementById("purchaseTbody"),
    sDate: document.getElementById("sDate"),
    sProduct: document.getElementById("sProduct"),
    sCategory: document.getElementById("sCategory"),
    sWarehouse: document.getElementById("sWarehouse"),
    sQty: document.getElementById("sQty"),
    sPrice: document.getElementById("sPrice"),
    sPaymentType: document.getElementById("sPaymentType"),
    sCustomer: document.getElementById("sCustomer"),
    sPaidNow: document.getElementById("sPaidNow"),
    sBuyer: document.getElementById("sBuyer"),
    salesForm: document.getElementById("salesForm"),
    salesSearch: document.getElementById("salesSearch"),
    salesCategoryFilter: document.getElementById("salesCategoryFilter"),
    salesTbody: document.getElementById("salesTbody"),
    rcDate: document.getElementById("rcDate"),
    rcCustomer: document.getElementById("rcCustomer"),
    rcAmount: document.getElementById("rcAmount"),
    rcNote: document.getElementById("rcNote"),
    receiptForm: document.getElementById("receiptForm"),
    arSummaryTbody: document.getElementById("arSummaryTbody"),
    arCreditTbody: document.getElementById("arCreditTbody"),
    arPaidTbody: document.getElementById("arPaidTbody"),
    receiptTbody: document.getElementById("receiptTbody"),
    aDate: document.getElementById("aDate"),
    aWarehouse: document.getElementById("aWarehouse"),
    aProduct: document.getElementById("aProduct"),
    aQty: document.getElementById("aQty"),
    aReason: document.getElementById("aReason"),
    adjustForm: document.getElementById("adjustForm"),
    tDate: document.getElementById("tDate"),
    tProduct: document.getElementById("tProduct"),
    tQty: document.getElementById("tQty"),
    tFrom: document.getElementById("tFrom"),
    tTo: document.getElementById("tTo"),
    tNote: document.getElementById("tNote"),
    transferForm: document.getElementById("transferForm"),
    warehouseForm: document.getElementById("warehouseForm"),
    newWarehouse: document.getElementById("newWarehouse"),
    warehouseTbody: document.getElementById("warehouseTbody"),
    categoryForm: document.getElementById("categoryForm"),
    newCategory: document.getElementById("newCategory"),
    categoryTbody: document.getElementById("categoryTbody"),
    invWarehouseFilter: document.getElementById("invWarehouseFilter"),
    inventoryTbody: document.getElementById("inventoryTbody"),
    transferTbody: document.getElementById("transferTbody"),
    adjustTbody: document.getElementById("adjustTbody"),
    filterForm: document.getElementById("filterForm"),
    fStart: document.getElementById("fStart"),
    fEnd: document.getElementById("fEnd"),
    fWarehouse: document.getElementById("fWarehouse"),
    fGroup: document.getElementById("fGroup"),
    fCategory: document.getElementById("fCategory"),
    resetFilterBtn: document.getElementById("resetFilterBtn"),
    exportMonthBtn: document.getElementById("exportMonthBtn"),
    sumRevenue: document.getElementById("sumRevenue"),
    sumCogs: document.getElementById("sumCogs"),
    sumProfit: document.getElementById("sumProfit"),
    sumMargin: document.getElementById("sumMargin"),
    profitGroupTbody: document.getElementById("profitGroupTbody"),
    productStatsTbody: document.getElementById("productStatsTbody"),
    categoryStatsTbody: document.getElementById("categoryStatsTbody"),
    trendChart: document.getElementById("trendChart"),
  };

  function setTheme(dark) {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    localStorage.setItem("hardware_ims_theme", dark ? "dark" : "light");
  }
  setTheme(localStorage.getItem("hardware_ims_theme") === "dark");

  els.themeBtn.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") === "dark";
    setTheme(!cur);
  });

  if (els.cloudSyncBtn) {
    els.cloudSyncBtn.addEventListener("click", () => {
      const cfg = loadCloudConfig() || {};
      const body = `
        <form class="form-grid" onsubmit="return false;">
          <div class="form-group" style="grid-column:span 2"><label>Supabase URL</label><input id="m_url" placeholder="https://xxxx.supabase.co" value="${escapeHtml(cfg.url || "")}"></div>
          <div class="form-group" style="grid-column:span 2"><label>Supabase anon key</label><input id="m_key" placeholder="ey..." value="${escapeHtml(cfg.anonKey || "")}"></div>
          <div class="form-group"><label>Bucket(默认)</label><input id="m_bucket" value="${escapeHtml(cfg.bucket || "lingxin-ims")}"></div>
          <div class="form-group"><label>同步码(建议手机号)</label><input id="m_code" placeholder="例如：13800138000" value="${escapeHtml(cfg.code || "")}"></div>
          <div class="form-group" style="grid-column:span 2"><label>说明</label><input value="同一个同步码=同一套数据，多设备共用" disabled></div>
          <div class="form-group"><button type="button" class="btn-secondary" id="m_pull">从云端下载覆盖本机</button></div>
          <div class="form-group"><button type="button" class="btn-secondary" id="m_push">上传本机到云端</button></div>
        </form>
      `;
      openModal("云同步设置", body, async () => {
        const url = document.getElementById("m_url").value.trim();
        const anonKey = document.getElementById("m_key").value.trim();
        const bucket = document.getElementById("m_bucket").value.trim() || "lingxin-ims";
        const code = document.getElementById("m_code").value.trim();
        if (!url || !anonKey || !code) return alert("请填写 URL、anon key、同步码");
        const objectPath = `sync/${encodeURIComponent(code)}.json`;
        const next = { url, anonKey, bucket, code, objectPath };
        saveCloudConfig(next);
        alert("已保存云同步配置。可用下方按钮上传/下载。");
        return true;
      });

      // Bind pull/push buttons once modal is present
      setTimeout(() => {
        const pullBtn = document.getElementById("m_pull");
        const pushBtn = document.getElementById("m_push");
        if (pullBtn)
          pullBtn.addEventListener("click", async () => {
            const current = loadCloudConfig() || {};
            // use modal input values if present
            const url = document.getElementById("m_url")?.value?.trim() || current.url;
            const anonKey = document.getElementById("m_key")?.value?.trim() || current.anonKey;
            const bucket = document.getElementById("m_bucket")?.value?.trim() || current.bucket || "lingxin-ims";
            const code = document.getElementById("m_code")?.value?.trim() || current.code;
            const objectPath = `sync/${encodeURIComponent(code)}.json`;
            const cfg2 = { url, anonKey, bucket, code, objectPath };
            saveCloudConfig(cfg2);
            const pulled = await cloudPull(cfg2);
            if (!pulled) return alert("云端暂无数据（请先在另一台设备上传一次）");
            state = pulled;
            saveState(state);
            fullRender();
            alert("已从云端下载并覆盖本机");
          });
        if (pushBtn)
          pushBtn.addEventListener("click", async () => {
            const current = loadCloudConfig() || {};
            const url = document.getElementById("m_url")?.value?.trim() || current.url;
            const anonKey = document.getElementById("m_key")?.value?.trim() || current.anonKey;
            const bucket = document.getElementById("m_bucket")?.value?.trim() || current.bucket || "lingxin-ims";
            const code = document.getElementById("m_code")?.value?.trim() || current.code;
            const objectPath = `sync/${encodeURIComponent(code)}.json`;
            const cfg2 = { url, anonKey, bucket, code, objectPath };
            saveCloudConfig(cfg2);
            await cloudPush(cfg2, state);
            alert("已上传到云端");
          });
      }, 0);
    });
  }

  els.tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      els.tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
      els.panels.forEach((p) => p.classList.toggle("active", p.id === "tab-" + tab));
      if (tab === "analytics") renderAnalytics();
    });
  });

  function refreshSelectors() {
    const whs = state.warehouses;
    const cats = state.categories;
    fillSelect(els.pWarehouse, whs, null);
    fillSelect(els.sWarehouse, whs, null);
    fillSelect(els.aWarehouse, whs, null);
    fillSelect(els.tFrom, whs, null);
    fillSelect(els.tTo, whs, null);
    fillSelect(els.pCategory, cats, null);
    fillSelect(els.sCategory, cats, null);
    fillSelect(els.purchaseCategoryFilter, cats, "全部分类");
    fillSelect(els.salesCategoryFilter, cats, "全部分类");
    fillSelect(els.invWarehouseFilter, whs, "全部仓库");
    fillSelect(els.fWarehouse, whs, "全部仓库");
    fillSelect(els.fCategory, cats, "全部分类");
    fillDatalist(els.productList, collectProducts(state));
    fillDatalist(els.customerList, collectCustomers(state));
  }

  function renderPurchases() {
    const q = els.purchaseSearch.value.trim().toLowerCase();
    const cf = els.purchaseCategoryFilter.value;
    const rows = state.purchases
      .filter((p) => {
        if (cf && p.categoryId !== cf) return false;
        if (q && !String(p.product).toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => -cmpDate(a.date, b.date));
    els.purchaseTbody.innerHTML = "";
    rows.forEach((p) => {
      const tr = document.createElement("tr");
      const sub = num(p.qty) * num(p.price);
      tr.innerHTML = `
        <td data-label="日期">${p.date}</td>
        <td data-label="仓库">${whName(state, p.warehouseId)}</td>
        <td data-label="供应商">${p.supplier || ""}</td>
        <td data-label="商品">${p.product || ""}</td>
        <td data-label="分类">${catName(state, p.categoryId)}</td>
        <td data-label="数量">${num(p.qty).toFixed(2)}</td>
        <td data-label="单价">${money(p.price)}</td>
        <td data-label="小计">${money(sub)}</td>
        <td data-label="操作">
          <button type="button" class="btn-mini" data-edit-p="${p.id}">编辑</button>
          <button type="button" class="btn-danger" data-del-p="${p.id}">删除</button>
        </td>`;
      els.purchaseTbody.appendChild(tr);
    });
    els.purchaseTbody.querySelectorAll("[data-edit-p]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-edit-p");
        const p = state.purchases.find((x) => x.id === id);
        if (!p) return;
        const body = `
          <form class="form-grid" onsubmit="return false;">
            <div class="form-group"><label>日期</label><input type="date" id="m_date" value="${escapeHtml(p.date)}"></div>
            <div class="form-group"><label>供应商</label><input type="text" id="m_supplier" value="${escapeHtml(p.supplier || "")}"></div>
            <div class="form-group"><label>商品</label><input type="text" id="m_product" value="${escapeHtml(p.product || "")}"></div>
            <div class="form-group"><label>分类</label><select id="m_category">${optionsHtml(state.categories, p.categoryId)}</select></div>
            <div class="form-group"><label>入库仓库</label><select id="m_warehouse">${optionsHtml(state.warehouses, p.warehouseId)}</select></div>
            <div class="form-group"><label>数量</label><input type="number" id="m_qty" step="0.01" value="${num(p.qty)}"></div>
            <div class="form-group"><label>单价</label><input type="number" id="m_price" step="0.01" value="${num(p.price)}"></div>
          </form>`;
        openModal("编辑进货", body, () => {
          const next = {
            ...p,
            date: document.getElementById("m_date").value,
            supplier: document.getElementById("m_supplier").value.trim(),
            product: document.getElementById("m_product").value.trim(),
            categoryId: document.getElementById("m_category").value,
            warehouseId: document.getElementById("m_warehouse").value,
            qty: num(document.getElementById("m_qty").value),
            price: num(document.getElementById("m_price").value),
          };
          if (!next.product) return alert("请填写商品名称");
          state.purchases = state.purchases.map((x) => (x.id === id ? next : x));
          saveState(state);
          fullRender();
          return true;
        });
      });
    });
    els.purchaseTbody.querySelectorAll("[data-del-p]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-del-p");
        if (!confirm("确定删除该进货？")) return;
        state.purchases = state.purchases.filter((x) => x.id !== id);
        saveState(state);
        fullRender();
      });
    });
  }

  function stockAvailable(warehouseId, product) {
    const { inv } = buildLedger(state);
    const c = inv.get(cellKey(warehouseId, product));
    return c ? num(c.qty) : 0;
  }

  function renderSales() {
    syncAllComputed(state);
    const q = els.salesSearch.value.trim().toLowerCase();
    const cf = els.salesCategoryFilter.value;
    const rows = state.sales
      .filter((s) => {
        if (cf && s.categoryId !== cf) return false;
        if (q && !String(s.product).toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => -cmpDate(a.date, b.date));
    els.salesTbody.innerHTML = "";
    rows.forEach((s) => {
      const tr = document.createElement("tr");
      const rem = creditRemaining(s);
      const pay = s.paymentType === "credit" ? "赊账" : "现款";
      tr.innerHTML = `
        <td data-label="日期">${s.date}</td>
        <td data-label="仓库">${whName(state, s.warehouseId)}</td>
        <td data-label="商品">${s.product || ""}</td>
        <td data-label="分类">${catName(state, s.categoryId)}</td>
        <td data-label="付款">${pay}</td>
        <td data-label="客户">${s.customerName || ""}</td>
        <td data-label="数量">${num(s.qty).toFixed(2)}</td>
        <td data-label="售价">${money(s.price)}</td>
        <td data-label="成本">${money(s.costAtSale)}</td>
        <td data-label="小计">${money(s.amount)}</td>
        <td data-label="已收">${money(Math.min(num(s.amount), Math.max(0, num(s.paidAtSale))))}</td>
        <td data-label="欠款">${rem > 0.0001 ? money(rem) : "—"}</td>
        <td data-label="买方">${s.buyer || ""}</td>
        <td data-label="操作">
          <button type="button" class="btn-mini" data-edit-s="${s.id}">编辑</button>
          <button type="button" class="btn-danger" data-del-s="${s.id}">删除</button>
        </td>`;
      els.salesTbody.appendChild(tr);
    });
    els.salesTbody.querySelectorAll("[data-edit-s]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-edit-s");
        const s = state.sales.find((x) => x.id === id);
        if (!s) return;
        const body = `
          <form class="form-grid" onsubmit="return false;">
            <div class="form-group"><label>日期</label><input type="date" id="m_date" value="${escapeHtml(s.date)}"></div>
            <div class="form-group"><label>商品</label><input type="text" id="m_product" value="${escapeHtml(s.product || "")}"></div>
            <div class="form-group"><label>分类</label><select id="m_category">${optionsHtml(state.categories, s.categoryId)}</select></div>
            <div class="form-group"><label>出库仓库</label><select id="m_warehouse">${optionsHtml(state.warehouses, s.warehouseId)}</select></div>
            <div class="form-group"><label>数量</label><input type="number" id="m_qty" step="0.01" value="${num(s.qty)}"></div>
            <div class="form-group"><label>售价</label><input type="number" id="m_price" step="0.01" value="${num(s.price)}"></div>
            <div class="form-group"><label>客户</label><input type="text" id="m_customer" value="${escapeHtml(s.customerName || "")}"></div>
            <div class="form-group"><label>当场已收</label><input type="number" id="m_paid" step="0.01" value="${num(s.paidAtSale)}"></div>
            <div class="form-group" style="grid-column:span 2"><label>买方</label><input type="text" id="m_buyer" value="${escapeHtml(s.buyer || "")}"></div>
          </form>`;
        openModal("编辑销售", body, () => {
          const next = {
            ...s,
            date: document.getElementById("m_date").value,
            product: document.getElementById("m_product").value.trim(),
            categoryId: document.getElementById("m_category").value,
            warehouseId: document.getElementById("m_warehouse").value,
            qty: num(document.getElementById("m_qty").value),
            price: num(document.getElementById("m_price").value),
            customerName: document.getElementById("m_customer").value.trim(),
            paidAtSale: Math.max(0, num(document.getElementById("m_paid").value)),
            buyer: document.getElementById("m_buyer").value.trim(),
          };
          if (!next.product) return alert("请填写商品名称");
          next.amount = +(num(next.qty) * num(next.price)).toFixed(2);
          next.paidAtSale = Math.min(next.amount, next.paidAtSale);

          const avail = ledgerAvailableAfterRemovingSale(id, next.warehouseId, next.product);
          if (next.qty > avail + 1e-6) return alert("库存不足（当前仓可用 " + avail.toFixed(2) + "）");

          state.sales = state.sales.map((x) => (x.id === id ? next : x));
          saveState(state);
          fullRender();
          return true;
        });
      });
    });
    els.salesTbody.querySelectorAll("[data-del-s]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-del-s");
        if (!confirm("确定删除该销售？")) return;
        state.sales = state.sales.filter((x) => x.id !== id);
        saveState(state);
        fullRender();
      });
    });
  }

  function renderReceivables() {
    syncAllComputed(state);
    const balances = arCustomerBalances(state);
    els.arSummaryTbody.innerHTML = "";
    Array.from(balances.entries())
      .sort((a, b) => b[1] - a[1])
      .forEach(([name, bal]) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td data-label="客户">${name}</td><td data-label="应收余额">${money(bal)}</td>`;
        els.arSummaryTbody.appendChild(tr);
      });
    if (!els.arSummaryTbody.children.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="2" class="muted">暂无欠款客户</td>`;
      els.arSummaryTbody.appendChild(tr);
    }

    els.arCreditTbody.innerHTML = "";
    const unpaidRows = state.sales
      .filter((s) => creditRemaining(s) > 0.001)
      .sort((a, b) => cmpDate(a.date, b.date));
    unpaidRows.forEach((s) => {
      const tr = document.createElement("tr");
      const rem = creditRemaining(s);
      tr.innerHTML = `
        <td data-label="日期">${s.date}</td>
        <td data-label="客户">${String(s.customerName || "").trim() || "（未填写客户）"}</td>
        <td data-label="商品">${s.product || ""}</td>
        <td data-label="小计">${money(s.amount)}</td>
        <td data-label="当场已收">${money(s.paidAtSale)}</td>
        <td data-label="收款核销">${money(s.arReceiptAllocated)}</td>
        <td data-label="剩余欠款">${money(rem)}</td>
        <td data-label="已收款"><input type="checkbox" data-ar-paid="${s.id}" /></td>`;
      els.arCreditTbody.appendChild(tr);
    });
    if (!els.arCreditTbody.children.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="8" class="muted">暂无未结清欠款</td>`;
      els.arCreditTbody.appendChild(tr);
    }

    const paidTbody = document.getElementById("arPaidTbody");
    if (paidTbody) {
      paidTbody.innerHTML = "";
      const paidRows = state.sales
        .filter((s) => creditRemaining(s) <= 0.001 && (num(s.arReceiptAllocated) > 0 || num(s.arManualPaid) > 0 || num(s.paidAtSale) < num(s.amount)))
        .sort((a, b) => -cmpDate(a.date, b.date));
      paidRows.forEach((s) => {
        const tr = document.createElement("tr");
        const manual = Math.max(0, num(s.arManualPaid));
        const paidTotal = Math.min(num(s.amount), Math.max(0, num(s.paidAtSale)) + Math.max(0, num(s.arReceiptAllocated)) + manual);
        tr.innerHTML = `
          <td data-label="日期">${s.date}</td>
          <td data-label="客户">${String(s.customerName || "").trim() || "（未填写客户）"}</td>
          <td data-label="商品">${s.product || ""}</td>
          <td data-label="小计">${money(s.amount)}</td>
          <td data-label="当场已收">${money(s.paidAtSale)}</td>
          <td data-label="收款核销">${money(s.arReceiptAllocated)}</td>
          <td data-label="手动结清">${money(manual)}</td>
          <td data-label="已收合计">${money(paidTotal)}</td>`;
        paidTbody.appendChild(tr);
      });
      if (!paidTbody.children.length) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="8" class="muted">暂无已结清记录</td>`;
        paidTbody.appendChild(tr);
      }
    }

    els.receiptTbody.innerHTML = "";
    [...state.receipts]
      .sort((a, b) => -cmpDate(a.date, b.date))
      .forEach((r) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td data-label="日期">${r.date}</td>
          <td data-label="客户">${r.customerName || ""}</td>
          <td data-label="金额">${money(r.amount)}</td>
          <td data-label="备注">${r.note || ""}</td>
          <td data-label="操作"><button type="button" class="btn-danger" data-del-r="${r.id}">删除</button></td>`;
        els.receiptTbody.appendChild(tr);
      });
    els.receiptTbody.querySelectorAll("[data-del-r]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-del-r");
        if (!confirm("确定删除该收款记录？（核销会重算）")) return;
        state.receipts = state.receipts.filter((x) => x.id !== id);
        saveState(state);
        fullRender();
      });
    });

    // Bind manual paid checkbox
    els.arCreditTbody.querySelectorAll("[data-ar-paid]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.getAttribute("data-ar-paid");
        const s = state.sales.find((x) => x.id === id);
        if (!s) return;
        const rem = Math.max(0, creditRemaining(s));
        if (cb.checked && rem > 0) {
          s.arManualPaid = Math.max(0, num(s.arManualPaid)) + rem;
          saveState(state);
          fullRender();
        }
      });
    });
  }

  function renderInventory() {
    syncAllComputed(state);
    const { inv } = buildLedger(state);
    const whF = els.invWarehouseFilter.value;
    els.inventoryTbody.innerHTML = "";
    const keys = Array.from(inv.keys()).sort();
    keys.forEach((k) => {
      const [whId, prod] = k.split("|||");
      if (whF && whId !== whF) return;
      const c = inv.get(k);
      if (num(c.qty) < 0.0001 && num(c.totalCost) < 0.0001) return;
      const catId = state.purchases.concat(state.sales).find((r) => productKey(r.product) === prod)?.categoryId;
      const tr = document.createElement("tr");
      const avg = avgUnit(c);
      tr.innerHTML = `
        <td data-label="仓库">${whName(state, whId)}</td>
        <td data-label="商品">${prod}</td>
        <td data-label="分类">${catId ? catName(state, catId) : "—"}</td>
        <td data-label="库存数量">${num(c.qty).toFixed(2)}</td>
        <td data-label="库存均价">${money(avg)}</td>
        <td data-label="库存成本">${money(c.totalCost)}</td>`;
      els.inventoryTbody.appendChild(tr);
    });

    els.transferTbody.innerHTML = "";
    [...state.transfers]
      .sort((a, b) => -cmpDate(a.date, b.date))
      .forEach((t) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td data-label="日期">${t.date}</td>
          <td data-label="商品">${t.product}</td>
          <td data-label="数量">${num(t.qty).toFixed(2)}</td>
          <td data-label="从">${whName(state, t.fromWarehouseId)}</td>
          <td data-label="到">${whName(state, t.toWarehouseId)}</td>
          <td data-label="备注">${t.note || ""}</td>
          <td data-label="操作"><button type="button" class="btn-danger" data-del-t="${t.id}">删除</button></td>`;
        els.transferTbody.appendChild(tr);
      });
    els.transferTbody.querySelectorAll("[data-del-t]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-del-t");
        if (!confirm("确定删除该调拨？")) return;
        state.transfers = state.transfers.filter((x) => x.id !== id);
        saveState(state);
        fullRender();
      });
    });

    els.adjustTbody.innerHTML = "";
    [...state.adjustments]
      .sort((a, b) => -cmpDate(a.date, b.date))
      .forEach((a) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td data-label="日期">${a.date}</td>
          <td data-label="仓库">${whName(state, a.warehouseId)}</td>
          <td data-label="商品">${a.product}</td>
          <td data-label="调整数量">${num(a.qty).toFixed(2)}</td>
          <td data-label="原因">${a.reason || ""}</td>
          <td data-label="操作"><button type="button" class="btn-danger" data-del-a="${a.id}">删除</button></td>`;
        els.adjustTbody.appendChild(tr);
      });
    els.adjustTbody.querySelectorAll("[data-del-a]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-del-a");
        if (!confirm("确定删除该调整？")) return;
        state.adjustments = state.adjustments.filter((x) => x.id !== id);
        saveState(state);
        fullRender();
      });
    });

    els.warehouseTbody.innerHTML = "";
    state.warehouses.forEach((w) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td data-label="仓库名">${w.name}</td>
        <td data-label="重命名"><input type="text" data-wh-rename="${w.id}" placeholder="新名称" style="max-width:140px" /></td>
        <td data-label="操作">
          <button type="button" class="btn-secondary" data-wh-apply="${w.id}">保存名称</button>
          <button type="button" class="btn-danger" data-wh-del="${w.id}">删除</button>
        </td>`;
      els.warehouseTbody.appendChild(tr);
    });
    els.warehouseTbody.querySelectorAll("[data-wh-apply]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-wh-apply");
        const inp = els.warehouseTbody.querySelector('[data-wh-rename="' + id + '"]');
        const name = String(inp.value || "").trim();
        if (!name) return alert("名称不能为空");
        state.warehouses = state.warehouses.map((x) => (x.id === id ? { ...x, name } : x));
        saveState(state);
        fullRender();
      });
    });
    els.warehouseTbody.querySelectorAll("[data-wh-del]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-wh-del");
        if (state.warehouses.length <= 1) return alert("至少保留一个仓库");
        const used =
          state.purchases.some((x) => x.warehouseId === id) ||
          state.sales.some((x) => x.warehouseId === id) ||
          state.adjustments.some((x) => x.warehouseId === id) ||
          state.transfers.some((x) => x.fromWarehouseId === id || x.toWarehouseId === id);
        if (used) return alert("该仓库仍有单据引用，无法删除。可先调拨清空再删。");
        if (!confirm("确定删除该仓库？")) return;
        state.warehouses = state.warehouses.filter((x) => x.id !== id);
        saveState(state);
        fullRender();
      });
    });

    els.categoryTbody.innerHTML = "";
    state.categories.forEach((c) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td data-label="分类名">${c.name}</td>
        <td data-label="重命名"><input type="text" data-cat-rename="${c.id}" placeholder="新名称" style="max-width:140px" /></td>
        <td data-label="操作">
          <button type="button" class="btn-secondary" data-cat-apply="${c.id}">保存名称</button>
          <button type="button" class="btn-danger" data-cat-del="${c.id}">删除</button>
        </td>`;
      els.categoryTbody.appendChild(tr);
    });
    els.categoryTbody.querySelectorAll("[data-cat-apply]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-cat-apply");
        const inp = els.categoryTbody.querySelector('[data-cat-rename="' + id + '"]');
        const name = String(inp.value || "").trim();
        if (!name) return alert("名称不能为空");
        state.categories = state.categories.map((x) => (x.id === id ? { ...x, name } : x));
        saveState(state);
        fullRender();
      });
    });
    els.categoryTbody.querySelectorAll("[data-cat-del]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-cat-del");
        if (state.categories.length <= 1) return alert("至少保留一个分类");
        const def = state.categories.find((x) => x.id !== id).id;
        const used = state.purchases.some((x) => x.categoryId === id) || state.sales.some((x) => x.categoryId === id);
        if (
          !confirm(
            used
              ? "该分类仍在单据中使用，删除将把相关单据分类改为其他分类，确定？"
              : "确定删除该分类？"
          )
        )
          return;
        state.purchases = state.purchases.map((p) => (p.categoryId === id ? { ...p, categoryId: def } : p));
        state.sales = state.sales.map((s) => (s.categoryId === id ? { ...s, categoryId: def } : s));
        state.categories = state.categories.filter((x) => x.id !== id);
        saveState(state);
        fullRender();
      });
    });
  }

  function renderAnalytics() {
    syncAllComputed(state);
    const start = els.fStart.value || "";
    const end = els.fEnd.value || "";
    const wh = els.fWarehouse.value || "";
    const cat = els.fCategory.value || "";
    const { purchases: fp, sales: fs } = filterRows(state, start, end, wh, cat);

    const revenue = fs.reduce((a, s) => a + num(s.amount), 0);
    const cogs = fs.reduce((a, s) => a + num(s.costAtSale), 0);
    const profit = revenue - cogs;
    const margin = revenue > 0 ? (100 * profit) / revenue : 0;
    els.sumRevenue.textContent = money(revenue);
    els.sumCogs.textContent = money(cogs);
    els.sumProfit.textContent = money(profit);
    els.sumMargin.textContent = margin.toFixed(2) + "%";

    const groupMode = els.fGroup.value || "day";
    const map = new Map();
    function keyFor(date) {
      if (groupMode === "week") return weekKey(date);
      if (groupMode === "month") return monthKey(date);
      return date;
    }
    fs.forEach((s) => {
      const k = keyFor(s.date);
      const o = map.get(k) || { revenue: 0, cogs: 0 };
      o.revenue += num(s.amount);
      o.cogs += num(s.costAtSale);
      map.set(k, o);
    });
    fp.forEach((p) => {
      const k = keyFor(p.date);
      const o = map.get(k) || { revenue: 0, cogs: 0, expense: 0 };
      o.expense = (o.expense || 0) + num(p.qty) * num(p.price);
      map.set(k, o);
    });

    const keys = Array.from(map.keys()).sort();
    els.profitGroupTbody.innerHTML = "";
    keys.forEach((k) => {
      const o = map.get(k);
      const rev = num(o.revenue);
      const cg = num(o.cogs);
      const prof = rev - cg;
      const mar = rev > 0 ? (100 * prof) / rev : 0;
      const tr = document.createElement("tr");
      tr.innerHTML = `<td data-label="周期">${k}</td><td data-label="销售额">${money(rev)}</td><td data-label="销售成本">${money(
        cg
      )}</td><td data-label="利润">${money(prof)}</td><td data-label="利润率">${mar.toFixed(2)}%</td>`;
      els.profitGroupTbody.appendChild(tr);
    });

    const byDay = new Map();
    fs.forEach((s) => {
      const o = byDay.get(s.date) || { revenue: 0, cogs: 0 };
      o.revenue += num(s.amount);
      o.cogs += num(s.costAtSale);
      byDay.set(s.date, o);
    });
    fp.forEach((p) => {
      const o = byDay.get(p.date) || { revenue: 0, cogs: 0, expense: 0 };
      o.expense = (o.expense || 0) + num(p.qty) * num(p.price);
      byDay.set(p.date, o);
    });
    const dayKeys = Array.from(byDay.keys()).sort();
    const revA = dayKeys.map((d) => num(byDay.get(d).revenue));
    const expA = dayKeys.map((d) => num(byDay.get(d).expense || 0));
    const profA = dayKeys.map((d) => num(byDay.get(d).revenue) - num(byDay.get(d).cogs));
    drawTrendChart(els.trendChart, dayKeys, revA, expA, profA);

    const prodMap = new Map();
    fs.forEach((s) => {
      const k = productKey(s.product) + "@@@" + s.categoryId;
      const o = prodMap.get(k) || { product: s.product, categoryId: s.categoryId, qtySold: 0, revenue: 0, cogs: 0 };
      o.qtySold += num(s.qty);
      o.revenue += num(s.amount);
      o.cogs += num(s.costAtSale);
      prodMap.set(k, o);
    });
    fp.forEach((p) => {
      const k = productKey(p.product) + "@@@" + p.categoryId;
      const o = prodMap.get(k) || { product: p.product, categoryId: p.categoryId, qtyIn: 0, qtySold: 0, revenue: 0, cogs: 0 };
      o.qtyIn = (o.qtyIn || 0) + num(p.qty);
      prodMap.set(k, o);
    });
    els.productStatsTbody.innerHTML = "";
    Array.from(prodMap.values())
      .sort((a, b) => b.revenue - a.revenue)
      .forEach((o) => {
        const prof = o.revenue - o.cogs;
        const mar = o.revenue > 0 ? (100 * prof) / o.revenue : 0;
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td data-label="商品">${o.product}</td>
          <td data-label="分类">${catName(state, o.categoryId)}</td>
          <td data-label="进货量">${(o.qtyIn || 0).toFixed(2)}</td>
          <td data-label="销售量">${num(o.qtySold).toFixed(2)}</td>
          <td data-label="销售额">${money(o.revenue)}</td>
          <td data-label="销售成本">${money(o.cogs)}</td>
          <td data-label="利润">${money(prof)}</td>
          <td data-label="利润率">${mar.toFixed(2)}%</td>`;
        els.productStatsTbody.appendChild(tr);
      });

    const catMap = new Map();
    fs.forEach((s) => {
      const o = catMap.get(s.categoryId) || { revenue: 0, cogs: 0 };
      o.revenue += num(s.amount);
      o.cogs += num(s.costAtSale);
      catMap.set(s.categoryId, o);
    });
    const totalProf = Array.from(catMap.values()).reduce((a, x) => a + (x.revenue - x.cogs), 0) || 1;
    els.categoryStatsTbody.innerHTML = "";
    Array.from(catMap.entries())
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .forEach(([cid, o]) => {
        const prof = o.revenue - o.cogs;
        const share = (100 * prof) / totalProf;
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td data-label="品类">${catName(state, cid)}</td>
          <td data-label="销售额">${money(o.revenue)}</td>
          <td data-label="销售成本">${money(o.cogs)}</td>
          <td data-label="利润">${money(prof)}</td>
          <td data-label="利润贡献占比">${share.toFixed(1)}%</td>`;
        els.categoryStatsTbody.appendChild(tr);
      });
  }

  function fullRender() {
    refreshSelectors();
    renderPurchases();
    renderSales();
    renderReceivables();
    renderInventory();
    if (document.getElementById("tab-analytics").classList.contains("active")) renderAnalytics();
  }

  els.pDate.value = todayISO();
  els.sDate.value = todayISO();
  els.rcDate.value = todayISO();
  els.aDate.value = todayISO();
  els.tDate.value = todayISO();

  els.purchaseForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const row = {
      id: uid(),
      date: els.pDate.value,
      supplier: els.pSupplier.value.trim(),
      product: els.pProduct.value.trim(),
      categoryId: els.pCategory.value,
      warehouseId: els.pWarehouse.value,
      qty: num(els.pQty.value),
      price: num(els.pPrice.value),
    };
    if (!row.product) return alert("请填写商品名称");
    state.purchases.push(row);
    saveState(state);
    els.pSupplier.value = "";
    els.pProduct.value = "";
    els.pQty.value = "";
    els.pPrice.value = "";
    fullRender();
  });

  els.salesForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const paymentType = els.sPaymentType.value === "credit" ? "credit" : "cash";
    const customerName = els.sCustomer.value.trim();
    const paidNow = num(els.sPaidNow.value);
    const qty = num(els.sQty.value);
    const price = num(els.sPrice.value);
    const amount = +(qty * price).toFixed(2);
    if (paymentType === "credit" && !customerName) return alert("赊账必须填写客户");
    if (paymentType === "cash" && paidNow > 0 && paidNow + 0.001 < amount)
      return alert("现款销售若填写「本次收款」应为全额或留空");
    let paidAtSale = 0;
    if (paymentType === "cash") paidAtSale = amount;
    else paidAtSale = Math.min(amount, Math.max(0, paidNow));

    const wh = els.sWarehouse.value;
    const prod = els.sProduct.value.trim();
    const avail = stockAvailable(wh, prod);
    if (qty > avail + 1e-6) return alert("库存不足（当前仓可用 " + avail.toFixed(2) + "）");

    const row = {
      id: uid(),
      date: els.sDate.value,
      product: prod,
      categoryId: els.sCategory.value,
      warehouseId: wh,
      qty,
      price,
      amount,
      buyer: els.sBuyer.value.trim(),
      paymentType,
      customerName,
      paidAtSale,
      arReceiptAllocated: 0,
    };
    state.sales.push(row);
    saveState(state);
    els.sProduct.value = "";
    els.sQty.value = "";
    els.sPrice.value = "";
    els.sPaidNow.value = "0";
    els.sCustomer.value = "";
    els.sBuyer.value = "";
    fullRender();
  });

  els.receiptForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const row = {
      id: uid(),
      date: els.rcDate.value,
      customerName: els.rcCustomer.value.trim(),
      amount: num(els.rcAmount.value),
      note: els.rcNote.value.trim(),
    };
    if (!row.customerName) return alert("请填写客户");
    if (row.amount <= 0) return alert("金额须大于 0");
    state.receipts.push(row);
    saveState(state);
    els.rcAmount.value = "";
    els.rcNote.value = "";
    fullRender();
  });

  els.adjustForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const row = {
      id: uid(),
      date: els.aDate.value,
      warehouseId: els.aWarehouse.value,
      product: els.aProduct.value.trim(),
      qty: num(els.aQty.value),
      reason: els.aReason.value.trim(),
    };
    if (!row.product) return alert("请填写商品");
    if (!row.reason) return alert("请填写原因");
    state.adjustments.push(row);
    saveState(state);
    els.aProduct.value = "";
    els.aQty.value = "";
    els.aReason.value = "";
    fullRender();
  });

  els.transferForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const from = els.tFrom.value;
    const to = els.tTo.value;
    if (from === to) return alert("源仓与目标仓不能相同");
    const qty = num(els.tQty.value);
    const prod = els.tProduct.value.trim();
    if (!prod) return alert("请填写商品");
    const avail = stockAvailable(from, prod);
    if (qty > avail + 1e-6) return alert("源仓库存不足（可用 " + avail.toFixed(2) + "）");
    state.transfers.push({
      id: uid(),
      date: els.tDate.value,
      product: prod,
      qty,
      fromWarehouseId: from,
      toWarehouseId: to,
      note: els.tNote.value.trim(),
    });
    saveState(state);
    els.tProduct.value = "";
    els.tQty.value = "";
    els.tNote.value = "";
    fullRender();
  });

  els.warehouseForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = els.newWarehouse.value.trim();
    if (!name) return;
    state.warehouses.push({ id: uid(), name });
    saveState(state);
    els.newWarehouse.value = "";
    fullRender();
  });

  els.categoryForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = els.newCategory.value.trim();
    if (!name) return;
    state.categories.push({ id: uid(), name });
    saveState(state);
    els.newCategory.value = "";
    fullRender();
  });

  els.purchaseSearch.addEventListener("input", renderPurchases);
  els.purchaseCategoryFilter.addEventListener("change", renderPurchases);
  els.salesSearch.addEventListener("input", renderSales);
  els.salesCategoryFilter.addEventListener("change", renderSales);
  els.invWarehouseFilter.addEventListener("change", renderInventory);

  els.filterForm.addEventListener("submit", (e) => {
    e.preventDefault();
    renderAnalytics();
  });
  els.resetFilterBtn.addEventListener("click", () => {
    els.fStart.value = "";
    els.fEnd.value = "";
    els.fWarehouse.value = "";
    els.fCategory.value = "";
    els.fGroup.value = "day";
    renderAnalytics();
  });

  els.exportMonthBtn.addEventListener("click", () => {
    const y = new Date().getFullYear();
    const m = String(new Date().getMonth() + 1).padStart(2, "0");
    const start = y + "-" + m + "-01";
    const end = y + "-" + m + "-31";
    const rows = [];
    state.purchases
      .filter((p) => p.date >= start && p.date <= end)
      .forEach((p) =>
        rows.push(["进货", p.date, whName(state, p.warehouseId), p.supplier, p.product, catName(state, p.categoryId), p.qty, p.price])
      );
    state.sales
      .filter((s) => s.date >= start && s.date <= end)
      .forEach((s) =>
        rows.push(["销售", s.date, whName(state, s.warehouseId), s.buyer, s.product, catName(state, s.categoryId), s.qty, s.price])
      );
    const esc = (x) => '"' + String(x == null ? "" : x).replace(/"/g, '""') + '"';
    const csv = ["类型,日期,仓库/买方,对方,商品,分类,数量,单价"]
      .concat(rows.map((r) => r.map(esc).join(",")))
      .join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "玲鑫当月导出_" + y + m + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  els.backupExportBtn.addEventListener("click", () => exportBackup(state));
  els.backupImportBtn.addEventListener("click", () => els.backupFileInput.click());
  els.backupFileInput.addEventListener("change", () => {
    const f = els.backupFileInput.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        state = importBackup(String(r.result));
        fullRender();
        alert("导入成功");
      } catch (err) {
        alert("导入失败：" + (err && err.message ? err.message : String(err)));
      }
      els.backupFileInput.value = "";
    };
    r.readAsText(f, "utf-8");
  });

  window.addEventListener("resize", () => {
    if (document.getElementById("tab-analytics").classList.contains("active")) renderAnalytics();
  });

  els.sPaymentType.addEventListener("change", () => {
    const cr = els.sPaymentType.value === "credit";
    els.sCustomer.required = cr;
    els.sPaidNow.parentElement.style.opacity = cr ? "1" : "0.6";
  });
  els.sPaymentType.dispatchEvent(new Event("change"));

  fullRender();
  maybeBackupReminder();
})();
