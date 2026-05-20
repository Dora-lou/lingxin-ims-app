(function () {
  "use strict";

  const STORAGE_KEY = "hardware_ims_v5";
  const LEGACY_STORAGE_KEYS = ["hardware_ims_v4", "hardware_ims_v3"];
  const IDB_NAME = "lingxin_ims_db";
  const IDB_VERSION = 1;
  const IDB_STORE = "kv";
  const IDB_MIGRATED_FLAG = "hardware_ims_v5_idb";
  const BACKUP_FILE_VERSION = 2;
  const REMINDER_DAYS = 7;
  const REMINDER_KEY = "hardware_ims_backup_reminder_v1";
  const CLOUD_SYNC_KEY = "hardware_ims_cloud_sync_v1";
  const purchaseCheckedIds = new Set();
  const salesCheckedIds = new Set();

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

  function parseOptionalFee(raw) {
    const t = String(raw ?? "").trim();
    if (!t) return 0;
    const x = Number(t);
    return Number.isFinite(x) && x >= 0 ? x : 0;
  }

  function purchaseLineSubtotal(p) {
    return +(num(p.qty) * num(p.price) + num(p.extraFee)).toFixed(2);
  }

  function saleLineSubtotal(s) {
    return +(num(s.qty) * num(s.price) + num(s.extraFee)).toFixed(2);
  }

  function formatExtraFeeCell(fee) {
    const x = num(fee);
    return x > 0.0001 ? money(x) : "—";
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
    const unitId = uid();
    return {
      categories: [{ id: catId, name: "未分类" }],
      warehouses: [{ id: whId, name: "默认仓" }],
      units: [{ id: unitId, name: "件" }],
      productDefs: [],
      customerDefs: [],
      supplierDefs: [],
      purchases: [],
      sales: [],
      adjustments: [],
      transfers: [],
      receipts: [],
      settings: { backupReminderEnabled: true, lastBackupPromptAt: null },
      suggestions: { products: [], customers: [], suppliers: [] },
      fixedCostEntries: [],
    };
  }

  function migrateFixedCostEntriesToProjectField(s) {
    const cats = s.fixedCostCategories || [];
    (s.fixedCostEntries || []).forEach((e) => {
      if (!e) return;
      if (String(e.project || "").trim() !== "") {
        delete e.categoryId;
        return;
      }
      let proj = "";
      if (e.categoryId) {
        const c = cats.find((x) => x.id === e.categoryId);
        proj = c ? String(c.name || "").trim() : "";
      }
      e.project = proj || "固定成本";
      delete e.categoryId;
    });
  }

  function loadRawFromLocalStorage() {
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

  let idbPromise = null;

  function openIdb() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("当前浏览器不支持 IndexedDB，请改用 Chrome 或更新浏览器。"));
        return;
      }
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onerror = () => reject(req.error || new Error("无法打开 IndexedDB"));
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
    });
    return idbPromise;
  }

  function idbGet(key) {
    return openIdb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, "readonly");
          const req = tx.objectStore(IDB_STORE).get(key);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error || new Error("读取 IndexedDB 失败"));
        })
    );
  }

  function idbSet(key, value) {
    return openIdb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, "readwrite");
          const req = tx.objectStore(IDB_STORE).put(value, key);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error || new Error("写入 IndexedDB 失败"));
          tx.onerror = () => reject(tx.error || new Error("写入 IndexedDB 失败"));
        })
    );
  }

  function parseStoredState(raw) {
    if (raw == null) return null;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch (e) {
        return null;
      }
    }
    if (typeof raw === "object") return raw;
    return null;
  }

  async function loadRawAsync() {
    try {
      const fromIdb = parseStoredState(await idbGet(STORAGE_KEY));
      if (fromIdb) return fromIdb;
    } catch (e) {
      console.warn("IndexedDB 读取失败，尝试 localStorage", e);
    }
    const fromLs = loadRawFromLocalStorage();
    if (fromLs) {
      try {
        await idbSet(STORAGE_KEY, fromLs);
        try {
          localStorage.setItem(IDB_MIGRATED_FLAG, new Date().toISOString());
          localStorage.removeItem(STORAGE_KEY);
        } catch (e2) {}
      } catch (e) {
        console.warn("迁移到 IndexedDB 失败，仍使用 localStorage 数据", e);
      }
    }
    return fromLs;
  }

  async function loadAppState() {
    const raw = await loadRawAsync();
    return migrateIfNeeded(raw);
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
    if (!s.suggestions || typeof s.suggestions !== "object") s.suggestions = { products: [], customers: [], suppliers: [] };
    ["products", "customers", "suppliers"].forEach((k) => {
      if (!Array.isArray(s.suggestions[k])) s.suggestions[k] = [];
    });
    if (!Array.isArray(s.fixedCostEntries)) s.fixedCostEntries = [];
    migrateFixedCostEntriesToProjectField(s);
    delete s.fixedCostCategories;
    const defWh = s.warehouses[0].id;
    const defCat = s.categories[0].id;
    s.purchases = s.purchases.map((p) => ({
      ...p,
      warehouseId: p.warehouseId || p.warehouse || defWh,
      categoryId: p.categoryId || p.category || defCat,
      qty: num(p.qty),
      price: num(p.price),
      extraFee: num(p.extraFee),
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
      extraFee: num(x.extraFee),
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
    migrateMasterData(s);
    const defUnitId = s.units[0].id;
    s.purchases = s.purchases.map((p) => ({ ...p, unitId: p.unitId || defUnitId }));
    s.sales = s.sales.map((x) => ({ ...x, unitId: x.unitId || defUnitId }));
    s.adjustments = s.adjustments.map((a) => ({ ...a, unitId: a.unitId || defUnitId }));
    s.transfers = s.transfers.map((t) => ({ ...t, unitId: t.unitId || defUnitId }));
    return s;
  }

  function migrateMasterData(s) {
    if (!Array.isArray(s.units) || !s.units.length) s.units = [{ id: uid(), name: "件" }];
    ["productDefs", "customerDefs", "supplierDefs"].forEach((k) => {
      if (!Array.isArray(s[k])) s[k] = [];
    });
    if (!s.suggestions || typeof s.suggestions !== "object") s.suggestions = { products: [], customers: [], suppliers: [] };
    ["products", "customers", "suppliers"].forEach((k) => {
      if (!Array.isArray(s.suggestions[k])) s.suggestions[k] = [];
    });
    const mapSug = { products: "productDefs", customers: "customerDefs", suppliers: "supplierDefs" };
    Object.keys(mapSug).forEach((sk) => {
      (s.suggestions[sk] || []).forEach((n) => ensureMasterDef(s, mapSug[sk], n));
    });
    syncMastersFromTransactions(s);
    const du = defaultUnitId(s);
    (s.productDefs || []).forEach((p) => {
      if (!p.unitId || !s.units.some((u) => u.id === p.unitId)) {
        const inferred = latestUnitIdForProduct(s, p.name);
        p.unitId = inferred && s.units.some((u) => u.id === inferred) ? inferred : du;
      }
    });
  }

  function ensureMasterDef(st, defsKey, name, opts) {
    const t = String(name || "").trim();
    if (!t) return;
    const arr = st[defsKey];
    if (!Array.isArray(arr)) return;
    if (arr.some((x) => String(x.name || "").trim() === t)) return;
    if (defsKey === "productDefs") {
      const o = opts || {};
      let uId = o.unitId;
      if (!uId || !st.units.some((u) => u.id === uId)) uId = latestUnitIdForProduct(st, t) || defaultUnitId(st);
      arr.push({ id: uid(), name: t, unitId: uId });
    } else {
      arr.push({ id: uid(), name: t });
    }
  }

  function syncMastersFromTransactions(st) {
    st.purchases.forEach((p) => {
      ensureMasterDef(st, "productDefs", p.product, { unitId: p.unitId });
      ensureMasterDef(st, "supplierDefs", p.supplier);
    });
    st.sales.forEach((s) => {
      ensureMasterDef(st, "productDefs", s.product, { unitId: s.unitId });
      ensureMasterDef(st, "customerDefs", s.customerName);
    });
    st.adjustments.forEach((a) => ensureMasterDef(st, "productDefs", a.product, { unitId: a.unitId }));
    st.transfers.forEach((t) => ensureMasterDef(st, "productDefs", t.product, { unitId: t.unitId }));
    st.receipts.forEach((r) => ensureMasterDef(st, "customerDefs", r.customerName));
  }

  function defaultUnitId(st) {
    return (st.units && st.units[0] && st.units[0].id) || "";
  }

  function ensureUnitByName(st, rawName) {
    const t = String(rawName || "").trim();
    if (!t) return defaultUnitId(st);
    if (!Array.isArray(st.units)) st.units = [];
    const found = st.units.find((x) => String(x.name || "").trim() === t);
    if (found) return found.id;
    const id = uid();
    st.units.push({ id, name: t });
    return id;
  }

  function unitNameById(st, unitId) {
    const u = (st.units || []).find((x) => x.id === unitId);
    return u ? String(u.name || "").trim() : "";
  }

  function resolveUnitIdFromInput(st, raw) {
    const t = String(raw || "").trim();
    if (!t) return defaultUnitId(st);
    const byName = (st.units || []).find((u) => String(u.name || "").trim() === t);
    if (byName) return byName.id;
    const byId = (st.units || []).find((u) => u.id === t);
    if (byId) return byId.id;
    return ensureUnitByName(st, t);
  }

  function upsertProductDef(st, productName, unitId) {
    const t = String(productName || "").trim();
    if (!t) return;
    let uId = unitId;
    if (!uId || !(st.units || []).some((u) => u.id === uId)) uId = defaultUnitId(st);
    if (!Array.isArray(st.productDefs)) st.productDefs = [];
    const i = st.productDefs.findIndex((x) => String(x.name || "").trim() === t);
    if (i >= 0) st.productDefs[i] = { ...st.productDefs[i], unitId: uId };
    else st.productDefs.push({ id: uid(), name: t, unitId: uId });
  }

  function unitNamesSorted(st) {
    return (st.units || [])
      .map((u) => String(u.name || "").trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, "zh-CN"));
  }

  function defNameTaken(st, defsKey, name, exceptId) {
    const t = String(name || "").trim();
    if (!t) return false;
    const arr = st[defsKey];
    if (!Array.isArray(arr)) return false;
    return arr.some((x) => (exceptId == null || x.id !== exceptId) && String(x.name || "").trim() === t);
  }

  function productNameReferenced(st, name) {
    const t = productKey(name);
    if (!t) return false;
    return (
      st.purchases.some((p) => productKey(p.product) === t) ||
      st.sales.some((s) => productKey(s.product) === t) ||
      st.adjustments.some((a) => productKey(a.product) === t) ||
      st.transfers.some((x) => productKey(x.product) === t)
    );
  }

  function customerNameReferenced(st, name) {
    const t = String(name || "").trim();
    if (!t) return false;
    return (
      st.sales.some((s) => String(s.customerName || "").trim() === t) ||
      st.receipts.some((r) => String(r.customerName || "").trim() === t)
    );
  }

  function supplierNameReferenced(st, name) {
    const t = String(name || "").trim();
    if (!t) return false;
    return st.purchases.some((p) => String(p.supplier || "").trim() === t);
  }

  function renameProductNameEverywhere(st, oldName, newName) {
    const o = productKey(oldName);
    const n = productKey(newName);
    if (!o || !n || o === n) return;
    st.purchases.forEach((p) => {
      if (productKey(p.product) === o) p.product = n;
    });
    st.sales.forEach((s) => {
      if (productKey(s.product) === o) s.product = n;
    });
    st.adjustments.forEach((a) => {
      if (productKey(a.product) === o) a.product = n;
    });
    st.transfers.forEach((t) => {
      if (productKey(t.product) === o) t.product = n;
    });
  }

  function renameCustomerNameEverywhere(st, oldName, newName) {
    const o = String(oldName || "").trim();
    const n = String(newName || "").trim();
    if (!o || !n || o === n) return;
    st.sales.forEach((s) => {
      if (String(s.customerName || "").trim() === o) s.customerName = n;
    });
    st.receipts.forEach((r) => {
      if (String(r.customerName || "").trim() === o) r.customerName = n;
    });
  }

  function renameSupplierNameEverywhere(st, oldName, newName) {
    const o = String(oldName || "").trim();
    const n = String(newName || "").trim();
    if (!o || !n || o === n) return;
    st.purchases.forEach((p) => {
      if (String(p.supplier || "").trim() === o) p.supplier = n;
    });
  }

  function reassignUnitIdEverywhere(st, fromId, toId) {
    if (!fromId || !toId || fromId === toId) return;
    st.purchases.forEach((p) => {
      if (p.unitId === fromId) p.unitId = toId;
    });
    st.sales.forEach((s) => {
      if (s.unitId === fromId) s.unitId = toId;
    });
    st.adjustments.forEach((a) => {
      if (a.unitId === fromId) a.unitId = toId;
    });
    st.transfers.forEach((t) => {
      if (t.unitId === fromId) t.unitId = toId;
    });
    (st.productDefs || []).forEach((p) => {
      if (p.unitId === fromId) p.unitId = toId;
    });
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
        c.totalCost += q * price + num(p.extraFee);
      } else if (ev.kind === "transfer") {
        const t = ev.row;
        const q = Math.max(0, num(t.qty));
        if (!t.fromWarehouseId || !t.toWarehouseId || t.fromWarehouseId === t.toWarehouseId || q <= 0) continue;
        const kf = cellKey(t.fromWarehouseId, t.product);
        const kt = cellKey(t.toWarehouseId, t.product);
        const cf = getCell(inv, kf);
        const ct = getCell(inv, kt);
        const av = avgUnit(cf);
        const costMove = q * av;
        cf.qty -= q;
        cf.totalCost -= costMove;
        ct.qty += q;
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
        const av = avgUnit(c);
        const cost = need * av;
        c.qty -= need;
        c.totalCost -= cost;
        saleCogs.set(s.id, cost);
      }
    }
    return { inv, saleCogs };
  }

  function recomputeSaleCosts(state) {
    const { saleCogs } = buildLedger(state);
    state.sales.forEach((s) => {
      s.amount = saleLineSubtotal(s);
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
      const rk = arCustomerNormKey(cust);
      for (const s of arSales) {
        if (left <= 0) break;
        if (saleCustMatchKey(s) !== rk) continue;
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

  function isStorageQuotaError(err) {
    if (!err) return false;
    if (err.name === "QuotaExceededError") return true;
    if (err.code === 22 || err.code === 1014) return true;
    const msg = String(err.message || err);
    return /quota|exceeded|storage full|磁盘|空间不足/i.test(msg);
  }

  let persistChain = Promise.resolve();
  let pendingPersistState = null;
  let persistFlushTimer = null;

  function storageQuotaMessage(byteLen) {
    const mb = (byteLen / (1024 * 1024)).toFixed(2);
    return (
      "本机存储空间不足（约 " +
      mb +
      " MB），数据未能保存。\n\n建议：导出 JSON 备份后删除部分旧单据；手机请用 Chrome 打开同一网址。数据已改用 IndexedDB，容量通常远大于原来的 localStorage。"
    );
  }

  function flushStateToIdb() {
    if (!pendingPersistState) return persistChain;
    const st = pendingPersistState;
    pendingPersistState = null;
    const json = JSON.stringify(st);
    persistChain = persistChain
      .then(() => idbSet(STORAGE_KEY, st))
      .catch((err) => {
        if (isStorageQuotaError(err)) throw new Error(storageQuotaMessage(json.length));
        throw err;
      })
      .catch((err) => {
        alert(err && err.message ? err.message : String(err));
        throw err;
      });
    return persistChain;
  }

  function saveState(st) {
    syncAllComputed(st);
    pendingPersistState = st;
    clearTimeout(persistFlushTimer);
    persistFlushTimer = setTimeout(() => {
      persistFlushTimer = null;
      flushStateToIdb();
    }, 150);
    return persistChain;
  }

  function saveStateNow(st) {
    syncAllComputed(st);
    pendingPersistState = st;
    clearTimeout(persistFlushTimer);
    persistFlushTimer = null;
    return flushStateToIdb();
  }

  function normalizeCloudConfig(cfg) {
    const c = cfg && typeof cfg === "object" ? cfg : {};
    const url = String(c.url || "")
      .trim()
      .replace(/\/+$/, "");
    const anonKey = String(c.anonKey || "").trim();
    const bucket = String(c.bucket || "lingxin-ims").trim() || "lingxin-ims";
    const code = String(c.code || "").trim();
    const objectPath = code ? `sync/${encodeURIComponent(code)}.json` : String(c.objectPath || "").trim();
    return { url, anonKey, bucket, code, objectPath };
  }

  function supabaseStorageObjectUrls(cfg, access) {
    const n = normalizeCloudConfig(cfg);
    if (!n.url || !n.objectPath) return [];
    const bucket = encodeURIComponent(n.bucket);
    const pathSegs = n.objectPath.split("/").filter(Boolean).map((seg) => encodeURIComponent(decodeURIComponent(seg)));
    const path = pathSegs.join("/");
    const kind = access === "public" ? "public/" : "";
    return [`${n.url}/storage/v1/object/${kind}${bucket}/${path}`];
  }

  function androidBrowserLabel() {
    const ua = String(navigator.userAgent || "");
    if (/VivoBrowser/i.test(ua)) return "vivo 自带浏览器";
    if (/MicroMessenger/i.test(ua)) return "微信";
    if (/MQQBrowser|QQ\//i.test(ua)) return "QQ";
    if (/HuaweiBrowser|HiBrowser/i.test(ua)) return "华为浏览器";
    if (/MiuiBrowser/i.test(ua)) return "小米浏览器";
    if (/HeyTapBrowser/i.test(ua)) return "系统浏览器";
    if (/UCBrowser/i.test(ua)) return "UC 浏览器";
    return "当前浏览器";
  }

  function isCloudSyncRiskyBrowser() {
    const ua = String(navigator.userAgent || "");
    if (/MicroMessenger|MQQBrowser|QQ\//i.test(ua)) return true;
    if (/VivoBrowser|HuaweiBrowser|HiBrowser|MiuiBrowser|HeyTapBrowser|UCBrowser/i.test(ua)) return true;
    return false;
  }

  function cloudDataSummary(st) {
    const s = st || {};
    return (
      "进货 " +
      (s.purchases || []).length +
      " 条，销售 " +
      (s.sales || []).length +
      " 条，收款 " +
      (s.receipts || []).length +
      " 条"
    );
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
    localStorage.setItem(CLOUD_SYNC_KEY, JSON.stringify(normalizeCloudConfig(cfg)));
  }

  function buildCloudConfigFromModalInputs(fallback) {
    const cur = normalizeCloudConfig(fallback || loadCloudConfig() || {});
    const url = String(document.getElementById("m_url")?.value || "").trim() || cur.url || "";
    const anonKey = String(document.getElementById("m_key")?.value || "").trim() || cur.anonKey || "";
    const bucket = String(document.getElementById("m_bucket")?.value || "").trim() || cur.bucket || "lingxin-ims";
    const code = String(document.getElementById("m_code")?.value || "").trim() || cur.code || "";
    return normalizeCloudConfig({ url, anonKey, bucket, code });
  }

  function persistCloudConfigFromModal() {
    if (!document.getElementById("m_code")) return;
    const next = buildCloudConfigFromModalInputs();
    if (!next.url && !next.anonKey && !next.code && !next.bucket) return;
    saveCloudConfig(next);
  }

  function wireCloudModalAutoSave() {
    const ids = ["m_url", "m_key", "m_bucket", "m_code"];
    let t = null;
    function schedule() {
      if (t) clearTimeout(t);
      t = setTimeout(persistCloudConfigFromModal, 300);
    }
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", schedule);
      el.addEventListener("change", persistCloudConfigFromModal);
      el.addEventListener("blur", persistCloudConfigFromModal);
    });
    const overlay = document.getElementById("modalOverlay");
    if (overlay) {
      overlay.querySelectorAll("[data-modal-close],[data-modal-cancel]").forEach((b) => {
        b.addEventListener("click", persistCloudConfigFromModal, { capture: true });
      });
      overlay.addEventListener(
        "click",
        (e) => {
          if (e.target === overlay) persistCloudConfigFromModal();
        },
        { capture: true }
      );
    }
  }

  async function storageFetch(cfg, method, body) {
    const n = normalizeCloudConfig(cfg);
    if (!n.url || !n.anonKey || !n.objectPath) throw new Error("云同步未配置完整（URL/Key/同步码）");
    const headers = {
      apikey: n.anonKey,
      Authorization: `Bearer ${n.anonKey}`,
    };
    if (body != null) {
      headers["Content-Type"] = "application/json";
      headers["x-upsert"] = "true";
    }
    const fetchOpts = {
      method: method || "GET",
      headers,
      cache: "no-store",
      mode: "cors",
      credentials: "omit",
    };
    if (body != null) fetchOpts.body = body;

    const tryUrls =
      method === "GET"
        ? [...supabaseStorageObjectUrls(n, "private"), ...supabaseStorageObjectUrls(n, "public")]
        : supabaseStorageObjectUrls(n, "private");

    let lastErr = null;
    for (let i = 0; i < tryUrls.length; i++) {
      const objUrl = tryUrls[i];
      const isPublic = objUrl.includes("/object/public/");
      const opts = { ...fetchOpts };
      if (isPublic) {
        opts.headers = { Accept: "application/json" };
      }
      let res;
      try {
        res = await fetch(objUrl, opts);
      } catch (netErr) {
        lastErr = netErr;
        continue;
      }
      if (method === "GET" && res.status === 404) {
        if (i < tryUrls.length - 1) continue;
        return { res, objUrl };
      }
      if (res.ok || (method === "GET" && res.status === 404)) return { res, objUrl };
      if (method === "GET" && (res.status === 401 || res.status === 400) && i < tryUrls.length - 1) continue;
      const detail = (await res.text().catch(() => "")).slice(0, 400);
      lastErr = new Error(res.status + (detail ? "\n" + detail : ""));
      if (method === "GET" && i < tryUrls.length - 1) continue;
      throw new Error((method === "GET" ? "云端下载失败：" : "云端上传失败：") + res.status + (detail ? "\n" + detail : ""));
    }
    if (lastErr) {
      const msg = lastErr && lastErr.message ? lastErr.message : String(lastErr);
      if (/failed to fetch|networkerror|load failed/i.test(msg)) {
        throw new Error(
          "无法连接云端（网络错误）。" +
            (isCloudSyncRiskyBrowser()
              ? "\n\n您正在使用「" +
                androidBrowserLabel() +
                "」，该浏览器常拦截云同步。请安装 Chrome，用 Chrome 打开本网站后再试。"
              : "\n\n安卓请用 Chrome 打开网站，不要用微信/QQ/vivo 自带浏览器；并确认能正常上网。")
        );
      }
      throw lastErr;
    }
    throw new Error("无法连接云端");
  }

  async function cloudPull(cfg) {
    const { res } = await storageFetch(cfg, "GET");
    if (res.status === 404) return null;
    const text = await res.text();
    if (!text || !text.trim()) throw new Error("云端文件为空");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error("云端数据不是有效 JSON，请用电脑重新上传");
    }
    return migrateIfNeeded(parsed?.data || parsed);
  }

  async function cloudPush(cfg, state) {
    syncAllComputed(state);
    const payload = JSON.stringify({ savedAt: new Date().toISOString(), data: state });
    const { res } = await storageFetch(cfg, "PUT", payload);
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

  function saleCustLabel(s) {
    return String(s.customerName || "").trim() || "（未填写客户）";
  }

  /** 客户名比较用（避免不可见字符 / Unicode 形式不一致导致「一键结清」匹配不到） */
  function arCustomerNormKey(label) {
    let t = String(label || "").trim();
    try {
      if (typeof t.normalize === "function") t = t.normalize("NFC");
    } catch {
      /* ignore */
    }
    return t;
  }

  function saleCustMatchKey(s) {
    return arCustomerNormKey(saleCustLabel(s));
  }

  function salePaidTotal(s) {
    return Math.min(
      num(s.amount),
      Math.max(0, num(s.paidAtSale)) + Math.max(0, num(s.arReceiptAllocated)) + Math.max(0, num(s.arManualPaid))
    );
  }

  function settleSaleAr(s) {
    const rem = creditRemaining(s);
    if (rem > 0.001) s.arManualPaid = Math.max(0, num(s.arManualPaid)) + rem;
  }

  /** 按客户键结清该客户名下全部未结清欠款（customerKey 为 encodeURIComponent(arCustomerNormKey(saleCustLabel(s)))） */
  function settleCustomerAr(encodedCustomerKey) {
    let decoded = "";
    try {
      decoded = decodeURIComponent(String(encodedCustomerKey || ""));
    } catch {
      decoded = String(encodedCustomerKey || "");
    }
    const key = arCustomerNormKey(decoded);
    syncAllComputed(state);
    let n = 0;
    let total = 0;
    let displayName = decoded.trim() || "该客户";
    state.sales.forEach((s) => {
      if (saleCustMatchKey(s) !== key) return;
      const rem = creditRemaining(s);
      if (rem <= 0.001) return;
      if (n === 0) displayName = saleCustLabel(s);
      n++;
      total += rem;
    });
    if (!n) return alert("该客户暂无未结清欠款");
    if (
      !confirm(
        "确定将客户「" +
          displayName +
          "」下 " +
          n +
          " 笔未结清欠款（合计 " +
          money(total) +
          "）全部标记为已收？\n\n仅在账面结清（写入「手动结清」），不会生成单独收款单据；结清后可在「已结清赊销」查看。"
      )
    )
      return;
    state.sales.forEach((s) => {
      if (saleCustMatchKey(s) !== key) return;
      settleSaleAr(s);
    });
    saveState(state);
    fullRender();
  }

  function bindArPaidCheckboxes(root) {
    if (!root) return;
    root.querySelectorAll("[data-ar-paid]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.getAttribute("data-ar-paid");
        const s = state.sales.find((x) => String(x.id) === String(id));
        if (!s) return;
        if (cb.checked) {
          syncAllComputed(state);
          const rem = creditRemaining(s);
          if (rem > 0.001) {
            settleSaleAr(s);
            saveState(state);
            fullRender();
          } else {
            cb.checked = false;
          }
        }
      });
    });
  }

  function arUnpaidRowHtml(s) {
    const rem = creditRemaining(s);
    const cust = saleCustLabel(s);
    const paidTotal = salePaidTotal(s);
    const custKeyEnc = encodeURIComponent(arCustomerNormKey(saleCustLabel(s)));
    return `
        <td data-label="日期">${s.date}</td>
        <td data-label="客户">
          <div class="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center">
            <span>${escapeHtml(cust)}</span>
            <button type="button" class="lx-btn-outline shrink-0 px-2 py-0.5 text-xs" data-ar-settle-customer-key="${escapeHtml(custKeyEnc)}">一键结清</button>
          </div>
        </td>
        <td data-label="商品">${escapeHtml(s.product || "")}</td>
        <td data-label="小计" class="lx-money">${money(s.amount)}</td>
        <td data-label="当场已收"><input type="number" class="lx-input max-w-[7.5rem] py-1 text-sm" data-ar-paid-at-sale="${escapeHtml(s.id)}" min="0" step="0.01" value="${num(s.paidAtSale)}" title="可修改当场已收金额" /></td>
        <td data-label="收款核销" class="lx-money">${money(s.arReceiptAllocated)}</td>
        <td data-label="已付合计" class="lx-money">${money(paidTotal)}</td>
        <td data-label="剩余欠款" class="lx-money">${money(rem)}</td>
        <td data-label="本条结清"><input type="checkbox" class="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600" data-ar-paid="${escapeHtml(s.id)}" title="勾选表示本条已收齐" /></td>`;
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
      if (document.getElementById("m_code")) persistCloudConfigFromModal();
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
    return saveStateNow(s).then(() => s);
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
      "单位",
      (state.units || []).map((u) => ({ 记录ID: u.id, 名称: u.name }))
    );
    appendSheet(
      "商品档案",
      (state.productDefs || []).map((x) => ({
        记录ID: x.id,
        名称: x.name,
        默认单位: unitName(state, x.unitId),
      }))
    );
    appendSheet(
      "客户档案",
      (state.customerDefs || []).map((x) => ({ 记录ID: x.id, 名称: x.name }))
    );
    appendSheet(
      "供应商档案",
      (state.supplierDefs || []).map((x) => ({ 记录ID: x.id, 名称: x.name }))
    );
    appendSheet(
      "固定成本",
      (state.fixedCostEntries || []).map((e) => ({
        记录ID: e.id,
        项目: String(e.project || "").trim() || "—",
        开始日期: e.startDate || "",
        结束日期: e.endDate || "",
        金额: num(e.amount),
        备注: e.note || "",
      }))
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
          数量: formatQtyCell(p.qty, state, p.unitId),
          单价: num(p.price),
          额外费用: num(p.extraFee),
          小计: purchaseLineSubtotal(p),
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
            付款方式: pay,
            客户: s.customerName || "",
            数量: formatQtyCell(s.qty, state, s.unitId),
            单价: num(s.price),
            额外费用: num(s.extraFee),
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
    if (state.receipts && state.receipts.length) {
      appendSheet(
        "收款(历史)",
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
    }
    appendSheet(
      "调拨",
      [...state.transfers]
        .sort((a, b) => cmpDate(a.date, b.date))
        .map((t) => ({
          日期: t.date,
          商品: t.product || "",
          数量: formatQtyCell(t.qty, state, t.unitId),
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
          数量: formatQtyCell(a.qty, state, a.unitId),
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

  function quarterKey(iso) {
    const d = new Date(iso + "T12:00:00");
    const q = Math.floor(d.getMonth() / 3) + 1;
    return d.getFullYear() + "-Q" + q;
  }

  function yearKey(iso) {
    return String(iso).slice(0, 4);
  }

  function defaultCategoryId(state) {
    return state.categories[0].id;
  }

  function defNameList(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => String(x.name || "").trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, "zh-CN"));
  }

  function unitName(st, unitId) {
    const id = unitId || (st.units[0] && st.units[0].id);
    const u = (st.units || []).find((x) => x.id === id);
    return u ? u.name : "—";
  }

  function formatQtyCell(q, st, unitId) {
    return num(q).toFixed(2) + " " + unitName(st, unitId);
  }

  function collectSuppliers(state) {
    const set = new Set();
    state.purchases.forEach((p) => {
      const t = String(p.supplier || "").trim();
      if (t) set.add(t);
    });
    return Array.from(set).sort((a, b) => String(a).localeCompare(String(b), "zh-CN"));
  }

  function mergedProducts(state) {
    const set = new Set([...defNameList(state.productDefs), ...collectProducts(state)]);
    return Array.from(set)
      .filter(Boolean)
      .sort((a, b) => String(a).localeCompare(String(b), "zh-CN"));
  }

  function mergedCustomers(state) {
    const set = new Set([...defNameList(state.customerDefs), ...collectCustomers(state)]);
    return Array.from(set)
      .filter(Boolean)
      .sort((a, b) => String(a).localeCompare(String(b), "zh-CN"));
  }

  function mergedSuppliers(state) {
    const set = new Set([...defNameList(state.supplierDefs), ...collectSuppliers(state)]);
    return Array.from(set)
      .filter(Boolean)
      .sort((a, b) => String(a).localeCompare(String(b), "zh-CN"));
  }

  function refreshFilteredDatalist(dl, sortedAll, needle) {
    if (!dl) return;
    const n = String(needle || "").trim().toLowerCase();
    let list = sortedAll;
    if (n) list = sortedAll.filter((v) => String(v).toLowerCase().includes(n));
    const cap = n ? 80 : 200;
    if (list.length > cap) list = list.slice(0, cap);
    fillDatalist(dl, list);
  }

  function bindSuggestDelegation() {
    function upd(e) {
      const t = e.target;
      if (!t || t.tagName !== "INPUT") return;
      const lid = t.getAttribute("list");
      if (!lid) return;
      const dl = document.getElementById(lid);
      if (!dl) return;
      if (lid === "productList") refreshFilteredDatalist(dl, mergedProducts(state), t.value);
      else if (lid === "customerList") refreshFilteredDatalist(dl, mergedCustomers(state), t.value);
      else if (lid === "supplierList") refreshFilteredDatalist(dl, mergedSuppliers(state), t.value);
    }
    document.addEventListener("focusin", upd);
    document.addEventListener("input", upd);
  }
  function filterRows(state, start, end, warehouseId) {
    const wh = warehouseId || "";
    const ok = (row) => {
      if (!inRange(row.date, start, end)) return false;
      if (wh && row.warehouseId !== wh) return false;
      return true;
    };
    return {
      purchases: state.purchases.filter(ok),
      sales: state.sales.filter(ok),
    };
  }

  function isoDayCompare(a, b) {
    return String(a || "").localeCompare(String(b || ""));
  }

  function addDaysISO(iso, deltaDays) {
    const d = new Date(String(iso || "").slice(0, 10) + "T12:00:00");
    if (Number.isNaN(d.getTime())) return iso;
    d.setDate(d.getDate() + deltaDays);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function daysBetweenInclusive(isoStart, isoEnd) {
    const d1 = new Date(String(isoStart).slice(0, 10) + "T12:00:00");
    const d2 = new Date(String(isoEnd).slice(0, 10) + "T12:00:00");
    if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return 0;
    return Math.round((d2 - d1) / 86400000) + 1;
  }

  function maxIso(a, b) {
    return isoDayCompare(a, b) >= 0 ? a : b;
  }

  function minIso(a, b) {
    return isoDayCompare(a, b) <= 0 ? a : b;
  }

  function entrySpanDays(segStart, segEnd) {
    if (!segStart || !segEnd || isoDayCompare(segStart, segEnd) > 0) return 0;
    return daysBetweenInclusive(segStart, segEnd);
  }

  function overlapDaysInclusive(windowStart, windowEnd, segStart, segEnd) {
    const winS = windowStart || "0000-01-01";
    const winE = windowEnd || "9999-12-31";
    if (!segStart || !segEnd || isoDayCompare(segStart, segEnd) > 0) return 0;
    const lo = maxIso(winS, segStart);
    const hi = minIso(winE, segEnd);
    if (isoDayCompare(lo, hi) > 0) return 0;
    return daysBetweenInclusive(lo, hi);
  }

  function fixedCostAmountInWindow(entry, filterStart, filterEnd) {
    const span = entrySpanDays(entry.startDate, entry.endDate);
    if (span <= 0) return 0;
    const ov = overlapDaysInclusive(filterStart, filterEnd, entry.startDate, entry.endDate);
    if (ov <= 0) return 0;
    return (num(entry.amount) * ov) / span;
  }

  function totalFixedCostForFilter(state, filterStart, filterEnd) {
    return (state.fixedCostEntries || []).reduce((a, e) => a + fixedCostAmountInWindow(e, filterStart, filterEnd), 0);
  }

  function dailyFixedAmountOnDate(state, dateISO) {
    let sum = 0;
    (state.fixedCostEntries || []).forEach((e) => {
      if (!inRange(dateISO, e.startDate, e.endDate)) return;
      const span = entrySpanDays(e.startDate, e.endDate);
      if (span <= 0) return;
      sum += num(e.amount) / span;
    });
    return sum;
  }

  function effectiveAnalysisDateBounds(state, filterStart, filterEnd, fs, fp) {
    let s = String(filterStart || "").trim();
    let e = String(filterEnd || "").trim();
    const tx = [];
    fs.forEach((x) => {
      if (x.date) tx.push(x.date);
    });
    fp.forEach((x) => {
      if (x.date) tx.push(x.date);
    });
    tx.sort();
    if (!s && tx.length) s = tx[0];
    if (!e && tx.length) e = tx[tx.length - 1];
    (state.fixedCostEntries || []).forEach((en) => {
      if (!en.startDate || !en.endDate) return;
      if (!s || isoDayCompare(en.startDate, s) < 0) s = en.startDate;
      if (!e || isoDayCompare(en.endDate, e) > 0) e = en.endDate;
    });
    if (!s || !e || isoDayCompare(s, e) > 0) return { s: "", e: "" };
    return { s, e };
  }

  function periodKeyForGroup(groupMode, iso) {
    if (groupMode === "week") return weekKey(iso);
    if (groupMode === "month") return monthKey(iso);
    if (groupMode === "quarter") return quarterKey(iso);
    if (groupMode === "year") return yearKey(iso);
    return iso;
  }

  function fixedCostByPeriodKey(state, filterStart, filterEnd, groupMode, fs, fp) {
    const m = new Map();
    const bounds = effectiveAnalysisDateBounds(state, filterStart, filterEnd, fs, fp);
    if (!bounds.s || !bounds.e) return m;
    let cur = bounds.s;
    for (;;) {
      if (inRange(cur, filterStart, filterEnd)) {
        const k = periodKeyForGroup(groupMode, cur);
        const add = dailyFixedAmountOnDate(state, cur);
        m.set(k, (m.get(k) || 0) + add);
      }
      if (cur === bounds.e) break;
      cur = addDaysISO(cur, 1);
    }
    return m;
  }

  function confirmTypedPhrase(preConfirmText, requiredExact) {
    if (!confirm(preConfirmText)) return false;
    const t = prompt('请输入「' + requiredExact + '」须与提示完全一致（含空格）。\n点取消即放弃。');
    return t != null && String(t).trim() === requiredExact;
  }

  function resetAnalyticsFilters() {
    if (!els.fStart || !els.fEnd || !els.fWarehouse || !els.fGroup) return;
    els.fStart.value = "";
    els.fEnd.value = "";
    els.fWarehouse.value = "";
    els.fGroup.value = "day";
    resetAnalyticsListPagers();
    purchaseCheckedIds.clear();
    salesCheckedIds.clear();
    renderAnalytics();
  }

  function clearAllPurchases() {
    if (!state.purchases.length) return alert("暂无进货记录");
    if (!confirmTypedPhrase("将永久删除全部进货单，库存与利润将重算，不可恢复。", "确认清空全部进货")) return;
    state.purchases = [];
    purchaseCheckedIds.clear();
    saveState(state);
    fullRender();
  }

  function clearAllSales() {
    if (!state.sales.length) return alert("暂无销售记录");
    if (!confirmTypedPhrase("将永久删除全部销售单，应收与库存将重算，不可恢复。", "确认清空全部销售")) return;
    state.sales = [];
    salesCheckedIds.clear();
    saveState(state);
    fullRender();
  }

  function clearAllTransfers() {
    if (!state.transfers.length) return alert("暂无调拨记录");
    if (!confirmTypedPhrase("将永久删除全部调拨单，不可恢复。", "确认清空全部调拨")) return;
    state.transfers = [];
    saveState(state);
    fullRender();
  }

  function clearAllAdjustments() {
    if (!state.adjustments.length) return alert("暂无库存调整记录");
    if (!confirmTypedPhrase("将永久删除全部库存调整单，库存将重算，不可恢复。", "确认清空全部库存调整")) return;
    state.adjustments = [];
    saveState(state);
    fullRender();
  }

  function clearWarehousesExceptFirst() {
    if (state.warehouses.length <= 1) return alert("仅有一个仓库，无需清空。");
    const keep = state.warehouses[0];
    if (!confirm("将删除除「" + keep.name + "」外的全部仓库，并把相关进货/销售/调拨/调整单归到该仓。不可恢复。\n确定继续？")) return;
    for (let i = 1; i < state.warehouses.length; i++) {
      const wid = state.warehouses[i].id;
      state.purchases.forEach((p) => {
        if (p.warehouseId === wid) p.warehouseId = keep.id;
      });
      state.sales.forEach((s) => {
        if (s.warehouseId === wid) s.warehouseId = keep.id;
      });
      state.adjustments.forEach((a) => {
        if (a.warehouseId === wid) a.warehouseId = keep.id;
      });
      state.transfers.forEach((t) => {
        if (t.fromWarehouseId === wid) t.fromWarehouseId = keep.id;
        if (t.toWarehouseId === wid) t.toWarehouseId = keep.id;
      });
    }
    state.warehouses = [keep];
    saveState(state);
    fullRender();
  }

  function clearProductDefsAndResetUnits() {
    if (!confirmTypedPhrase("将清空商品档案，并把计量单位重置为仅「件」，所有单据中的单位将统一到该单位。不可恢复。", "确认清空商品与单位档案")) return;
    const nu = uid();
    [...(state.units || [])].forEach((u) => {
      if (u.id !== nu) reassignUnitIdEverywhere(state, u.id, nu);
    });
    state.units = [{ id: nu, name: "件" }];
    state.productDefs = [];
    saveState(state);
    fullRender();
  }

  function clearCustomerDefsOnly() {
    if (!(state.customerDefs || []).length) return alert("客户档案已为空");
    if (!confirm("将清空客户档案列表（不会修改已有销售单、收款里已填的客户名）。确定？")) return;
    state.customerDefs = [];
    saveState(state);
    fullRender();
  }

  function clearSupplierDefsOnly() {
    if (!(state.supplierDefs || []).length) return alert("供应商档案已为空");
    if (!confirm("将清空供应商档案列表（不会修改已有进货单里的供应商名）。确定？")) return;
    state.supplierDefs = [];
    saveState(state);
    fullRender();
  }

  function clearFixedCostEntriesOnly() {
    if (!(state.fixedCostEntries || []).length) return alert("暂无固定成本记录");
    if (!confirm("将删除全部固定成本记录，统计分析中的固定成本将变为 0。确定？")) return;
    state.fixedCostEntries = [];
    saveState(state);
    fullRender();
  }

  function latestUnitIdForProduct(st, productName) {
    const k = productKey(productName);
    if (!k) return null;
    const cand = [];
    function push(date, unitId) {
      const u = unitId || defaultUnitId(st);
      if (u) cand.push({ date: String(date || ""), unitId: u });
    }
    st.purchases.forEach((p) => {
      if (productKey(p.product) === k) push(p.date, p.unitId);
    });
    st.sales.forEach((s) => {
      if (productKey(s.product) === k) push(s.date, s.unitId);
    });
    st.adjustments.forEach((a) => {
      if (productKey(a.product) === k) push(a.date, a.unitId);
    });
    st.transfers.forEach((t) => {
      if (productKey(t.product) === k) push(t.date, t.unitId);
    });
    cand.sort((a, b) => -cmpDate(a.date, b.date));
    return cand.length ? cand[0].unitId : null;
  }

  function resolvedUnitIdForProductInput(st, productName) {
    const t = String(productName || "").trim();
    if (!t) return null;
    const def = (st.productDefs || []).find((x) => String(x.name || "").trim() === t);
    if (def && def.unitId && st.units.some((u) => u.id === def.unitId)) return def.unitId;
    const lu = latestUnitIdForProduct(st, productName);
    if (lu && st.units.some((u) => u.id === lu)) return lu;
    return null;
  }

  function setUnitFieldIfValid(fieldEl, unitId) {
    if (!fieldEl || !unitId) return;
    if (fieldEl.tagName === "SELECT") {
      if ([...fieldEl.options].some((o) => o.value === unitId)) fieldEl.value = unitId;
      return;
    }
    const name = unitNameById(state, unitId);
    if (name) fieldEl.value = name;
  }

  function applyResolvedProductUnit(productInputEl, unitFieldEl) {
    if (!productInputEl || !unitFieldEl) return;
    const unitId = resolvedUnitIdForProductInput(state, productInputEl.value);
    if (unitId) setUnitFieldIfValid(unitFieldEl, unitId);
  }

  function listDateRange(startEl, endEl) {
    return {
      start: (startEl && startEl.value) || "",
      end: (endEl && endEl.value) || "",
    };
  }

  function readArFilters() {
    return {
      date: listDateRange(els.arDateStart, els.arDateEnd),
      customer: (els.arCustomerFilter && els.arCustomerFilter.value.trim()) || "",
      product: (els.arProductFilter && els.arProductFilter.value.trim().toLowerCase()) || "",
    };
  }

  function saleMatchesArFilters(s, filters) {
    if (!inRange(s.date, filters.date.start, filters.date.end)) return false;
    if (filters.customer) {
      const c = filters.customer.toLowerCase();
      if (!saleCustLabel(s).toLowerCase().includes(c)) return false;
    }
    if (filters.product && !String(s.product || "").toLowerCase().includes(filters.product)) return false;
    return true;
  }

  function applyPaidAtSaleEdit(saleId, raw) {
    const s = state.sales.find((x) => x.id === saleId);
    if (!s) return;
    let v = Math.max(0, num(raw));
    v = Math.min(v, num(s.amount));
    if (Math.abs(v - num(s.paidAtSale)) < 0.0001) return;
    s.paidAtSale = v;
    saveState(state);
    refreshReceivables();
  }

  function filteredPurchaseRows(st, qLower, start, end) {
    const ds = start || "";
    const de = end || "";
    return st.purchases
      .filter((p) => {
        if (!inRange(p.date, ds, de)) return false;
        if (qLower && !String(p.product).toLowerCase().includes(qLower)) return false;
        return true;
      })
      .sort((a, b) => -cmpDate(a.date, b.date));
  }

  function filteredSalesRows(st, qLower, start, end) {
    const ds = start || "";
    const de = end || "";
    return st.sales
      .filter((s) => {
        if (!inRange(s.date, ds, de)) return false;
        if (qLower && !String(s.product).toLowerCase().includes(qLower)) return false;
        return true;
      })
      .sort((a, b) => -cmpDate(a.date, b.date));
  }

  function paginateRows(rows, pageIndex, pageSize) {
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / pageSize) || 1);
    const page = Math.min(Math.max(1, pageIndex), pages);
    const slice = rows.slice((page - 1) * pageSize, page * pageSize);
    return { page, pages, total, slice };
  }

  const LIST_PAGE_OPTIONS = [10, 50, 100];
  const LIST_PAGE_STORAGE = "hardware_ims_list_pager_v1";

  /** @type {Record<string, { page: number, size: number }>} */
  const listPager = {};

  const PAGER_UI = {
    purchases: { info: "purchasePageInfo", size: "purchasePageSize", prev: "purchasePagePrev", next: "purchasePageNext" },
    sales: { info: "salesPageInfo", size: "salesPageSize", prev: "salesPagePrev", next: "salesPageNext" },
    arSummary: { info: "arSummaryPagerInfo", size: "arSummaryPagerSize", prev: "arSummaryPagerPrev", next: "arSummaryPagerNext" },
    arPaid: { info: "arPaidPagerInfo", size: "arPaidPagerSize", prev: "arPaidPagerPrev", next: "arPaidPagerNext" },
    inventory: { info: "inventoryPagerInfo", size: "inventoryPagerSize", prev: "inventoryPagerPrev", next: "inventoryPagerNext" },
    transfers: { info: "transferPagerInfo", size: "transferPagerSize", prev: "transferPagerPrev", next: "transferPagerNext" },
    adjustments: { info: "adjustPagerInfo", size: "adjustPagerSize", prev: "adjustPagerPrev", next: "adjustPagerNext" },
    warehouses: { info: "warehousePagerInfo", size: "warehousePagerSize", prev: "warehousePagerPrev", next: "warehousePagerNext" },
    productDefs: { info: "productDefPagerInfo", size: "productDefPagerSize", prev: "productDefPagerPrev", next: "productDefPagerNext" },
    customerDefs: { info: "customerDefPagerInfo", size: "customerDefPagerSize", prev: "customerDefPagerPrev", next: "customerDefPagerNext" },
    supplierDefs: { info: "supplierDefPagerInfo", size: "supplierDefPagerSize", prev: "supplierDefPagerPrev", next: "supplierDefPagerNext" },
    fixedCosts: { info: "fixedCostPagerInfo", size: "fixedCostPagerSize", prev: "fixedCostPagerPrev", next: "fixedCostPagerNext" },
    profitGroup: { info: "profitGroupPagerInfo", size: "profitGroupPagerSize", prev: "profitGroupPagerPrev", next: "profitGroupPagerNext" },
    productStats: { info: "productStatsPagerInfo", size: "productStatsPagerSize", prev: "productStatsPagerPrev", next: "productStatsPagerNext" },
    bestseller: { info: "bestsellerPagerInfo", size: "bestsellerPagerSize", prev: "bestsellerPagerPrev", next: "bestsellerPagerNext" },
  };

  function coerceListPageSize(n) {
    const x = Number(n);
    return LIST_PAGE_OPTIONS.includes(x) ? x : 50;
  }

  function loadStoredListPageSize(key) {
    try {
      const o = JSON.parse(localStorage.getItem(LIST_PAGE_STORAGE) || "{}");
      return coerceListPageSize(o[key]);
    } catch (e) {
      return 50;
    }
  }

  function persistListPageSize(key) {
    if (!listPager[key]) return;
    try {
      const o = JSON.parse(localStorage.getItem(LIST_PAGE_STORAGE) || "{}");
      o[key] = listPager[key].size;
      localStorage.setItem(LIST_PAGE_STORAGE, JSON.stringify(o));
    } catch (e) {}
  }

  function ensureListPager(key) {
    if (!listPager[key]) listPager[key] = { page: 1, size: loadStoredListPageSize(key) };
    return listPager[key];
  }

  function paginateWithPager(key, rows) {
    const pg = ensureListPager(key);
    const { page, pages, total, slice } = paginateRows(rows, pg.page, pg.size);
    pg.page = page;
    return { page, pages, total, slice, pageSize: pg.size };
  }

  function syncPagerControls(key, meta) {
    const ui = PAGER_UI[key];
    if (!ui) return;
    const info = document.getElementById(ui.info);
    const size = document.getElementById(ui.size);
    const prev = document.getElementById(ui.prev);
    const next = document.getElementById(ui.next);
    if (info) info.textContent = meta.total ? "第 " + meta.page + "/" + meta.pages + " 页，共 " + meta.total + " 条" : "共 0 条";
    if (size) {
      const v = String(meta.pageSize);
      if (size.value !== v) size.value = v;
    }
    if (prev) prev.disabled = meta.pages <= 1 || meta.total === 0;
    if (next) next.disabled = meta.page >= meta.pages || meta.total === 0;
  }

  function resetAnalyticsListPagers() {
    ["profitGroup", "productStats", "bestseller"].forEach((k) => {
      ensureListPager(k).page = 1;
    });
  }

  function writeWorkbookToFile(wb, filenameBase) {
    const XLSX = typeof window !== "undefined" ? window.XLSX : undefined;
    if (!XLSX || !XLSX.utils || !XLSX.writeFile) {
      alert("Excel 组件未加载，请确认网络正常后刷新页面再试。");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    XLSX.writeFile(wb, filenameBase + "_" + stamp + ".xlsx");
  }

  function bookAppendJsonSheets(XLSX, wb, pairs) {
    pairs.forEach(({ name, rows }) => {
      const sheetName = String(name).slice(0, 31);
      let ws;
      if (!rows || !rows.length) ws = XLSX.utils.aoa_to_sheet([["（暂无数据）"]]);
      else ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });
  }

  function exportModuleWorkbook(mod) {
    const XLSX = typeof window !== "undefined" ? window.XLSX : undefined;
    if (!XLSX || !XLSX.utils || !XLSX.writeFile) {
      alert("Excel 组件未加载，请确认网络正常后刷新页面再试。");
      return;
    }
    syncAllComputed(state);
    const wb = XLSX.utils.book_new();
    const nameBase = "玲鑫进销存_模块";

    if (mod === "purchase") {
      bookAppendJsonSheets(XLSX, wb, [
        {
          name: "进货",
          rows: [...state.purchases]
            .sort((a, b) => cmpDate(a.date, b.date))
            .map((p) => ({
              日期: p.date,
              仓库: whName(state, p.warehouseId),
              供应商: p.supplier || "",
              商品: p.product || "",
              单位: unitName(state, p.unitId),
              数量数值: num(p.qty),
              数量显示: formatQtyCell(p.qty, state, p.unitId),
              单价: num(p.price),
              额外费用: num(p.extraFee),
              小计: purchaseLineSubtotal(p),
              记录ID: p.id,
            })),
        },
      ]);
      writeWorkbookToFile(wb, nameBase + "_进货管理");
      return;
    }
    if (mod === "sales") {
      bookAppendJsonSheets(XLSX, wb, [
        {
          name: "销售",
          rows: [...state.sales]
            .sort((a, b) => cmpDate(a.date, b.date))
            .map((s) => {
              const rem = creditRemaining(s);
              const pay = s.paymentType === "credit" ? "赊账" : "现款";
              return {
                日期: s.date,
                仓库: whName(state, s.warehouseId),
                商品: s.product || "",
                单位: unitName(state, s.unitId),
                数量数值: num(s.qty),
                数量显示: formatQtyCell(s.qty, state, s.unitId),
                付款方式: pay,
                客户: s.customerName || "",
                单价: num(s.price),
                额外费用: num(s.extraFee),
                销售成本: num(s.costAtSale),
                小计: num(s.amount),
                当场已收: Math.min(num(s.amount), Math.max(0, num(s.paidAtSale))),
                赊欠余额: rem > 0.0001 ? +rem.toFixed(2) : 0,
                收款核销: num(s.arReceiptAllocated),
                手动结清: num(s.arManualPaid),
                买方: s.buyer || "",
                记录ID: s.id,
              };
            }),
        },
      ]);
      writeWorkbookToFile(wb, nameBase + "_销售管理");
      return;
    }
    if (mod === "receivables") {
      const balMap = arCustomerBalances(state);
      const summaryRows = [];
      state.sales.forEach((s) => {
        if (creditRemaining(s) <= 0.001) return;
        const rem = creditRemaining(s);
        summaryRows.push({
          日期: s.date,
          客户: saleCustLabel(s),
          商品: s.product || "",
          小计: num(s.amount),
          当场已收: num(s.paidAtSale),
          收款核销: num(s.arReceiptAllocated),
          已付合计: salePaidTotal(s),
          剩余欠款: rem,
          记录ID: s.id,
        });
      });
      summaryRows.sort(
        (a, b) => String(a.客户).localeCompare(String(b.客户), "zh-CN") || cmpDate(a.日期, b.日期)
      );
      const customerTotalRows = Array.from(balMap.entries()).map(([客户, 应收余额]) => ({ 客户, 应收余额 }));
      const paidRows = [];
      state.sales.forEach((s) => {
        if (
          !(
            creditRemaining(s) <= 0.001 &&
            (num(s.arReceiptAllocated) > 0 || num(s.arManualPaid) > 0 || num(s.paidAtSale) < num(s.amount))
          )
        )
          return;
        const manual = Math.max(0, num(s.arManualPaid));
        const paidTotal = Math.min(
          num(s.amount),
          Math.max(0, num(s.paidAtSale)) + Math.max(0, num(s.arReceiptAllocated)) + manual
        );
        paidRows.push({
          日期: s.date,
          客户: String(s.customerName || "").trim() || "（未填写客户）",
          商品: s.product || "",
          小计: num(s.amount),
          当场已收: num(s.paidAtSale),
          收款核销: num(s.arReceiptAllocated),
          手动结清: manual,
          已收合计: paidTotal,
          记录ID: s.id,
        });
      });
      paidRows.sort((a, b) => -cmpDate(a.date, b.date));
      bookAppendJsonSheets(XLSX, wb, [
        { name: "客户欠款明细", rows: summaryRows },
        { name: "客户合计欠款", rows: customerTotalRows },
        { name: "已结清赊销", rows: paidRows },
      ]);
      writeWorkbookToFile(wb, nameBase + "_应收账款");
      return;
    }
    if (mod === "inventory") {
      const { inv } = buildLedger(state);
      const invRows = [];
      Array.from(inv.keys())
        .sort()
        .forEach((k) => {
          const [whId, prod] = k.split("|||");
          const c = inv.get(k);
          if (Math.abs(num(c.qty)) < 0.0001 && Math.abs(num(c.totalCost)) < 0.0001) return;
          invRows.push({
            仓库: whName(state, whId),
            商品: prod,
            库存数量: formatQtyCell(c.qty, state, state.units[0].id),
            库存数量值: num(c.qty),
            库存均价: avgUnit(c),
            库存成本: num(c.totalCost),
          });
        });
      bookAppendJsonSheets(XLSX, wb, [
        { name: "当前库存", rows: invRows },
        {
          name: "调拨",
          rows: [...state.transfers]
            .sort((a, b) => -cmpDate(a.date, b.date))
            .map((t) => ({
              日期: t.date,
              商品: t.product || "",
              数量: formatQtyCell(t.qty, state, t.unitId),
              从仓库: whName(state, t.fromWarehouseId),
              到仓库: whName(state, t.toWarehouseId),
              备注: t.note || "",
              记录ID: t.id,
            })),
        },
        {
          name: "库存调整",
          rows: [...state.adjustments]
            .sort((a, b) => -cmpDate(a.date, b.date))
            .map((a) => ({
              日期: a.date,
              仓库: whName(state, a.warehouseId),
              商品: a.product || "",
              调整数量: formatQtyCell(a.qty, state, a.unitId),
              原因: a.reason || "",
              记录ID: a.id,
            })),
        },
      ]);
      writeWorkbookToFile(wb, nameBase + "_库存管理");
      return;
    }
    if (mod === "basics") {
      bookAppendJsonSheets(XLSX, wb, [
        { name: "仓库", rows: state.warehouses.map((w) => ({ 记录ID: w.id, 名称: w.name })) },
        { name: "单位", rows: (state.units || []).map((u) => ({ 记录ID: u.id, 名称: u.name })) },
        {
          name: "商品档案",
          rows: (state.productDefs || []).map((x) => ({
            记录ID: x.id,
            名称: x.name,
            默认单位: unitName(state, x.unitId),
          })),
        },
        { name: "客户档案", rows: (state.customerDefs || []).map((x) => ({ 记录ID: x.id, 名称: x.name })) },
        { name: "供应商档案", rows: (state.supplierDefs || []).map((x) => ({ 记录ID: x.id, 名称: x.name })) },
        {
          name: "固定成本",
          rows: (state.fixedCostEntries || []).map((e) => ({
            记录ID: e.id,
            项目: String(e.project || "").trim() || "—",
            开始日期: e.startDate || "",
            结束日期: e.endDate || "",
            金额: num(e.amount),
            备注: e.note || "",
          })),
        },
      ]);
      writeWorkbookToFile(wb, nameBase + "_基础设置");
      return;
    }
    if (mod === "analytics") {
      const start = els.fStart && els.fStart.value ? els.fStart.value : "";
      const end = els.fEnd && els.fEnd.value ? els.fEnd.value : "";
      const wh = els.fWarehouse && els.fWarehouse.value ? els.fWarehouse.value : "";
      const { purchases: fp, sales: fs } = filterRows(state, start, end, wh);
      const groupMode = (els.fGroup && els.fGroup.value) || "day";
      const map = new Map();
      function keyFor(date) {
        if (groupMode === "week") return weekKey(date);
        if (groupMode === "month") return monthKey(date);
        if (groupMode === "quarter") return quarterKey(date);
        if (groupMode === "year") return yearKey(date);
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
        o.expense = (o.expense || 0) + purchaseLineSubtotal(p);
        map.set(k, o);
      });
      const fixedByKey = fixedCostByPeriodKey(state, start, end, groupMode, fs, fp);
      fixedByKey.forEach((amt, k) => {
        if (!map.has(k)) map.set(k, { revenue: 0, cogs: 0, expense: 0 });
      });
      const periodRows = Array.from(new Set([...map.keys(), ...fixedByKey.keys()]))
        .sort()
        .map((k) => {
          const o = map.get(k) || { revenue: 0, cogs: 0, expense: 0 };
          const rev = num(o.revenue);
          const cg = num(o.cogs);
          const fx = num(fixedByKey.get(k) || 0);
          const prof = rev - cg - fx;
          const mar = rev > 0 ? (100 * prof) / rev : 0;
          return {
            周期: k,
            销售额: rev,
            销售成本: cg,
            固定成本: fx,
            利润: prof,
            利润率: +mar.toFixed(2) + "%",
          };
        });
      const revenue = fs.reduce((a, s) => a + num(s.amount), 0);
      const cogs = fs.reduce((a, s) => a + num(s.costAtSale), 0);
      const fixedTotal = totalFixedCostForFilter(state, start, end);
      const profit = revenue - cogs - fixedTotal;
      const margin = revenue > 0 ? (100 * profit) / revenue : 0;
      const prodMap = new Map();
      fs.forEach((s) => {
        const k = productKey(s.product);
        if (!k) return;
        const o = prodMap.get(k) || { product: s.product, qtySold: 0, revenue: 0, cogs: 0 };
        o.qtySold += num(s.qty);
        o.revenue += num(s.amount);
        o.cogs += num(s.costAtSale);
        prodMap.set(k, o);
      });
      fp.forEach((p) => {
        const k = productKey(p.product);
        if (!k) return;
        const o = prodMap.get(k) || { product: p.product, qtyIn: 0, qtySold: 0, revenue: 0, cogs: 0 };
        o.qtyIn = (o.qtyIn || 0) + num(p.qty);
        prodMap.set(k, o);
      });
      const prodRows = Array.from(prodMap.values())
        .sort((a, b) => b.revenue - a.revenue)
        .map((o) => {
          const prof = o.revenue - o.cogs;
          const mar = o.revenue > 0 ? (100 * prof) / o.revenue : 0;
          return {
            商品: o.product,
            进货量: formatQtyCell(o.qtyIn || 0, state, state.units[0].id),
            销售量: formatQtyCell(o.qtySold, state, state.units[0].id),
            销售额: o.revenue,
            销售成本: o.cogs,
            利润: prof,
            利润率: mar.toFixed(2) + "%",
          };
        });
      const bsRows = [];
      const prodRank = new Map();
      fs.forEach((s) => {
        const k = productKey(s.product);
        if (!k) return;
        const o = prodRank.get(k) || { label: String(s.product || "").trim() || k, qty: 0, rev: 0 };
        o.qty += num(s.qty);
        o.rev += num(s.amount);
        prodRank.set(k, o);
      });
      Array.from(prodRank.values())
        .sort((a, b) => b.rev - a.rev || b.qty - a.qty)
        .forEach((o, i) => {
          bsRows.push({
            名次: i + 1,
            商品: o.label,
            销售数量: formatQtyCell(o.qty, state, state.units[0].id),
            销售额: o.rev,
          });
        });
      bookAppendJsonSheets(XLSX, wb, [
        {
          name: "筛选说明",
          rows: [
            {
              开始日期: start || "（不限）",
              结束日期: end || "（不限）",
              仓库: wh ? whName(state, wh) : "全部",
              粒度: groupMode,
              销售额合计: revenue,
              销售成本合计: cogs,
              固定成本合计: fixedTotal,
              利润合计: profit,
              利润率: margin.toFixed(2) + "%",
            },
          ],
        },
        { name: "周期汇总", rows: periodRows },
        {
          name: "筛选进货",
          rows: [...fp]
            .sort((a, b) => cmpDate(a.date, b.date))
            .map((p) => ({
              日期: p.date,
              仓库: whName(state, p.warehouseId),
              供应商: p.supplier || "",
              商品: p.product || "",
              数量: formatQtyCell(p.qty, state, p.unitId),
              单价: num(p.price),
              记录ID: p.id,
            })),
        },
        {
          name: "筛选销售",
          rows: [...fs]
            .sort((a, b) => cmpDate(a.date, b.date))
            .map((s) => ({
              日期: s.date,
              仓库: whName(state, s.warehouseId),
              商品: s.product || "",
              数量: formatQtyCell(s.qty, state, s.unitId),
              小计: num(s.amount),
              客户: s.customerName || "",
              记录ID: s.id,
            })),
        },
        { name: "商品销售统计", rows: prodRows },
        { name: "畅销榜", rows: bsRows },
      ]);
      writeWorkbookToFile(wb, nameBase + "_统计分析");
      return;
    }
    alert("无法识别导出模块，请刷新页面后重试。");
  }

  /** -------- DOM App -------- */
  let state = defaultState();
  let els = null;
  let refreshReceivables = function () {};
  let rerenderForListPagerKey = function () {};

  function bootApp() {
  els = {
    themeBtn: document.getElementById("themeBtn"),
    backupExportBtn: document.getElementById("backupExportBtn"),
    backupImportBtn: document.getElementById("backupImportBtn"),
    exportAllExcelBtn: document.getElementById("exportAllExcelBtn"),
    backupFileInput: document.getElementById("backupFileInput"),
    productList: document.getElementById("productList"),
    unitList: document.getElementById("unitList"),
    customerList: document.getElementById("customerList"),
    supplierList: document.getElementById("supplierList"),
    tabBtns: document.querySelectorAll(".tab-btn"),
    panels: document.querySelectorAll(".panel"),
    pDate: document.getElementById("pDate"),
    pSupplier: document.getElementById("pSupplier"),
    pProduct: document.getElementById("pProduct"),
    pWarehouse: document.getElementById("pWarehouse"),
    pQty: document.getElementById("pQty"),
    pUnit: document.getElementById("pUnit"),
    pPrice: document.getElementById("pPrice"),
    pExtraFee: document.getElementById("pExtraFee"),
    purchaseForm: document.getElementById("purchaseForm"),
    purchaseSearch: document.getElementById("purchaseSearch"),
    purchaseDateStart: document.getElementById("purchaseDateStart"),
    purchaseDateEnd: document.getElementById("purchaseDateEnd"),
    purchaseDateClear: document.getElementById("purchaseDateClear"),
    purchaseTbody: document.getElementById("purchaseTbody"),
    sDate: document.getElementById("sDate"),
    sProduct: document.getElementById("sProduct"),
    sWarehouse: document.getElementById("sWarehouse"),
    sQty: document.getElementById("sQty"),
    sUnit: document.getElementById("sUnit"),
    sPrice: document.getElementById("sPrice"),
    sExtraFee: document.getElementById("sExtraFee"),
    sPaymentType: document.getElementById("sPaymentType"),
    sCustomer: document.getElementById("sCustomer"),
    sPaidNow: document.getElementById("sPaidNow"),
    sBuyer: document.getElementById("sBuyer"),
    salesForm: document.getElementById("salesForm"),
    salesSearch: document.getElementById("salesSearch"),
    salesDateStart: document.getElementById("salesDateStart"),
    salesDateEnd: document.getElementById("salesDateEnd"),
    salesDateClear: document.getElementById("salesDateClear"),
    salesTbody: document.getElementById("salesTbody"),
    arSummaryTbody: document.getElementById("arSummaryTbody"),
    arPaidTbody: document.getElementById("arPaidTbody"),
    arDateStart: document.getElementById("arDateStart"),
    arDateEnd: document.getElementById("arDateEnd"),
    arCustomerFilter: document.getElementById("arCustomerFilter"),
    arProductFilter: document.getElementById("arProductFilter"),
    arFilterClear: document.getElementById("arFilterClear"),
    aDate: document.getElementById("aDate"),
    aWarehouse: document.getElementById("aWarehouse"),
    aProduct: document.getElementById("aProduct"),
    aQty: document.getElementById("aQty"),
    aUnit: document.getElementById("aUnit"),
    aReason: document.getElementById("aReason"),
    adjustForm: document.getElementById("adjustForm"),
    tDate: document.getElementById("tDate"),
    tProduct: document.getElementById("tProduct"),
    tQty: document.getElementById("tQty"),
    tUnit: document.getElementById("tUnit"),
    tFrom: document.getElementById("tFrom"),
    tTo: document.getElementById("tTo"),
    tNote: document.getElementById("tNote"),
    transferForm: document.getElementById("transferForm"),
    warehouseForm: document.getElementById("warehouseForm"),
    newWarehouse: document.getElementById("newWarehouse"),
    warehouseTbody: document.getElementById("warehouseTbody"),
    productDefForm: document.getElementById("productDefForm"),
    newProductDef: document.getElementById("newProductDef"),
    newProductDefUnitName: document.getElementById("newProductDefUnitName"),
    productDefTbody: document.getElementById("productDefTbody"),
    customerDefForm: document.getElementById("customerDefForm"),
    newCustomerDef: document.getElementById("newCustomerDef"),
    customerDefTbody: document.getElementById("customerDefTbody"),
    supplierDefForm: document.getElementById("supplierDefForm"),
    newSupplierDef: document.getElementById("newSupplierDef"),
    supplierDefTbody: document.getElementById("supplierDefTbody"),
    fixedCostEntryTbody: document.getElementById("fixedCostEntryTbody"),
    fixedCostEntryForm: document.getElementById("fixedCostEntryForm"),
    fcNewProject: document.getElementById("fcNewProject"),
    fcStart: document.getElementById("fcStart"),
    fcEnd: document.getElementById("fcEnd"),
    fcAmount: document.getElementById("fcAmount"),
    fcNote: document.getElementById("fcNote"),
    invWarehouseFilter: document.getElementById("invWarehouseFilter"),
    inventoryTbody: document.getElementById("inventoryTbody"),
    transferTbody: document.getElementById("transferTbody"),
    adjustTbody: document.getElementById("adjustTbody"),
    filterForm: document.getElementById("filterForm"),
    fStart: document.getElementById("fStart"),
    fEnd: document.getElementById("fEnd"),
    fWarehouse: document.getElementById("fWarehouse"),
    fGroup: document.getElementById("fGroup"),
    resetFilterBtn: document.getElementById("resetFilterBtn"),
    exportMonthBtn: document.getElementById("exportMonthBtn"),
    sumRevenue: document.getElementById("sumRevenue"),
    sumCogs: document.getElementById("sumCogs"),
    sumProfit: document.getElementById("sumProfit"),
    sumMargin: document.getElementById("sumMargin"),
    sumFixedCosts: document.getElementById("sumFixedCosts"),
    profitGroupTbody: document.getElementById("profitGroupTbody"),
    productStatsTbody: document.getElementById("productStatsTbody"),
    trendChart: document.getElementById("trendChart"),
    bestsellerProductTbody: document.getElementById("bestsellerProductTbody"),
  };
  saveState(state);

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
        if (isCloudSyncRiskyBrowser()) {
          const go = confirm(
            "检测到您正在使用「" +
              androidBrowserLabel() +
              "」。\n\n这类浏览器云同步经常失败（能上传但下载不了、或下载后看不到数据）。\n\n强烈建议：安装 Google Chrome，用 Chrome 打开本网站后再做云同步。\n\n仍要继续用当前浏览器试一次吗？"
          );
          if (!go) return;
        }
        const cfg = normalizeCloudConfig(loadCloudConfig() || {});
        const body = `
        <form class="form-grid" onsubmit="return false;">
          <div class="form-group" style="grid-column:span 2"><label>Supabase URL</label><input id="m_url" placeholder="https://xxxx.supabase.co" value="${escapeHtml(cfg.url || "")}"></div>
          <div class="form-group" style="grid-column:span 2"><label>Supabase anon key</label><input id="m_key" placeholder="ey..." value="${escapeHtml(cfg.anonKey || "")}"></div>
          <div class="form-group"><label>Bucket(默认)</label><input id="m_bucket" value="${escapeHtml(cfg.bucket || "lingxin-ims")}"></div>
          <div class="form-group"><label>同步码(建议手机号)</label><input id="m_code" placeholder="例如：13800138000" value="${escapeHtml(cfg.code || "")}"></div>
          <div class="form-group" style="grid-column:span 2"><label>说明</label><input value="同一同步码=同一套数据；填写后会自动记住，下次打开无需重填" disabled></div>
          <div class="form-group"><button type="button" class="lx-btn-secondary" id="m_pull">从云端下载覆盖本机</button></div>
          <div class="form-group"><button type="button" class="lx-btn-secondary" id="m_push">上传本机到云端</button></div>
        </form>
      `;
        openModal("云同步设置", body, async () => {
          const next = buildCloudConfigFromModalInputs();
          if (!next.url || !next.anonKey || !next.code) return alert("请填写 URL、anon key、同步码");
          saveCloudConfig(next);
          alert("已保存云同步配置。请在本弹窗内点击「上传本机到云端」或「从云端下载覆盖本机」。（仅点保存不会上传数据）");
          return false;
        });

        wireCloudModalAutoSave();

        const pullBtn = document.getElementById("m_pull");
        const pushBtn = document.getElementById("m_push");
        if (pullBtn)
          pullBtn.addEventListener("click", async () => {
            try {
              const cfg2 = buildCloudConfigFromModalInputs();
              if (!cfg2.url || !cfg2.anonKey || !cfg2.code) return alert("请填写 URL、anon key、同步码");
              saveCloudConfig(cfg2);
              if (
                !confirm(
                  "即将用云端数据覆盖本机全部进销存（进货、销售、库存、应收、档案等），本机现有数据将被替换，不可撤销。\n\n建议先点顶部「导出备份(JSON)」。\n\n确定继续？"
                )
              )
                return;
              const pulled = await cloudPull(cfg2);
              if (!pulled) return alert("云端暂无数据（请先在另一台设备点「上传本机到云端」）");
              state = pulled;
              await saveStateNow(state);
              fullRender();
              alert("已从云端下载并覆盖本机\n" + cloudDataSummary(state));
            } catch (err) {
              alert(err && err.message ? err.message : String(err));
            }
          });
        if (pushBtn)
          pushBtn.addEventListener("click", async () => {
            try {
              const cfg2 = buildCloudConfigFromModalInputs();
              if (!cfg2.url || !cfg2.anonKey || !cfg2.code) return alert("请填写 URL、anon key、同步码");
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
    fillSelect(els.pWarehouse, whs, null);
    fillSelect(els.sWarehouse, whs, null);
    fillSelect(els.aWarehouse, whs, null);
    fillSelect(els.tFrom, whs, null);
    fillSelect(els.tTo, whs, null);
    fillSelect(els.invWarehouseFilter, whs, "全部仓库");
    fillSelect(els.fWarehouse, whs, "全部仓库");
    if (els.unitList) fillDatalist(els.unitList, unitNamesSorted(state));
    const defaultUnitName = unitNameById(state, defaultUnitId(state));
    [els.pUnit, els.sUnit, els.aUnit, els.tUnit].forEach((el) => {
      if (!el) return;
      if (!String(el.value || "").trim() && defaultUnitName) el.value = defaultUnitName;
    });
    if (els.productList) refreshFilteredDatalist(els.productList, mergedProducts(state), "");
    if (els.customerList) refreshFilteredDatalist(els.customerList, mergedCustomers(state), "");
    if (els.supplierList) refreshFilteredDatalist(els.supplierList, mergedSuppliers(state), "");
  }

  function renderPurchases() {
    const q = els.purchaseSearch.value.trim().toLowerCase();
    const dr = listDateRange(els.purchaseDateStart, els.purchaseDateEnd);
    const rows = filteredPurchaseRows(state, q, dr.start, dr.end);
    const { page, pages, total, slice, pageSize } = paginateWithPager("purchases", rows);
    syncPagerControls("purchases", { page, pages, total, pageSize });
    const allIdSet = new Set(rows.map((r) => r.id));
    els.purchaseTbody.innerHTML = "";
    slice.forEach((p) => {
      const tr = document.createElement("tr");
      const sub = purchaseLineSubtotal(p);
      const checked = purchaseCheckedIds.has(p.id) ? " checked" : "";
      tr.innerHTML = `
        <td data-label="选择"><input type="checkbox" class="h-4 w-4 rounded border-slate-300 text-blue-600" data-pick-p="${escapeHtml(p.id)}"${checked} /></td>
        <td data-label="日期">${p.date}</td>
        <td data-label="仓库">${whName(state, p.warehouseId)}</td>
        <td data-label="供应商">${p.supplier || ""}</td>
        <td data-label="商品">${p.product || ""}</td>
        <td data-label="数量">${formatQtyCell(p.qty, state, p.unitId)}</td>
        <td data-label="单价" class="lx-money">${money(p.price)}</td>
        <td data-label="额外费用" class="lx-money">${formatExtraFeeCell(p.extraFee)}</td>
        <td data-label="小计" class="lx-money">${money(sub)}</td>
        <td data-label="操作" class="text-right">
          <div class="flex flex-wrap justify-end gap-1.5">${lxIconEdit(`data-edit-p="${p.id}"`)}${lxIconDel(`data-del-p="${p.id}"`)}</div>
        </td>`;
      els.purchaseTbody.appendChild(tr);
    });
    const sa = document.getElementById("purchaseSelectAll");
    if (sa) {
      let picked = 0;
      allIdSet.forEach((id) => {
        if (purchaseCheckedIds.has(id)) picked++;
      });
      sa.checked = picked > 0 && picked === allIdSet.size && allIdSet.size > 0;
      sa.indeterminate = picked > 0 && picked < allIdSet.size;
    }
    els.purchaseTbody.querySelectorAll("[data-edit-p]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-edit-p");
        const p = state.purchases.find((x) => x.id === id);
        if (!p) return;
        const body = `
          <form class="form-grid" onsubmit="return false;">
            <div class="form-group"><label>日期</label><input type="date" id="m_date" value="${escapeHtml(p.date)}"></div>
            <div class="form-group"><label>供应商</label><input type="text" id="m_supplier" list="supplierList" autocomplete="off" value="${escapeHtml(p.supplier || "")}"></div>
            <div class="form-group"><label>商品</label><input type="text" id="m_product" list="productList" autocomplete="off" value="${escapeHtml(p.product || "")}"></div>
            <div class="form-group"><label>入库仓库</label><select id="m_warehouse">${optionsHtml(state.warehouses, p.warehouseId)}</select></div>
            <div class="form-group"><label>单位</label><input type="text" id="m_unit" list="unitList" autocomplete="off" value="${escapeHtml(unitNameById(state, p.unitId || defaultUnitId(state)))}"></div>
            <div class="form-group"><label>数量</label><input type="number" id="m_qty" step="0.01" value="${num(p.qty)}"></div>
            <div class="form-group"><label>单价</label><input type="number" id="m_price" step="0.01" value="${num(p.price)}"></div>
            <div class="form-group"><label>额外费用</label><input type="number" id="m_extra_fee" step="0.01" min="0" value="${num(p.extraFee) || ""}" placeholder="选填"></div>
          </form>`;
        openModal("编辑进货", body, () => {
          const next = {
            ...p,
            date: document.getElementById("m_date").value,
            supplier: document.getElementById("m_supplier").value.trim(),
            product: document.getElementById("m_product").value.trim(),
            categoryId: p.categoryId || defaultCategoryId(state),
            warehouseId: document.getElementById("m_warehouse").value,
            unitId: resolveUnitIdFromInput(state, document.getElementById("m_unit").value),
            qty: num(document.getElementById("m_qty").value),
            price: num(document.getElementById("m_price").value),
            extraFee: parseOptionalFee(document.getElementById("m_extra_fee").value),
          };
          if (!next.product) return alert("请填写商品名称");
          ensureMasterDef(state, "supplierDefs", next.supplier);
          upsertProductDef(state, next.product, next.unitId);
          state.purchases = state.purchases.map((x) => (x.id === id ? next : x));
          saveState(state);
          fullRender();
          return true;
        });
        queueMicrotask(() => {
          const mp = document.getElementById("m_product");
          const mu = document.getElementById("m_unit");
          if (mp && mu) {
            mp.addEventListener("input", () => applyResolvedProductUnit(mp, mu));
            mp.addEventListener("change", () => applyResolvedProductUnit(mp, mu));
            applyResolvedProductUnit(mp, mu);
          }
        });
      });
    });
    els.purchaseTbody.querySelectorAll("[data-del-p]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-del-p");
        if (!confirm("删除后无法恢复，并会改变库存与利润统计。\n确定删除这条进货？")) return;
        state.purchases = state.purchases.filter((x) => x.id !== id);
        purchaseCheckedIds.delete(id);
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
    const dr = listDateRange(els.salesDateStart, els.salesDateEnd);
    const rows = filteredSalesRows(state, q, dr.start, dr.end);
    const { page, pages, total, slice, pageSize } = paginateWithPager("sales", rows);
    syncPagerControls("sales", { page, pages, total, pageSize });
    const allIdSet = new Set(rows.map((r) => r.id));
    els.salesTbody.innerHTML = "";
    slice.forEach((s) => {
      const tr = document.createElement("tr");
      const rem = creditRemaining(s);
      const paidTotal = salePaidTotal(s);
      const pay = s.paymentType === "credit" ? "赊账" : "现款";
      const checked = salesCheckedIds.has(s.id) ? " checked" : "";
      tr.innerHTML = `
        <td data-label="选择"><input type="checkbox" class="h-4 w-4 rounded border-slate-300 text-blue-600" data-pick-s="${escapeHtml(s.id)}"${checked} /></td>
        <td data-label="日期">${s.date}</td>
        <td data-label="仓库">${whName(state, s.warehouseId)}</td>
        <td data-label="商品">${s.product || ""}</td>
        <td data-label="付款">${pay}</td>
        <td data-label="客户">${s.customerName || ""}</td>
        <td data-label="数量">${formatQtyCell(s.qty, state, s.unitId)}</td>
        <td data-label="单价" class="lx-money">${money(s.price)}</td>
        <td data-label="额外费用" class="lx-money">${formatExtraFeeCell(s.extraFee)}</td>
        <td data-label="成本" class="lx-money">${money(s.costAtSale)}</td>
        <td data-label="小计" class="lx-money">${money(s.amount)}</td>
        <td data-label="已收合计" class="lx-money">${money(paidTotal)}</td>
        <td data-label="欠款">${rem > 0.0001 ? `<span class="lx-money">${money(rem)}</span>` : "—"}</td>
        <td data-label="买方">${s.buyer || ""}</td>
        <td data-label="操作" class="text-right">
          <div class="flex flex-wrap justify-end gap-1.5">${lxIconEdit(`data-edit-s="${s.id}"`)}${lxIconDel(`data-del-s="${s.id}"`)}</div>
        </td>`;
      els.salesTbody.appendChild(tr);
    });
    const sa = document.getElementById("salesSelectAll");
    if (sa) {
      let picked = 0;
      allIdSet.forEach((id) => {
        if (salesCheckedIds.has(id)) picked++;
      });
      sa.checked = picked > 0 && picked === allIdSet.size && allIdSet.size > 0;
      sa.indeterminate = picked > 0 && picked < allIdSet.size;
    }
    els.salesTbody.querySelectorAll("[data-edit-s]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-edit-s");
        const s = state.sales.find((x) => x.id === id);
        if (!s) return;
        const body = `
          <form class="form-grid" onsubmit="return false;">
            <div class="form-group"><label>日期</label><input type="date" id="m_date" value="${escapeHtml(s.date)}"></div>
            <div class="form-group"><label>商品</label><input type="text" id="m_product" list="productList" autocomplete="off" value="${escapeHtml(s.product || "")}"></div>
            <div class="form-group"><label>出库仓库</label><select id="m_warehouse">${optionsHtml(state.warehouses, s.warehouseId)}</select></div>
            <div class="form-group"><label>单位</label><input type="text" id="m_unit" list="unitList" autocomplete="off" value="${escapeHtml(unitNameById(state, s.unitId || defaultUnitId(state)))}"></div>
            <div class="form-group"><label>数量</label><input type="number" id="m_qty" step="0.01" value="${num(s.qty)}"></div>
            <div class="form-group"><label>单价</label><input type="number" id="m_price" step="0.01" value="${num(s.price)}"></div>
            <div class="form-group"><label>额外费用</label><input type="number" id="m_extra_fee" step="0.01" min="0" value="${num(s.extraFee) || ""}" placeholder="选填"></div>
            <div class="form-group"><label>客户</label><input type="text" id="m_customer" list="customerList" autocomplete="off" value="${escapeHtml(s.customerName || "")}"></div>
            <div class="form-group"><label>当场已收</label><input type="number" id="m_paid" step="0.01" value="${num(s.paidAtSale)}"></div>
            <div class="form-group" style="grid-column:span 2"><label>买方</label><input type="text" id="m_buyer" value="${escapeHtml(s.buyer || "")}"></div>
          </form>`;
        openModal("编辑销售", body, () => {
          const next = {
            ...s,
            date: document.getElementById("m_date").value,
            product: document.getElementById("m_product").value.trim(),
            categoryId: s.categoryId || defaultCategoryId(state),
            warehouseId: document.getElementById("m_warehouse").value,
            unitId: resolveUnitIdFromInput(state, document.getElementById("m_unit").value),
            qty: num(document.getElementById("m_qty").value),
            price: num(document.getElementById("m_price").value),
            extraFee: parseOptionalFee(document.getElementById("m_extra_fee").value),
            customerName: document.getElementById("m_customer").value.trim(),
            paidAtSale: Math.max(0, num(document.getElementById("m_paid").value)),
            buyer: document.getElementById("m_buyer").value.trim(),
          };
          if (!next.product) return alert("请填写商品名称");
          upsertProductDef(state, next.product, next.unitId);
          if (next.customerName) ensureMasterDef(state, "customerDefs", next.customerName);
          next.amount = saleLineSubtotal(next);
          next.paidAtSale = Math.min(next.amount, next.paidAtSale);

          state.sales = state.sales.map((x) => (x.id === id ? next : x));
          saveState(state);
          fullRender();
          return true;
        });
        queueMicrotask(() => {
          const mp = document.getElementById("m_product");
          const mu = document.getElementById("m_unit");
          if (mp && mu) {
            mp.addEventListener("input", () => applyResolvedProductUnit(mp, mu));
            mp.addEventListener("change", () => applyResolvedProductUnit(mp, mu));
            applyResolvedProductUnit(mp, mu);
          }
        });
      });
    });
    els.salesTbody.querySelectorAll("[data-del-s]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-del-s");
        if (!confirm("删除后无法恢复，并会改变库存、应收与利润统计。\n确定删除这条销售？")) return;
        state.sales = state.sales.filter((x) => x.id !== id);
        salesCheckedIds.delete(id);
        saveState(state);
        fullRender();
      });
    });
  }

  function renderReceivables() {
    syncAllComputed(state);
    const arF = readArFilters();
    const hasActiveFilter = !!(arF.date.start || arF.date.end || arF.customer || arF.product);

    const summaryUnpaidRows = state.sales
      .filter((s) => creditRemaining(s) > 0.001 && saleMatchesArFilters(s, arF))
      .sort(
        (a, b) =>
          saleCustLabel(a).localeCompare(saleCustLabel(b), "zh-CN") || cmpDate(a.date, b.date) || String(a.id).localeCompare(String(b.id))
      );
    const smMeta = paginateWithPager("arSummary", summaryUnpaidRows);
    syncPagerControls("arSummary", smMeta);
    els.arSummaryTbody.innerHTML = "";
    if (!summaryUnpaidRows.length) {
      const tr = document.createElement("tr");
      const emptyHint = hasActiveFilter ? "无匹配记录（调整筛选条件）" : "暂无欠款客户";
      tr.innerHTML = `<td colspan="9" class="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">${emptyHint}</td>`;
      els.arSummaryTbody.appendChild(tr);
    } else {
      smMeta.slice.forEach((s) => {
        const tr = document.createElement("tr");
        tr.innerHTML = arUnpaidRowHtml(s);
        els.arSummaryTbody.appendChild(tr);
      });
    }
    bindArPaidCheckboxes(els.arSummaryTbody);

    const paidTbody = document.getElementById("arPaidTbody");
    if (paidTbody) {
      paidTbody.innerHTML = "";
      const paidRows = state.sales
        .filter(
          (s) =>
            creditRemaining(s) <= 0.001 &&
            (num(s.arReceiptAllocated) > 0 || num(s.arManualPaid) > 0 || num(s.paidAtSale) < num(s.amount)) &&
            saleMatchesArFilters(s, arF)
        )
        .sort((a, b) => -cmpDate(a.date, b.date));
      const pdMeta = paginateWithPager("arPaid", paidRows);
      syncPagerControls("arPaid", pdMeta);
      if (!paidRows.length) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="8" class="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">${hasActiveFilter ? "无匹配记录" : "暂无已结清记录"}</td>`;
        paidTbody.appendChild(tr);
      } else {
        pdMeta.slice.forEach((s) => {
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
      }
    }

  }

  function renderFixedCostTables() {
    if (!els.fixedCostEntryTbody) return;

    els.fixedCostEntryTbody.innerHTML = "";
    const fcRows = [...(state.fixedCostEntries || [])].sort(
      (a, b) => -cmpDate(a.startDate, b.startDate) || -cmpDate(a.endDate, b.endDate)
    );
    const fcMeta = paginateWithPager("fixedCosts", fcRows);
    syncPagerControls("fixedCosts", fcMeta);
    fcMeta.slice.forEach((row) => {
        const rid = escapeHtml(row.id);
        const proj = String(row.project || "").trim();
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td data-label="项目"><input type="text" class="lx-input min-w-[96px]" data-fc-inp="project" value="${escapeHtml(proj)}" /></td>
          <td data-label="开始"><input type="date" class="lx-input min-w-[9rem]" data-fc-inp="start" value="${escapeHtml(row.startDate || "")}" /></td>
          <td data-label="结束"><input type="date" class="lx-input min-w-[9rem]" data-fc-inp="end" value="${escapeHtml(row.endDate || "")}" /></td>
          <td data-label="金额"><input type="number" class="lx-input max-w-[120px]" data-fc-inp="amount" min="0.01" step="0.01" value="${num(row.amount)}" /></td>
          <td data-label="备注"><input type="text" class="lx-input min-w-[80px]" data-fc-inp="note" value="${escapeHtml(row.note || "")}" /></td>
          <td data-label="操作" class="text-right">
            <div class="flex flex-wrap justify-end gap-2">
              <button type="button" class="lx-btn-secondary text-xs" data-fc-save="${rid}">保存</button>
              ${lxIconDel(`data-fc-entry-del="${row.id}"`)}
            </div>
          </td>`;
        els.fixedCostEntryTbody.appendChild(tr);
      });
    els.fixedCostEntryTbody.querySelectorAll("[data-fc-save]").forEach((b) => {
      b.addEventListener("click", () => {
        const rowId = b.getAttribute("data-fc-save");
        const tr = b.closest("tr");
        if (!tr) return;
        function g(f) {
          const el = tr.querySelector('[data-fc-inp="' + f + '"]');
          return el ? el.value : "";
        }
        const project = String(g("project") || "").trim();
        const startDate = String(g("start") || "").trim();
        const endDate = String(g("end") || "").trim();
        const amount = num(g("amount"));
        const note = String(g("note") || "").trim();
        if (!project) return alert("请填写项目（如房租、水电）");
        if (!startDate || !endDate) return alert("请选择开始与结束日期");
        if (isoDayCompare(startDate, endDate) > 0) return alert("结束日期不能早于开始日期");
        if (amount <= 0) return alert("金额须大于 0");
        state.fixedCostEntries = (state.fixedCostEntries || []).map((x) =>
          x.id === rowId ? { ...x, project, startDate, endDate, amount, note } : x
        );
        saveState(state);
        fullRender();
      });
    });
    els.fixedCostEntryTbody.querySelectorAll("[data-fc-entry-del]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-fc-entry-del");
        if (!confirm("确定删除该条固定成本？")) return;
        state.fixedCostEntries = (state.fixedCostEntries || []).filter((x) => x.id !== id);
        saveState(state);
        fullRender();
      });
    });
  }

  function renderMasterDataTables() {
    if (!els.productDefTbody || !els.customerDefTbody || !els.supplierDefTbody) return;

    els.productDefTbody.innerHTML = "";
    const pdRows = [...(state.productDefs || [])];
    const pdMeta = paginateWithPager("productDefs", pdRows);
    syncPagerControls("productDefs", pdMeta);
    pdMeta.slice.forEach((it) => {
      const tr = document.createElement("tr");
      const uPick = it.unitId || defaultUnitId(state);
      tr.innerHTML = `
        <td data-label="商品">${escapeHtml(it.name)}</td>
        <td data-label="单位"><select class="lx-input max-w-[160px]" data-pd-unit="${escapeHtml(it.id)}">${optionsHtml(state.units || [], uPick)}</select></td>
        <td data-label="重命名商品"><input type="text" class="lx-input max-w-[200px]" data-pd-rename="${escapeHtml(it.id)}" placeholder="新名称" /></td>
        <td data-label="操作" class="text-right">
          <div class="flex flex-wrap justify-end gap-2">
            <button type="button" class="lx-btn-secondary text-xs" data-pd-apply="${escapeHtml(it.id)}">保存名称</button>
            ${lxIconDel(`data-pd-del="${it.id}"`)}
          </div>
        </td>`;
      els.productDefTbody.appendChild(tr);
    });
    els.productDefTbody.querySelectorAll("[data-pd-unit]").forEach((sel) => {
      sel.addEventListener("change", () => {
        const id = sel.getAttribute("data-pd-unit");
        const uId = sel.value || defaultUnitId(state);
        state.productDefs = state.productDefs.map((x) => (x.id === id ? { ...x, unitId: uId } : x));
        saveState(state);
        fullRender();
      });
    });
    els.productDefTbody.querySelectorAll("[data-pd-apply]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-pd-apply");
        const inp = els.productDefTbody.querySelector('[data-pd-rename="' + id + '"]');
        const newName = String(inp.value || "").trim();
        if (!newName) return alert("名称不能为空");
        if (defNameTaken(state, "productDefs", newName, id)) return alert("名称已存在");
        const cur = state.productDefs.find((x) => x.id === id);
        if (!cur) return;
        renameProductNameEverywhere(state, cur.name, newName);
        state.productDefs = state.productDefs.map((x) => (x.id === id ? { ...x, name: newName } : x));
        saveState(state);
        fullRender();
      });
    });
    els.productDefTbody.querySelectorAll("[data-pd-del]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-pd-del");
        const cur = state.productDefs.find((x) => x.id === id);
        if (!cur) return;
        if (productNameReferenced(state, cur.name)) return alert("该商品在单据中仍有使用，无法删除。");
        if (!confirm("确定从档案中删除该商品？")) return;
        state.productDefs = state.productDefs.filter((x) => x.id !== id);
        saveState(state);
        fullRender();
      });
    });

    els.customerDefTbody.innerHTML = "";
    const cdRows = [...(state.customerDefs || [])];
    const cdMeta = paginateWithPager("customerDefs", cdRows);
    syncPagerControls("customerDefs", cdMeta);
    cdMeta.slice.forEach((it) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td data-label="客户名">${escapeHtml(it.name)}</td>
        <td data-label="重命名"><input type="text" class="lx-input max-w-[200px]" data-cd-rename="${escapeHtml(it.id)}" placeholder="新名称" /></td>
        <td data-label="操作" class="text-right">
          <div class="flex flex-wrap justify-end gap-2">
            <button type="button" class="lx-btn-secondary text-xs" data-cd-apply="${escapeHtml(it.id)}">保存名称</button>
            ${lxIconDel(`data-cd-del="${it.id}"`)}
          </div>
        </td>`;
      els.customerDefTbody.appendChild(tr);
    });
    els.customerDefTbody.querySelectorAll("[data-cd-apply]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-cd-apply");
        const inp = els.customerDefTbody.querySelector('[data-cd-rename="' + id + '"]');
        const newName = String(inp.value || "").trim();
        if (!newName) return alert("名称不能为空");
        if (defNameTaken(state, "customerDefs", newName, id)) return alert("名称已存在");
        const cur = state.customerDefs.find((x) => x.id === id);
        if (!cur) return;
        renameCustomerNameEverywhere(state, cur.name, newName);
        state.customerDefs = state.customerDefs.map((x) => (x.id === id ? { ...x, name: newName } : x));
        saveState(state);
        fullRender();
      });
    });
    els.customerDefTbody.querySelectorAll("[data-cd-del]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-cd-del");
        const cur = state.customerDefs.find((x) => x.id === id);
        if (!cur) return;
        if (customerNameReferenced(state, cur.name)) return alert("该客户在单据中仍有使用，无法删除。");
        if (!confirm("确定从档案中删除该客户？")) return;
        state.customerDefs = state.customerDefs.filter((x) => x.id !== id);
        saveState(state);
        fullRender();
      });
    });

    els.supplierDefTbody.innerHTML = "";
    const sdRows = [...(state.supplierDefs || [])];
    const sdMeta = paginateWithPager("supplierDefs", sdRows);
    syncPagerControls("supplierDefs", sdMeta);
    sdMeta.slice.forEach((it) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td data-label="供应商名">${escapeHtml(it.name)}</td>
        <td data-label="重命名"><input type="text" class="lx-input max-w-[200px]" data-sd-rename="${escapeHtml(it.id)}" placeholder="新名称" /></td>
        <td data-label="操作" class="text-right">
          <div class="flex flex-wrap justify-end gap-2">
            <button type="button" class="lx-btn-secondary text-xs" data-sd-apply="${escapeHtml(it.id)}">保存名称</button>
            ${lxIconDel(`data-sd-del="${it.id}"`)}
          </div>
        </td>`;
      els.supplierDefTbody.appendChild(tr);
    });
    els.supplierDefTbody.querySelectorAll("[data-sd-apply]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-sd-apply");
        const inp = els.supplierDefTbody.querySelector('[data-sd-rename="' + id + '"]');
        const newName = String(inp.value || "").trim();
        if (!newName) return alert("名称不能为空");
        if (defNameTaken(state, "supplierDefs", newName, id)) return alert("名称已存在");
        const cur = state.supplierDefs.find((x) => x.id === id);
        if (!cur) return;
        renameSupplierNameEverywhere(state, cur.name, newName);
        state.supplierDefs = state.supplierDefs.map((x) => (x.id === id ? { ...x, name: newName } : x));
        saveState(state);
        fullRender();
      });
    });
    els.supplierDefTbody.querySelectorAll("[data-sd-del]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-sd-del");
        const cur = state.supplierDefs.find((x) => x.id === id);
        if (!cur) return;
        if (supplierNameReferenced(state, cur.name)) return alert("该供应商在单据中仍有使用，无法删除。");
        if (!confirm("确定从档案中删除该供应商？")) return;
        state.supplierDefs = state.supplierDefs.filter((x) => x.id !== id);
        saveState(state);
        fullRender();
      });
    });
  }

  function renderInventory() {
    syncAllComputed(state);
    const { inv } = buildLedger(state);
    const whF = els.invWarehouseFilter.value;
    els.inventoryTbody.innerHTML = "";
    const invRows = [];
    const keys = Array.from(inv.keys()).sort();
    keys.forEach((k) => {
      const [whId, prod] = k.split("|||");
      if (whF && whId !== whF) return;
      const c = inv.get(k);
      if (Math.abs(num(c.qty)) < 0.0001 && Math.abs(num(c.totalCost)) < 0.0001) return;
      invRows.push({ whId, prod, c });
    });
    const invMeta = paginateWithPager("inventory", invRows);
    syncPagerControls("inventory", invMeta);
    invMeta.slice.forEach(({ whId, prod, c }) => {
      const tr = document.createElement("tr");
      const avg = avgUnit(c);
      tr.innerHTML = `
        <td data-label="仓库">${whName(state, whId)}</td>
        <td data-label="商品">${prod}</td>
        <td data-label="库存数量">${formatQtyCell(c.qty, state, state.units[0].id)}</td>
        <td data-label="库存均价" class="lx-money">${money(avg)}</td>
        <td data-label="库存成本" class="lx-money">${money(c.totalCost)}</td>`;
      els.inventoryTbody.appendChild(tr);
    });

    els.transferTbody.innerHTML = "";
    const transferRows = [...state.transfers].sort((a, b) => -cmpDate(a.date, b.date));
    const trMeta = paginateWithPager("transfers", transferRows);
    syncPagerControls("transfers", trMeta);
    trMeta.slice.forEach((t) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
          <td data-label="日期">${t.date}</td>
          <td data-label="商品">${t.product}</td>
          <td data-label="数量">${formatQtyCell(t.qty, state, t.unitId)}</td>
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
    const adjustRows = [...state.adjustments].sort((a, b) => -cmpDate(a.date, b.date));
    const adjMeta = paginateWithPager("adjustments", adjustRows);
    syncPagerControls("adjustments", adjMeta);
    adjMeta.slice.forEach((a) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
          <td data-label="日期">${a.date}</td>
          <td data-label="仓库">${whName(state, a.warehouseId)}</td>
          <td data-label="商品">${a.product}</td>
          <td data-label="调整数量">${formatQtyCell(a.qty, state, a.unitId)}</td>
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
    const warehouseRows = [...state.warehouses];
    const whMeta = paginateWithPager("warehouses", warehouseRows);
    syncPagerControls("warehouses", whMeta);
    whMeta.slice.forEach((w) => {
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
    renderMasterDataTables();
    renderFixedCostTables();
  }

  function renderAnalytics() {
    syncAllComputed(state);
    const start = els.fStart.value || "";
    const end = els.fEnd.value || "";
    const wh = els.fWarehouse.value || "";
    const { purchases: fp, sales: fs } = filterRows(state, start, end, wh);

    const revenue = fs.reduce((a, s) => a + num(s.amount), 0);
    const cogs = fs.reduce((a, s) => a + num(s.costAtSale), 0);
    const fixedTotal = totalFixedCostForFilter(state, start, end);
    const profit = revenue - cogs - fixedTotal;
    const margin = revenue > 0 ? (100 * profit) / revenue : 0;
    els.sumRevenue.textContent = money(revenue);
    els.sumCogs.textContent = money(cogs);
    if (els.sumFixedCosts) els.sumFixedCosts.textContent = money(fixedTotal);
    els.sumProfit.textContent = money(profit);
    els.sumMargin.textContent = margin.toFixed(2) + "%";

    const groupMode = els.fGroup.value || "day";
    const map = new Map();
    function keyFor(date) {
      if (groupMode === "week") return weekKey(date);
      if (groupMode === "month") return monthKey(date);
      if (groupMode === "quarter") return quarterKey(date);
      if (groupMode === "year") return yearKey(date);
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
      o.expense = (o.expense || 0) + purchaseLineSubtotal(p);
      map.set(k, o);
    });

    const fixedByKey = fixedCostByPeriodKey(state, start, end, groupMode, fs, fp);
    fixedByKey.forEach((amt, k) => {
      if (!map.has(k)) map.set(k, { revenue: 0, cogs: 0, expense: 0 });
    });

    const keys = Array.from(new Set([...map.keys(), ...fixedByKey.keys()])).sort();
    const pgMeta = paginateWithPager("profitGroup", keys);
    syncPagerControls("profitGroup", pgMeta);
    els.profitGroupTbody.innerHTML = "";
    pgMeta.slice.forEach((k) => {
      const o = map.get(k) || { revenue: 0, cogs: 0, expense: 0 };
      const rev = num(o.revenue);
      const cg = num(o.cogs);
      const fx = num(fixedByKey.get(k) || 0);
      const prof = rev - cg - fx;
      const mar = rev > 0 ? (100 * prof) / rev : 0;
      const tr = document.createElement("tr");
      tr.innerHTML = `<td data-label="周期">${k}</td><td data-label="销售额" class="lx-money">${money(rev)}</td><td data-label="销售成本" class="lx-money">${money(
        cg
      )}</td><td data-label="固定成本" class="lx-money">${money(fx)}</td><td data-label="利润" class="lx-money">${money(prof)}</td><td data-label="利润率">${mar.toFixed(
        2
      )}%</td>`;
      els.profitGroupTbody.appendChild(tr);
    });

    const revA = keys.map((k) => num((map.get(k) || {}).revenue));
    const expA = keys.map((k) => num((map.get(k) || {}).expense || 0) + num(fixedByKey.get(k) || 0));
    const profA = keys.map((k) => num((map.get(k) || {}).revenue) - num((map.get(k) || {}).cogs) - num(fixedByKey.get(k) || 0));
    drawTrendChart(els.trendChart, keys, revA, expA, profA);

    const prodMap = new Map();
    fs.forEach((s) => {
      const k = productKey(s.product);
      if (!k) return;
      const o = prodMap.get(k) || { product: s.product, qtySold: 0, revenue: 0, cogs: 0 };
      o.qtySold += num(s.qty);
      o.revenue += num(s.amount);
      o.cogs += num(s.costAtSale);
      prodMap.set(k, o);
    });
    fp.forEach((p) => {
      const k = productKey(p.product);
      if (!k) return;
      const o = prodMap.get(k) || { product: p.product, qtyIn: 0, qtySold: 0, revenue: 0, cogs: 0 };
      o.qtyIn = (o.qtyIn || 0) + num(p.qty);
      prodMap.set(k, o);
    });
    els.productStatsTbody.innerHTML = "";
    const prodStatRows = Array.from(prodMap.values()).sort((a, b) => b.revenue - a.revenue);
    const psMeta = paginateWithPager("productStats", prodStatRows);
    syncPagerControls("productStats", psMeta);
    psMeta.slice.forEach((o) => {
      const prof = o.revenue - o.cogs;
      const mar = o.revenue > 0 ? (100 * prof) / o.revenue : 0;
      const tr = document.createElement("tr");
      tr.innerHTML = `
          <td data-label="商品">${o.product}</td>
          <td data-label="进货量">${formatQtyCell(o.qtyIn || 0, state, state.units[0].id)}</td>
          <td data-label="销售量">${formatQtyCell(o.qtySold, state, state.units[0].id)}</td>
          <td data-label="销售额" class="lx-money">${money(o.revenue)}</td>
          <td data-label="销售成本" class="lx-money">${money(o.cogs)}</td>
          <td data-label="利润" class="lx-money">${money(prof)}</td>
          <td data-label="利润率">${mar.toFixed(2)}%</td>`;
      els.productStatsTbody.appendChild(tr);
    });

    if (els.bestsellerProductTbody) {
      const { sales: fsRank } = filterRows(state, start, end, wh);

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
      const bsMeta = paginateWithPager("bestseller", prodRows);
      syncPagerControls("bestseller", bsMeta);
      els.bestsellerProductTbody.innerHTML = "";
      const rank0 = (bsMeta.page - 1) * bsMeta.pageSize;
      bsMeta.slice.forEach((o, idx) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td data-label="名次">${rank0 + idx + 1}</td><td data-label="商品">${escapeHtml(o.label)}</td><td data-label="销售数量">${formatQtyCell(
          o.qty,
          state,
          state.units[0].id
        )}</td><td data-label="销售额" class="lx-money">${money(o.rev)}</td>`;
        els.bestsellerProductTbody.appendChild(tr);
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
  els.aDate.value = todayISO();
  els.tDate.value = todayISO();

  els.purchaseForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const row = {
      id: uid(),
      date: els.pDate.value,
      supplier: els.pSupplier.value.trim(),
      product: els.pProduct.value.trim(),
      categoryId: defaultCategoryId(state),
      warehouseId: els.pWarehouse.value,
      unitId: resolveUnitIdFromInput(state, els.pUnit && els.pUnit.value),
      qty: num(els.pQty.value),
      price: num(els.pPrice.value),
      extraFee: parseOptionalFee(els.pExtraFee && els.pExtraFee.value),
    };
    if (!row.product) return alert("请填写商品名称");
    ensureMasterDef(state, "supplierDefs", row.supplier);
    upsertProductDef(state, row.product, row.unitId);
    state.purchases.push(row);
    saveState(state);
    els.pSupplier.value = "";
    els.pProduct.value = "";
    els.pQty.value = "";
    els.pPrice.value = "";
    if (els.pExtraFee) els.pExtraFee.value = "";
    fullRender();
  });

  function salesFormLineAmount() {
    return +(
      num(els.sQty?.value) * num(els.sPrice?.value) + parseOptionalFee(els.sExtraFee && els.sExtraFee.value)
    ).toFixed(2);
  }

  function syncSalesPaidNowIfCash() {
    if (!els.sPaymentType || els.sPaymentType.value !== "cash" || !els.sPaidNow) return;
    els.sPaidNow.value = String(salesFormLineAmount());
  }

  ["input", "change"].forEach((ev) => {
    els.sQty?.addEventListener(ev, syncSalesPaidNowIfCash);
    els.sPrice?.addEventListener(ev, syncSalesPaidNowIfCash);
    els.sExtraFee?.addEventListener(ev, syncSalesPaidNowIfCash);
  });

  els.salesForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const paymentType = els.sPaymentType.value === "credit" ? "credit" : "cash";
    const customerName = els.sCustomer.value.trim();
    const paidNow = num(els.sPaidNow.value);
    const qty = num(els.sQty.value);
    const price = num(els.sPrice.value);
    const extraFee = parseOptionalFee(els.sExtraFee && els.sExtraFee.value);
    const amount = +(qty * price + extraFee).toFixed(2);
    if (paymentType === "credit" && !customerName) return alert("赊账必须填写客户");
    const paidAtSale =
      paymentType === "cash"
        ? Math.min(amount, paidNow > 0 ? paidNow : amount)
        : Math.min(amount, Math.max(0, paidNow));

    const wh = els.sWarehouse.value;
    const prod = els.sProduct.value.trim();
    const row = {
      id: uid(),
      date: els.sDate.value,
      product: prod,
      categoryId: defaultCategoryId(state),
      warehouseId: wh,
      unitId: resolveUnitIdFromInput(state, els.sUnit && els.sUnit.value),
      qty,
      price,
      extraFee,
      amount,
      buyer: els.sBuyer.value.trim(),
      paymentType,
      customerName,
      paidAtSale,
      arReceiptAllocated: 0,
    };
    upsertProductDef(state, prod, row.unitId);
    if (customerName) ensureMasterDef(state, "customerDefs", customerName);
    state.sales.push(row);
    saveState(state);
    els.sProduct.value = "";
    els.sQty.value = "";
    els.sPrice.value = "";
    if (els.sExtraFee) els.sExtraFee.value = "";
    els.sPaidNow.value = "0";
    els.sCustomer.value = "";
    els.sBuyer.value = "";
    fullRender();
  });

  function bumpArFilters() {
    ["arSummary", "arPaid"].forEach((k) => {
      ensureListPager(k).page = 1;
    });
    renderReceivables();
  }

  if (els.arCustomerFilter) els.arCustomerFilter.addEventListener("input", bumpArFilters);
  if (els.arProductFilter) els.arProductFilter.addEventListener("input", bumpArFilters);
  if (els.arFilterClear) {
    els.arFilterClear.addEventListener("click", () => {
      if (els.arDateStart) els.arDateStart.value = "";
      if (els.arDateEnd) els.arDateEnd.value = "";
      if (els.arCustomerFilter) els.arCustomerFilter.value = "";
      if (els.arProductFilter) els.arProductFilter.value = "";
      bumpArFilters();
    });
  }

  els.adjustForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const row = {
      id: uid(),
      date: els.aDate.value,
      warehouseId: els.aWarehouse.value,
      product: els.aProduct.value.trim(),
      unitId: resolveUnitIdFromInput(state, els.aUnit && els.aUnit.value),
      qty: num(els.aQty.value),
      reason: els.aReason.value.trim(),
    };
    if (!row.product) return alert("请填写商品");
    if (!row.reason) return alert("请填写原因");
    upsertProductDef(state, row.product, row.unitId);
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
    const tUnitId = resolveUnitIdFromInput(state, els.tUnit && els.tUnit.value);
    upsertProductDef(state, prod, tUnitId);
    state.transfers.push({
      id: uid(),
      date: els.tDate.value,
      product: prod,
      unitId: tUnitId,
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

  if (els.productDefForm) {
    els.productDefForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = String(els.newProductDef.value || "").trim();
      if (!name) return;
      if (defNameTaken(state, "productDefs", name)) return alert("该商品已在档案中");
      const unitText = els.newProductDefUnitName ? String(els.newProductDefUnitName.value || "").trim() : "";
      const uId = ensureUnitByName(state, unitText);
      state.productDefs.push({ id: uid(), name, unitId: uId });
      saveState(state);
      els.newProductDef.value = "";
      if (els.newProductDefUnitName) els.newProductDefUnitName.value = "";
      fullRender();
    });
  }
  if (els.customerDefForm) {
    els.customerDefForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = String(els.newCustomerDef.value || "").trim();
      if (!name) return;
      if (defNameTaken(state, "customerDefs", name)) return alert("该客户已在档案中");
      state.customerDefs.push({ id: uid(), name });
      saveState(state);
      els.newCustomerDef.value = "";
      fullRender();
    });
  }
  if (els.supplierDefForm) {
    els.supplierDefForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = String(els.newSupplierDef.value || "").trim();
      if (!name) return;
      if (defNameTaken(state, "supplierDefs", name)) return alert("该供应商已在档案中");
      state.supplierDefs.push({ id: uid(), name });
      saveState(state);
      els.newSupplierDef.value = "";
      fullRender();
    });
  }

  if (els.fixedCostEntryForm) {
    els.fixedCostEntryForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const project = els.fcNewProject ? String(els.fcNewProject.value || "").trim() : "";
      const startDate = els.fcStart && els.fcStart.value;
      const endDate = els.fcEnd && els.fcEnd.value;
      const amount = num(els.fcAmount && els.fcAmount.value);
      const note = els.fcNote ? String(els.fcNote.value || "").trim() : "";
      if (!project) return alert("请填写项目（如房租、水电）");
      if (!startDate || !endDate) return alert("请选择开始与结束日期");
      if (isoDayCompare(startDate, endDate) > 0) return alert("结束日期不能早于开始日期");
      if (amount <= 0) return alert("金额须大于 0");
      if (!Array.isArray(state.fixedCostEntries)) state.fixedCostEntries = [];
      state.fixedCostEntries.push({ id: uid(), project, startDate, endDate, amount, note });
      saveState(state);
      if (els.fcNewProject) els.fcNewProject.value = "";
      els.fcAmount.value = "";
      if (els.fcNote) els.fcNote.value = "";
      fullRender();
    });
  }

  const tabPurchase = document.getElementById("tab-purchase");
  if (tabPurchase) {
    tabPurchase.addEventListener("click", (e) => {
      const t = e.target;
      if (!t || !t.id) return;
      if (t.id === "purchaseBatchDelBtn") {
        if (purchaseCheckedIds.size === 0) return alert("请先勾选要删除的进货单");
        if (
          !confirmTypedPhrase(
            "将永久删除已选的 " + purchaseCheckedIds.size + " 条进货，库存与统计会重算，不可恢复。",
            "确认批量删除进货"
          )
        )
          return;
        state.purchases = state.purchases.filter((p) => !purchaseCheckedIds.has(p.id));
        purchaseCheckedIds.clear();
        saveState(state);
        fullRender();
      }
    });
    tabPurchase.addEventListener("change", (e) => {
      const t = e.target;
      if (!t) return;
      if (t.id === "purchaseSelectAll") {
        const dr = listDateRange(els.purchaseDateStart, els.purchaseDateEnd);
        const rows = filteredPurchaseRows(state, els.purchaseSearch.value.trim().toLowerCase(), dr.start, dr.end);
        if (t.checked) rows.forEach((p) => purchaseCheckedIds.add(p.id));
        else rows.forEach((p) => purchaseCheckedIds.delete(p.id));
        renderPurchases();
      } else if (t.matches && t.matches("input[data-pick-p]")) {
        const id = t.getAttribute("data-pick-p");
        if (t.checked) purchaseCheckedIds.add(id);
        else purchaseCheckedIds.delete(id);
        renderPurchases();
      }
    });
  }

  const tabSales = document.getElementById("tab-sales");
  if (tabSales) {
    tabSales.addEventListener("click", (e) => {
      const t = e.target;
      if (!t || !t.id) return;
      if (t.id === "salesBatchDelBtn") {
        if (salesCheckedIds.size === 0) return alert("请先勾选要删除的销售单");
        if (
          !confirmTypedPhrase(
            "将永久删除已选的 " + salesCheckedIds.size + " 条销售，应收与库存会重算，不可恢复。",
            "确认批量删除销售"
          )
        )
          return;
        state.sales = state.sales.filter((s) => !salesCheckedIds.has(s.id));
        salesCheckedIds.clear();
        saveState(state);
        fullRender();
      }
    });
    tabSales.addEventListener("change", (e) => {
      const t = e.target;
      if (!t) return;
      if (t.id === "salesSelectAll") {
        const dr = listDateRange(els.salesDateStart, els.salesDateEnd);
        const rows = filteredSalesRows(state, els.salesSearch.value.trim().toLowerCase(), dr.start, dr.end);
        if (t.checked) rows.forEach((s) => salesCheckedIds.add(s.id));
        else rows.forEach((s) => salesCheckedIds.delete(s.id));
        renderSales();
      } else if (t.matches && t.matches("input[data-pick-s]")) {
        const id = t.getAttribute("data-pick-s");
        if (t.checked) salesCheckedIds.add(id);
        else salesCheckedIds.delete(id);
        renderSales();
      }
    });
  }

  const tabReceivables = document.getElementById("tab-receivables");
  if (tabReceivables) {
    tabReceivables.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest && e.target.closest("[data-ar-settle-customer-key]");
      if (!btn) return;
      const enc = btn.getAttribute("data-ar-settle-customer-key");
      if (enc == null || enc === "") return;
      settleCustomerAr(enc);
    });
    tabReceivables.addEventListener("change", (e) => {
      const inp = e.target;
      if (inp && inp.matches && inp.matches("[data-ar-paid-at-sale]")) {
        applyPaidAtSaleEdit(inp.getAttribute("data-ar-paid-at-sale"), inp.value);
      }
    });
  }

  document.addEventListener("change", (e) => {
    const sel = e.target;
    if (!sel || !sel.matches || !sel.matches("select.lx-list-page-size[data-list-pager-key]")) return;
    const key = sel.getAttribute("data-list-pager-key");
    if (!key || !PAGER_UI[key]) return;
    const pg = ensureListPager(key);
    pg.size = coerceListPageSize(sel.value);
    pg.page = 1;
    persistListPageSize(key);
    rerenderForListPagerKey(key);
  });

  document.addEventListener("click", (e) => {
    const pbtn = e.target && e.target.closest && e.target.closest("[data-list-pager-dir]");
    if (pbtn) {
      const key = pbtn.getAttribute("data-list-pager-key");
      const dir = pbtn.getAttribute("data-list-pager-dir");
      if (!key || !PAGER_UI[key]) return;
      const pg = ensureListPager(key);
      if (dir === "prev") pg.page = Math.max(1, pg.page - 1);
      else if (dir === "next") pg.page = pg.page + 1;
      rerenderForListPagerKey(key);
      return;
    }
    const btn = e.target && e.target.closest && e.target.closest("[data-export-module]");
    if (!btn) return;
    const mod = btn.getAttribute("data-export-module");
    try {
      exportModuleWorkbook(mod);
    } catch (err) {
      alert(err && err.message ? err.message : String(err));
    }
  });

  function wireMainFormProductUnits() {
    const pairs = [
      [els.pProduct, els.pUnit],
      [els.sProduct, els.sUnit],
      [els.aProduct, els.aUnit],
      [els.tProduct, els.tUnit],
    ];
    pairs.forEach(([inp, unitField]) => {
      if (!inp || !unitField) return;
      inp.addEventListener("input", () => applyResolvedProductUnit(inp, unitField));
      inp.addEventListener("change", () => applyResolvedProductUnit(inp, unitField));
    });
  }
  wireMainFormProductUnits();

  function wireListDateFilter(opts) {
    const { startEl, endEl, clearBtn, pagerKey, onRender } = opts;
    const bump = () => {
      if (pagerKey) ensureListPager(pagerKey).page = 1;
      onRender();
    };
    if (startEl) startEl.addEventListener("change", bump);
    if (endEl) endEl.addEventListener("change", bump);
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        if (startEl) startEl.value = "";
        if (endEl) endEl.value = "";
        bump();
      });
    }
  }

  wireListDateFilter({
    startEl: els.purchaseDateStart,
    endEl: els.purchaseDateEnd,
    clearBtn: els.purchaseDateClear,
    pagerKey: "purchases",
    onRender: () => {
      purchaseCheckedIds.clear();
      renderPurchases();
    },
  });
  wireListDateFilter({
    startEl: els.salesDateStart,
    endEl: els.salesDateEnd,
    clearBtn: els.salesDateClear,
    pagerKey: "sales",
    onRender: () => {
      salesCheckedIds.clear();
      renderSales();
    },
  });
  wireListDateFilter({
    startEl: els.arDateStart,
    endEl: els.arDateEnd,
    clearBtn: null,
    pagerKey: "arSummary",
    onRender: () => bumpArFilters(),
  });

  els.purchaseSearch.addEventListener("input", () => {
    ensureListPager("purchases").page = 1;
    purchaseCheckedIds.clear();
    renderPurchases();
  });
  els.salesSearch.addEventListener("input", () => {
    ensureListPager("sales").page = 1;
    salesCheckedIds.clear();
    renderSales();
  });
  els.invWarehouseFilter.addEventListener("change", () => {
    ensureListPager("inventory").page = 1;
    renderInventory();
  });

  els.filterForm.addEventListener("submit", (e) => {
    e.preventDefault();
    resetAnalyticsListPagers();
    renderAnalytics();
  });
  if (els.fGroup) {
    els.fGroup.addEventListener("change", () => {
      resetAnalyticsListPagers();
      renderAnalytics();
    });
  }
  els.resetFilterBtn.addEventListener("click", () => {
    resetAnalyticsFilters();
  });

  if (els.fStart) els.fStart.addEventListener("change", () => { resetAnalyticsListPagers(); renderAnalytics(); });
  if (els.fEnd) els.fEnd.addEventListener("change", () => { resetAnalyticsListPagers(); renderAnalytics(); });
  if (els.fWarehouse) els.fWarehouse.addEventListener("change", () => { resetAnalyticsListPagers(); renderAnalytics(); });

  els.exportMonthBtn.addEventListener("click", () => {
    const y = new Date().getFullYear();
    const m = String(new Date().getMonth() + 1).padStart(2, "0");
    const start = y + "-" + m + "-01";
    const end = y + "-" + m + "-31";
    const rows = [];
    state.purchases
      .filter((p) => p.date >= start && p.date <= end)
      .forEach((p) =>
        rows.push(["进货", p.date, whName(state, p.warehouseId), p.supplier, p.product, formatQtyCell(p.qty, state, p.unitId), p.price])
      );
    state.sales
      .filter((s) => s.date >= start && s.date <= end)
      .forEach((s) =>
        rows.push(["销售", s.date, whName(state, s.warehouseId), s.buyer, s.product, formatQtyCell(s.qty, state, s.unitId), s.price])
      );
    const esc = (x) => '"' + String(x == null ? "" : x).replace(/"/g, '""') + '"';
    const csv = ["类型,日期,仓库/买方,对方,商品,数量,单价"]
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
    r.onload = async () => {
      try {
        if (
          !confirmTypedPhrase(
            "导入 JSON 将用文件中的数据覆盖本机当前全部进销存数据，不可撤销。\n建议先导出备份再操作。\n\n确定后请在下一步输入确认语。",
            "确认覆盖"
          )
        ) {
          els.backupFileInput.value = "";
          return;
        }
        state = await importBackup(String(r.result));
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
    if (!cr) syncSalesPaidNowIfCash();
  });
  els.sPaymentType.dispatchEvent(new Event("change"));

  bindSuggestDelegation();

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-clear]");
    if (!btn) return;
    const k = btn.getAttribute("data-clear");
    if (k === "analyticsFilters") resetAnalyticsFilters();
    else if (k === "purchases") clearAllPurchases();
    else if (k === "sales") clearAllSales();
    else if (k === "transfers") clearAllTransfers();
    else if (k === "adjustments") clearAllAdjustments();
    else if (k === "warehouses") clearWarehousesExceptFirst();
    else if (k === "productsUnits") clearProductDefsAndResetUnits();
    else if (k === "customers") clearCustomerDefsOnly();
    else if (k === "suppliers") clearSupplierDefsOnly();
    else if (k === "fixedCosts") clearFixedCostEntriesOnly();
  });

  refreshReceivables = renderReceivables;
  rerenderForListPagerKey = function (key) {
    if (key === "purchases") renderPurchases();
    else if (key === "sales") renderSales();
    else if (key === "arSummary" || key === "arPaid") renderReceivables();
    else if (key === "inventory" || key === "transfers" || key === "adjustments" || key === "warehouses") renderInventory();
    else if (key === "productDefs" || key === "customerDefs" || key === "supplierDefs") renderInventory();
    else if (key === "fixedCosts") renderInventory();
    else if (key === "profitGroup" || key === "productStats" || key === "bestseller") renderAnalytics();
  };
  fullRender();
  maybeBackupReminder();
  }

  function showBootLoading(msg) {
    let el = document.getElementById("lx-boot-loading");
    if (!el) {
      el = document.createElement("div");
      el.id = "lx-boot-loading";
      el.className =
        "fixed inset-0 z-[10000] flex items-center justify-center bg-slate-100/90 text-slate-700 dark:bg-slate-950/90 dark:text-slate-200";
      document.body.appendChild(el);
    }
    el.textContent = msg || "正在加载数据…";
    el.style.display = "flex";
  }

  function hideBootLoading() {
    const el = document.getElementById("lx-boot-loading");
    if (el) el.style.display = "none";
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushStateToIdb();
  });

  window.addEventListener("pagehide", () => {
    flushStateToIdb();
  });

  showBootLoading("正在加载数据…");
  loadAppState()
    .then((s) => {
      state = s;
      bootApp();
      hideBootLoading();
    })
    .catch((err) => {
      console.error(err);
      try {
        state = migrateIfNeeded(loadRawFromLocalStorage());
      } catch (e2) {
        state = defaultState();
      }
      alert(
        "IndexedDB 加载失败，已尝试从浏览器旧缓存（localStorage）恢复。\n\n" +
          (err && err.message ? err.message : String(err))
      );
      bootApp();
      hideBootLoading();
    });
})();
