(function () {
  "use strict";

  const STORAGE_KEY = "hardware_ims_v5";
  const LEGACY_STORAGE_KEYS = ["hardware_ims_v4", "hardware_ims_v3"];
  const BACKUP_FILE_VERSION = 2;
  const REMINDER_DAYS = 7;
  const REMINDER_KEY = "hardware_ims_backup_reminder_v1";
  const CLOUD_SYNC_KEY = "hardware_ims_cloud_sync_v1";

  const ICO_EDIT =
    '<svg class="h-4 w-4 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" /></svg>';
  const ICO_TRASH =
    '<svg class="h-4 w-4 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>';

  function lxIconEdit(attrs) {
    return `<button type="button" class="lx-icon-btn" title="编辑" ${attrs}>${ICO_EDIT}</button>`;
  }
  function lxIconDel(attrs) {
    return `<button type="button" class="lx-icon-btn-danger" title="删除" ${attrs}>${ICO_TRASH}</button>`;
  }

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
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 400);
      throw new Error("云端下载失败：" + res.status + (detail ? "\n" + detail : ""));
    }
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
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 400);
      throw new Error("云端上传失败：" + res.status + (detail ? "\n" + detail : ""));
    }
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
    if (!overlay) {
      alert("页面缺少弹窗容器 modalOverlay。请把最新 index.html 上传到网站后刷新。");
      return;
    }
    overlay.innerHTML = `
      <div class="lx-modal-shell flex max-h-[90vh] w-full max-w-lg flex-col rounded-3xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900" role="dialog" aria-modal="true">
        <div class="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
          <div class="text-lg font-bold text-slate-900 dark:text-white">${escapeHtml(title)}</div>
          <button type="button" class="rounded-lg px-3 py-1.5 text-sm text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200" data-modal-close>关闭</button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">${bodyHtml}</div>
        <div class="flex shrink-0 justify-end gap-3 border-t border-slate-100 px-5 py-4 dark:border-slate-800">
          <button type="button" class="lx-btn-outline px-4" data-modal-cancel>取消</button>
          <button type="button" class="lx-btn-primary min-w-[5rem]" data-modal-save>保存</button>
        </div>
      </div>
    `;
    overlay.classList.add("show");
    overlay.setAttribute("aria-hidden", "false");
    // 内联样式：避免线上 CSS 仍是旧版/被缓存时弹窗 display 仍为 none，看起来像“点了没反应”
    overlay.style.display = "flex";
    overlay.style.alignItems = "flex-end";
    overlay.style.justifyContent = "center";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.zIndex = "9999";
    overlay.style.background = "rgba(15, 23, 42, 0.55)";
    overlay.style.padding = "14px";

    const modalEl = overlay.querySelector(".lx-modal-shell");
    if (modalEl) {
      modalEl.addEventListener("click", (e) => e.stopPropagation());
    }

    function close() {
      overlay.classList.remove("show");
      overlay.setAttribute("aria-hidden", "true");
      overlay.innerHTML = "";
      overlay.style.cssText = "";
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

  /** 多工作表 Excel：依赖页面引入的 SheetJS（window.XLSX） */
  function exportAllBusinessDataExcel(state) {
    const XLSX = typeof window !== "undefined" ? window.XLSX : undefined;
    if (!XLSX || !XLSX.utils || !XLSX.writeFile) {
      alert("Excel 组件未加载，请确认网络正常后刷新页面再试。");
      return;
    }
    syncAllComputed(state);
    const wb = XLSX.utils.book_new();

    function appendSheet(sheetName, rows) {
      const name = String(sheetName).slice(0, 31);
      let ws;
      if (!rows || !rows.length) ws = XLSX.utils.aoa_to_sheet([["（暂无数据）"]]);
      else ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, name);
    }

    appendSheet(
      "仓库",
      state.warehouses.map((w) => ({ 记录ID: w.id, 名称: w.name }))
    );
    appendSheet(
      "分类",
      state.categories.map((c) => ({ 记录ID: c.id, 名称: c.name }))
    );
    appendSheet(
      "进货",
      [...state.purchases]
        .sort((a, b) => cmpDate(a.date, b.date))
        .map((p) => ({
          日期: p.date,
          仓库: whName(state, p.warehouseId),
          供应商: p.supplier || "",
          商品: p.product || "",
          分类: catName(state, p.categoryId),
          数量: num(p.qty),
          单价: num(p.price),
          小计: +(num(p.qty) * num(p.price)).toFixed(2),
          记录ID: p.id,
        }))
    );
    appendSheet(
      "销售",
      [...state.sales]
        .sort((a, b) => cmpDate(a.date, b.date))
        .map((s) => {
          const rem = creditRemaining(s);
          const pay = s.paymentType === "credit" ? "赊账" : "现款";
          return {
            日期: s.date,
            仓库: whName(state, s.warehouseId),
            商品: s.product || "",
            分类: catName(state, s.categoryId),
            付款方式: pay,
            客户: s.customerName || "",
            数量: num(s.qty),
            售价: num(s.price),
            销售成本: num(s.costAtSale),
            小计: num(s.amount),
            当场已收: Math.min(num(s.amount), Math.max(0, num(s.paidAtSale))),
            赊欠余额: rem > 0.0001 ? +rem.toFixed(2) : 0,
            收款核销: num(s.arReceiptAllocated),
            手动结清: num(s.arManualPaid),
            买方: s.buyer || "",
            记录ID: s.id,
          };
        })
    );
    appendSheet(
      "收款",
      [...state.receipts]
        .sort((a, b) => cmpDate(a.date, b.date))
        .map((r) => ({
          日期: r.date,
          客户: r.customerName || "",
          金额: num(r.amount),
          备注: r.note || "",
          记录ID: r.id,
        }))
    );
    appendSheet(
      "调拨",
      [...state.transfers]
        .sort((a, b) => cmpDate(a.date, b.date))
        .map((t) => ({
          日期: t.date,
          商品: t.product || "",
          数量: num(t.qty),
          从仓库: whName(state, t.fromWarehouseId),
          到仓库: whName(state, t.toWarehouseId),
          备注: t.note || "",
          记录ID: t.id,
        }))
    );
    appendSheet(
      "库存调整",
      [...state.adjustments]
        .sort((a, b) => cmpDate(a.date, b.date))
        .map((a) => ({
          日期: a.date,
          仓库: whName(state, a.warehouseId),
          商品: a.product || "",
          数量: num(a.qty),
          原因: a.reason || "",
          记录ID: a.id,
        }))
    );
    appendSheet("系统设置", [
      {
        导出时间: new Date().toISOString(),
        备份提醒开启: state.settings && state.settings.backupReminderEnabled ? "是" : "否",
        上次备份提示: (state.settings && state.settings.lastBackupPromptAt) || "",
      },
    ]);

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    XLSX.writeFile(wb, "玲鑫进销存_全部数据_" + stamp + ".xlsx");
  }

  /** -------- Chart (minimal canvas) -------- */
  function drawTrendChart(canvas, labels, revenue, expense, profit) {
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    let cssW = rect.width || canvas.clientWidth;
    let cssH = rect.height || canvas.clientHeight;
    if (!cssW || cssW < 40) cssW = Math.min(560, Math.max(280, window.innerWidth - 40));
    if (!cssH || cssH < 40) cssH = 150;
    const w = (canvas.width = Math.floor(cssW * dpr));
    const h = (canvas.height = Math.floor(cssH * dpr));
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
    backupExportBtn: document.getElementById("backupExportBtn"),
    backupImportBtn: document.getElementById("backupImportBtn"),
    exportAllExcelBtn: document.getElementById("exportAllExcelBtn"),
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
    arSearchFilter: document.getElementById("arSearchFilter"),
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
    bsStart: document.getElementById("bsStart"),
    bsEnd: document.getElementById("bsEnd"),
    bestsellerForm: document.getElementById("bestsellerForm"),
    bestsellerProductTbody: document.getElementById("bestsellerProductTbody"),
    bestsellerCategoryTbody: document.getElementById("bestsellerCategoryTbody"),
  };

  function setTheme(dark) {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    localStorage.setItem("hardware_ims_theme", dark ? "dark" : "light");
  }
  setTheme(localStorage.getItem("hardware_ims_theme") === "dark");

  if (els.themeBtn) {
    els.themeBtn.addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") === "dark";
      setTheme(!cur);
    });
  }

  // 云同步：用 document 委托，避免按钮在 DOM 中但引用未绑到等情况
  document.addEventListener(
    "click",
    (e) => {
      const trigger = e.target && e.target.closest && e.target.closest("#cloudSyncBtn");
      if (!trigger) return;
      try {
        const cfg = loadCloudConfig() || {};
        const body = `
        <form class="form-grid" onsubmit="return false;">
          <div class="form-group" style="grid-column:span 2"><label>Supabase URL</label><input id="m_url" placeholder="https://xxxx.supabase.co" value="${escapeHtml(cfg.url || "")}"></div>
          <div class="form-group" style="grid-column:span 2"><label>Supabase anon key</label><input id="m_key" placeholder="ey..." value="${escapeHtml(cfg.anonKey || "")}"></div>
          <div class="form-group"><label>Bucket(默认)</label><input id="m_bucket" value="${escapeHtml(cfg.bucket || "lingxin-ims")}"></div>
          <div class="form-group"><label>同步码(建议手机号)</label><input id="m_code" placeholder="例如：13800138000" value="${escapeHtml(cfg.code || "")}"></div>
          <div class="form-group" style="grid-column:span 2"><label>说明</label><input value="同一个同步码=同一套数据，多设备共用" disabled></div>
          <div class="form-group"><button type="button" class="lx-btn-secondary" id="m_pull">从云端下载覆盖本机</button></div>
          <div class="form-group"><button type="button" class="lx-btn-secondary" id="m_push">上传本机到云端</button></div>
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
          alert("已保存云同步配置。请在本弹窗内点击「上传本机到云端」或「从云端下载覆盖本机」。（仅点保存不会上传数据）");
          return false;
        });

        const pullBtn = document.getElementById("m_pull");
        const pushBtn = document.getElementById("m_push");
        if (pullBtn)
          pullBtn.addEventListener("click", async () => {
            try {
              const current = loadCloudConfig() || {};
              const url = document.getElementById("m_url")?.value?.trim() || current.url;
              const anonKey = document.getElementById("m_key")?.value?.trim() || current.anonKey;
              const bucket = document.getElementById("m_bucket")?.value?.trim() || current.bucket || "lingxin-ims";
              const code = document.getElementById("m_code")?.value?.trim() || current.code;
              const objectPath = `sync/${encodeURIComponent(code)}.json`;
              const cfg2 = { url, anonKey, bucket, code, objectPath };
              saveCloudConfig(cfg2);
              const pulled = await cloudPull(cfg2);
              if (!pulled) return alert("云端暂无数据（请先在另一台设备点「上传本机到云端」）");
              state = pulled;
              saveState(state);
              fullRender();
              alert("已从云端下载并覆盖本机");
            } catch (err) {
              alert(err && err.message ? err.message : String(err));
            }
          });
        if (pushBtn)
          pushBtn.addEventListener("click", async () => {
            try {
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
            } catch (err) {
              alert(err && err.message ? err.message : String(err));
            }
          });
      } catch (err) {
        alert("打开云同步失败：" + (err && err.message ? err.message : String(err)));
      }
    },
    false,
  );

  els.tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      els.tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
      els.panels.forEach((p) => {
        const on = p.id === "tab-" + tab;
        p.classList.toggle("hidden", !on);
        p.classList.toggle("block", on);
      });
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
        <td data-label="单价" class="lx-money">${money(p.price)}</td>
        <td data-label="小计" class="lx-money">${money(sub)}</td>
        <td data-label="操作" class="text-right">
          <div class="flex flex-wrap justify-end gap-1.5">${lxIconEdit(`data-edit-p="${p.id}"`)}${lxIconDel(`data-del-p="${p.id}"`)}</div>
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
        <td data-label="售价" class="lx-money">${money(s.price)}</td>
        <td data-label="成本" class="lx-money">${money(s.costAtSale)}</td>
        <td data-label="小计" class="lx-money">${money(s.amount)}</td>
        <td data-label="已收" class="lx-money">${money(Math.min(num(s.amount), Math.max(0, num(s.paidAtSale))))}</td>
        <td data-label="欠款">${rem > 0.0001 ? `<span class="lx-money">${money(rem)}</span>` : "—"}</td>
        <td data-label="买方">${s.buyer || ""}</td>
        <td data-label="操作" class="text-right">
          <div class="flex flex-wrap justify-end gap-1.5">${lxIconEdit(`data-edit-s="${s.id}"`)}${lxIconDel(`data-del-s="${s.id}"`)}</div>
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
    const arQ = (els.arSearchFilter && els.arSearchFilter.value.trim()) || "";
    const arQL = arQ.toLowerCase();

    function arTextMatch(hay, needle) {
      if (!needle) return true;
      return String(hay || "").toLowerCase().includes(needle);
    }

    function saleCustLabel(s) {
      return String(s.customerName || "").trim() || "（未填写客户）";
    }

    function saleMatchesSearch(s) {
      if (!arQL) return true;
      return arTextMatch(saleCustLabel(s), arQL) || arTextMatch(s.product, arQL);
    }

    function summaryCustomerVisible(name) {
      if (!arQL) return true;
      if (arTextMatch(name, arQL)) return true;
      return state.sales.some((s) => {
        if (creditRemaining(s) <= 0.001) return false;
        if (saleCustLabel(s) !== name) return false;
        return arTextMatch(s.product, arQL);
      });
    }

    const balances = arCustomerBalances(state);
    els.arSummaryTbody.innerHTML = "";
    Array.from(balances.entries())
      .filter(([name]) => summaryCustomerVisible(name))
      .sort((a, b) => b[1] - a[1])
      .forEach(([name, bal]) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td data-label="客户">${name}</td><td data-label="应收余额" class="lx-money">${money(bal)}</td>`;
        els.arSummaryTbody.appendChild(tr);
      });
    if (!els.arSummaryTbody.children.length) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        balances.size === 0
          ? `<td colspan="2" class="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">暂无欠款客户</td>`
          : `<td colspan="2" class="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">${arQL ? "无匹配记录（试试别的关键词）" : "暂无欠款客户"}</td>`;
      els.arSummaryTbody.appendChild(tr);
    }

    els.arCreditTbody.innerHTML = "";
    const unpaidRows = state.sales
      .filter((s) => creditRemaining(s) > 0.001 && saleMatchesSearch(s))
      .sort((a, b) => cmpDate(a.date, b.date));
    unpaidRows.forEach((s) => {
      const tr = document.createElement("tr");
      const rem = creditRemaining(s);
      tr.innerHTML = `
        <td data-label="日期">${s.date}</td>
        <td data-label="客户">${String(s.customerName || "").trim() || "（未填写客户）"}</td>
        <td data-label="商品">${s.product || ""}</td>
        <td data-label="小计" class="lx-money">${money(s.amount)}</td>
        <td data-label="当场已收" class="lx-money">${money(s.paidAtSale)}</td>
        <td data-label="收款核销" class="lx-money">${money(s.arReceiptAllocated)}</td>
        <td data-label="剩余欠款" class="lx-money">${money(rem)}</td>
        <td data-label="已收款"><input type="checkbox" class="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600" data-ar-paid="${s.id}" /></td>`;
      els.arCreditTbody.appendChild(tr);
    });
    if (!els.arCreditTbody.children.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="8" class="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">${arQL ? "无匹配记录" : "暂无未结清欠款"}</td>`;
      els.arCreditTbody.appendChild(tr);
    }

    const paidTbody = document.getElementById("arPaidTbody");
    if (paidTbody) {
      paidTbody.innerHTML = "";
      const paidRows = state.sales
        .filter(
          (s) =>
            creditRemaining(s) <= 0.001 &&
            (num(s.arReceiptAllocated) > 0 || num(s.arManualPaid) > 0 || num(s.paidAtSale) < num(s.amount)) &&
            saleMatchesSearch(s)
        )
        .sort((a, b) => -cmpDate(a.date, b.date));
      paidRows.forEach((s) => {
        const tr = document.createElement("tr");
        const manual = Math.max(0, num(s.arManualPaid));
        const paidTotal = Math.min(num(s.amount), Math.max(0, num(s.paidAtSale)) + Math.max(0, num(s.arReceiptAllocated)) + manual);
        tr.innerHTML = `
          <td data-label="日期">${s.date}</td>
          <td data-label="客户">${String(s.customerName || "").trim() || "（未填写客户）"}</td>
          <td data-label="商品">${s.product || ""}</td>
          <td data-label="小计" class="lx-money">${money(s.amount)}</td>
          <td data-label="当场已收" class="lx-money">${money(s.paidAtSale)}</td>
          <td data-label="收款核销" class="lx-money">${money(s.arReceiptAllocated)}</td>
          <td data-label="手动结清" class="lx-money">${money(manual)}</td>
          <td data-label="已收合计" class="lx-money">${money(paidTotal)}</td>`;
        paidTbody.appendChild(tr);
      });
      if (!paidTbody.children.length) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="8" class="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">${arQL ? "无匹配记录" : "暂无已结清记录"}</td>`;
        paidTbody.appendChild(tr);
      }
    }

    els.receiptTbody.innerHTML = "";
    const receiptMatches = (r) => {
      if (!arQL) return true;
      return arTextMatch(r.customerName, arQL) || arTextMatch(r.note, arQL);
    };
    [...state.receipts]
      .filter(receiptMatches)
      .sort((a, b) => -cmpDate(a.date, b.date))
      .forEach((r) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td data-label="日期">${r.date}</td>
          <td data-label="客户">${r.customerName || ""}</td>
          <td data-label="金额" class="lx-money">${money(r.amount)}</td>
          <td data-label="备注">${r.note || ""}</td>
          <td data-label="操作" class="text-right">${lxIconDel(`data-del-r="${r.id}"`)}</td>`;
        els.receiptTbody.appendChild(tr);
      });
    if (!els.receiptTbody.children.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="5" class="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">${arQL ? "无匹配记录" : "暂无收款记录"}</td>`;
      els.receiptTbody.appendChild(tr);
    }
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
        <td data-label="库存均价" class="lx-money">${money(avg)}</td>
        <td data-label="库存成本" class="lx-money">${money(c.totalCost)}</td>`;
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
          <td data-label="操作" class="text-right">${lxIconDel(`data-del-t="${t.id}"`)}</td>`;
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
          <td data-label="操作" class="text-right">${lxIconDel(`data-del-a="${a.id}"`)}</td>`;
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
        <td data-label="重命名"><input type="text" class="lx-input max-w-[200px]" data-wh-rename="${w.id}" placeholder="新名称" /></td>
        <td data-label="操作" class="text-right">
          <div class="flex flex-wrap justify-end gap-2">
            <button type="button" class="lx-btn-secondary text-xs" data-wh-apply="${w.id}">保存名称</button>
            ${lxIconDel(`data-wh-del="${w.id}"`)}
          </div>
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
        <td data-label="重命名"><input type="text" class="lx-input max-w-[200px]" data-cat-rename="${c.id}" placeholder="新名称" /></td>
        <td data-label="操作" class="text-right">
          <div class="flex flex-wrap justify-end gap-2">
            <button type="button" class="lx-btn-secondary text-xs" data-cat-apply="${c.id}">保存名称</button>
            ${lxIconDel(`data-cat-del="${c.id}"`)}
          </div>
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
      tr.innerHTML = `<td data-label="周期">${k}</td><td data-label="销售额" class="lx-money">${money(rev)}</td><td data-label="销售成本" class="lx-money">${money(
        cg
      )}</td><td data-label="利润" class="lx-money">${money(prof)}</td><td data-label="利润率">${mar.toFixed(2)}%</td>`;
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
          <td data-label="销售额" class="lx-money">${money(o.revenue)}</td>
          <td data-label="销售成本" class="lx-money">${money(o.cogs)}</td>
          <td data-label="利润" class="lx-money">${money(prof)}</td>
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
          <td data-label="销售额" class="lx-money">${money(o.revenue)}</td>
          <td data-label="销售成本" class="lx-money">${money(o.cogs)}</td>
          <td data-label="利润" class="lx-money">${money(prof)}</td>
          <td data-label="利润贡献占比">${share.toFixed(1)}%</td>`;
        els.categoryStatsTbody.appendChild(tr);
      });

    if (els.bestsellerProductTbody && els.bestsellerCategoryTbody) {
      const bsS = (els.bsStart && els.bsStart.value.trim()) || start;
      const bsE = (els.bsEnd && els.bsEnd.value.trim()) || end;
      const { sales: fsRank } = filterRows(state, bsS, bsE, wh, cat);

      const prodRank = new Map();
      fsRank.forEach((s) => {
        const k = productKey(s.product);
        if (!k) return;
        const o = prodRank.get(k) || { label: String(s.product || "").trim() || k, qty: 0, rev: 0 };
        o.qty += num(s.qty);
        o.rev += num(s.amount);
        prodRank.set(k, o);
      });
      const prodRows = Array.from(prodRank.values()).sort((a, b) => b.rev - a.rev || b.qty - a.qty);
      els.bestsellerProductTbody.innerHTML = "";
      prodRows.forEach((o, i) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td data-label="名次">${i + 1}</td><td data-label="商品">${escapeHtml(o.label)}</td><td data-label="销售数量">${o.qty.toFixed(2)}</td><td data-label="销售额" class="lx-money">${money(
          o.rev
        )}</td>`;
        els.bestsellerProductTbody.appendChild(tr);
      });

      const catRank = new Map();
      fsRank.forEach((s) => {
        const cid = s.categoryId;
        const o = catRank.get(cid) || { qty: 0, rev: 0 };
        o.qty += num(s.qty);
        o.rev += num(s.amount);
        catRank.set(cid, o);
      });
      const catRows = Array.from(catRank.entries())
        .map(([cid, o]) => ({ cid, qty: o.qty, rev: o.rev }))
        .sort((a, b) => b.rev - a.rev || b.qty - a.qty);
      els.bestsellerCategoryTbody.innerHTML = "";
      catRows.forEach((o, i) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td data-label="名次">${i + 1}</td><td data-label="分类">${escapeHtml(catName(state, o.cid))}</td><td data-label="销售数量">${o.qty.toFixed(2)}</td><td data-label="销售额" class="lx-money">${money(
          o.rev
        )}</td>`;
        els.bestsellerCategoryTbody.appendChild(tr);
      });
    }
  }

  function fullRender() {
    refreshSelectors();
    renderPurchases();
    renderSales();
    renderReceivables();
    renderInventory();
    const _ana = document.getElementById("tab-analytics");
    if (_ana && !_ana.classList.contains("hidden")) renderAnalytics();
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

  if (els.arSearchFilter) {
    els.arSearchFilter.addEventListener("input", renderReceivables);
  }

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
    if (els.bsStart) els.bsStart.value = "";
    if (els.bsEnd) els.bsEnd.value = "";
    renderAnalytics();
  });

  if (els.bestsellerForm) {
    els.bestsellerForm.addEventListener("submit", (e) => {
      e.preventDefault();
      renderAnalytics();
    });
  }

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
  if (els.exportAllExcelBtn) {
    els.exportAllExcelBtn.addEventListener("click", () => {
      try {
        exportAllBusinessDataExcel(state);
      } catch (err) {
        alert("导出失败：" + (err && err.message ? err.message : String(err)));
      }
    });
  }
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
    const _ana = document.getElementById("tab-analytics");
    if (_ana && !_ana.classList.contains("hidden")) renderAnalytics();
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
