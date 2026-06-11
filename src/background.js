import { installLogCapture, clearLogBuffer } from "./logger.js";
installLogCapture();

import { syncSoFi, getSoFiAccountsForPopup } from "./banks/sofi.js";
import { syncVenmo } from "./banks/venmo.js";
import { syncBilt } from "./banks/bilt.js";
import { syncCapitalOne, getCapitalOneAccountsForPopup } from "./banks/capitalone.js";
import { syncFidelity } from "./banks/fidelity.js";
import { syncTarget } from "./banks/target.js";
import { syncUSBank, getUSBankAccountsForPopup } from "./banks/usbank.js";
import { syncWellsFargo, getWellsFargoAccountsForPopup } from "./banks/wellsfargo.js";
import { testConnection, getAccounts, getCategories, createCategory, deleteAllTransactions, applyRules, getTransactionCount } from "./sure.js";
import { ACCOUNT_TYPES } from "./accounts.js";
import { pacificDate, flushPendingCategories } from "./utils.js";

const SINGLE_ACCOUNT_SYNC = {
  bilt:     syncBilt,
  fidelity: syncFidelity,
  target:   syncTarget,
};

function sendProgress(key, percent, message) {
  chrome.runtime.sendMessage({ type: "SYNC_PROGRESS", key, percent, message }).catch(() => {});
}

// Per-account progress reporter for flushes (upload phase only). A null message
// clears the row's progress; otherwise the 0→1 fraction maps onto the full bar.
function sendFlushProgress(key, frac, message) {
  if (message == null) sendProgress(key, null);
  else sendProgress(key, Math.round(frac * 100), message);
}

// ── Sync orchestration ───────────────────────────────────────────────────────

let syncInProgress = false;
let flushQueued = false;

// Coalescing flush driver. Requests that arrive while a sync or an earlier flush
// is running don't get dropped — they set flushQueued, and the in-flight run
// loops to pick them up (or runSync drains on completion). This way mapping a
// category while a previous flush is still running still imports.
function requestFlush() {
  flushQueued = true;
  pumpFlush();
}

async function pumpFlush() {
  if (syncInProgress) return;       // a sync or flush is running; it will drain on completion
  if (!flushQueued) return;
  syncInProgress = true;
  try {
    while (flushQueued) {
      flushQueued = false;
      try {
        const { added } = await flushPendingCategories(undefined, sendFlushProgress);
        if (added) console.log(`Flushed ${added} mapped transaction(s).`);
      } catch (err) {
        console.warn("Flush failed:", err.message);
      }
    }
  } finally {
    syncInProgress = false;
  }
  await notifyPopup();
}

async function runSync(options = {}) {
  if (syncInProgress) {
    console.log("Sync already in progress, skipping.");
    return;
  }
  syncInProgress = true;
  const syncSessionId = Date.now();
  try {
  await chrome.storage.local.set({
    activeSyncSessionId: syncSessionId,
    activeSyncSummary: {
      sessionId: syncSessionId,
      byKey: {},
      syncedAccounts: 0,
      transactionCount: 0,
      inflow: 0,
      outflow: 0,
    },
  });
  console.log("Starting sync...");

  const settings = await chrome.storage.sync.get(["sureApiKey"]);

  if (!settings.sureApiKey) {
    console.warn("Sync skipped: Sure API key not configured.");
    return;
  }

  const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");

  if (Object.keys(accountMappings).length === 0) {
    console.warn("Sync skipped: No account mappings configured.");
    return;
  }

  let sureBalances = {};
  try {
    const accounts = await getAccounts();
    sureBalances = Object.fromEntries(accounts.map(a => [a.id, a.balance_cents]));
  } catch (err) {
    console.warn("Failed to fetch Sure balances:", err.message);
  }

  const { lastSyncDates = {} } = await chrome.storage.local.get("lastSyncDates");
  const today = pacificDate(new Date());

  let scopedMappings;
  if (options.targetKeys?.length) {
    scopedMappings = Object.fromEntries(Object.entries(accountMappings).filter(([key]) => options.targetKeys.includes(key)));
  } else {
    scopedMappings = Object.fromEntries(Object.entries(accountMappings).filter(([key]) => lastSyncDates[key] !== today));
  }

  const keys = Object.keys(scopedMappings);

  // Safety net: import any held-back transactions whose category has since been
  // mapped (the popup also flushes immediately when a mapping is saved).
  try {
    const { added } = await flushPendingCategories(keys, sendFlushProgress);
    if (added) console.log(`Flushed ${added} previously held transaction(s).`);
  } catch (err) {
    console.warn("Failed to flush pending categories:", err.message);
  }

  if (keys.length === 0) {
    console.log("All accounts already synced today.");
    return;
  }

  const sofiKeys = keys.filter(k => k.startsWith("sofi-"));
  if (sofiKeys.length) {
    sofiKeys.forEach(k => sendProgress(k, 5, "Opening SoFi"));
    const allSofiMappings = Object.fromEntries(Object.entries(accountMappings).filter(([k]) => k.startsWith("sofi-")));
    await syncSoFi(settings, allSofiMappings, {
      ...getSyncOptionsForKeys(options, sofiKeys, (key, percent, message) => sendProgress(key, percent, message)),
      syncKeys: sofiKeys, sureBalances,
    });
    sofiKeys.forEach(k => sendProgress(k, null));
  }

  const caponeKeys = keys.filter(k => k.startsWith("capitalone-"));
  if (caponeKeys.length) {
    caponeKeys.forEach(k => sendProgress(k, 5, "Opening Capital One"));
    const allCaponeMappings = Object.fromEntries(Object.entries(accountMappings).filter(([k]) => k.startsWith("capitalone-")));
    await syncCapitalOne(settings, allCaponeMappings, {
      ...getSyncOptionsForKeys(options, caponeKeys, (key, percent, message) => sendProgress(key, percent, message)),
      syncKeys: caponeKeys, sureBalances,
    });
    caponeKeys.forEach(k => sendProgress(k, null));
  }

  const usbankKeys = keys.filter(k => k.startsWith("usbank-"));
  if (usbankKeys.length) {
    usbankKeys.forEach(k => sendProgress(k, 5, "Opening US Bank"));
    const allUSBankMappings = Object.fromEntries(Object.entries(accountMappings).filter(([k]) => k.startsWith("usbank-")));
    await syncUSBank(settings, allUSBankMappings, {
      ...getSyncOptionsForKeys(options, usbankKeys, (key, percent, message) => sendProgress(key, percent, message)),
      syncKeys: usbankKeys, sureBalances,
    });
    usbankKeys.forEach(k => sendProgress(k, null));
  }

  const wfKeys = keys.filter(k => k.startsWith("wf-"));
  for (const key of wfKeys) {
    sendProgress(key, 5, "Opening Wells Fargo");
    await syncWellsFargo(settings, scopedMappings, key, { ...getSyncOptionsForKeys(options, [key], (percent, message) => sendProgress(key, percent, message)), sureBalances });
    sendProgress(key, null);
  }

  const venmoKeys = keys.filter(k => ACCOUNT_TYPES[k]?.bank === "venmo");
  if (venmoKeys.length) {
    venmoKeys.forEach(k => sendProgress(k, 5, "Opening Venmo"));
    await syncVenmo(settings, scopedMappings, { ...getSyncOptionsForKeys(options, venmoKeys, (key, percent, message) => sendProgress(key, percent, message)), sureBalances });
    venmoKeys.forEach(k => sendProgress(k, null));
  }

  for (const key of keys) {
    const syncFn = SINGLE_ACCOUNT_SYNC[ACCOUNT_TYPES[key]?.bank];
    if (syncFn) {
      sendProgress(key, 5, "Opening bank");
      await syncFn(settings, scopedMappings, key, { ...getSyncOptionsForKeys(options, [key], (percent, message) => sendProgress(key, percent, message)), sureBalances });
      sendProgress(key, null);
    }
  }

  const { lastSyncMetrics = {}, lastSyncDates: currentSyncDates = {} } = await chrome.storage.local.get(["lastSyncMetrics", "lastSyncDates"]);
  const mappedKeys = Object.keys(accountMappings);
  const syncedAccounts = mappedKeys.filter(k => currentSyncDates[k]).length;
  const metricValues = mappedKeys.map(k => lastSyncMetrics[k]).filter(Boolean);
  const newSummary = syncedAccounts > 0
    ? metricValues.reduce((acc, m) => ({
        ...acc,
        transactionCount: acc.transactionCount + (m.count || 0),
        inflow: acc.inflow + (m.inflow || 0),
        outflow: acc.outflow + (m.outflow || 0),
      }), { syncedAccounts, transactionCount: 0, inflow: 0, outflow: 0 })
    : undefined;
  await chrome.storage.local.set({
    lastSyncTime: Date.now(),
    lastCompletedSyncSessionId: syncSessionId,
    ...(newSummary !== undefined ? { lastCompletedSyncSummary: newSummary } : {}),
  });
  console.log("Sync complete.");

  await notifyPopup();

  } finally {
    await chrome.storage.local.remove(["activeSyncSessionId", "activeSyncSummary"]);
    syncInProgress = false;
    // Drain anything mapped while this sync was running (or queued meanwhile).
    requestFlush();
  }
}

// ── Message handler (from popup) ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "TEST_CONNECTION") {
    testConnection()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_SURE_ACCOUNTS") {
    getAccounts()
      .then((accounts) => sendResponse({ accounts }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "RUN_SYNC") {
    if (syncInProgress) {
      sendResponse({ error: "Sync already in progress" });
      return true;
    }
    runSync(msg.options || {})
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_SURE_CATEGORIES") {
    getCategories()
      .then((categories) => sendResponse({ categories }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "CREATE_SURE_CATEGORY") {
    createCategory(msg.name)
      .then((category) => sendResponse({ category }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "FLUSH_PENDING_CATEGORIES") {
    requestFlush();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "GET_SOFI_ACCOUNTS") {
    getSoFiAccountsForPopup()
      .then((accounts) => sendResponse({ accounts }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_CAPITALONE_ACCOUNTS") {
    getCapitalOneAccountsForPopup()
      .then((accounts) => sendResponse({ accounts }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_USBANK_ACCOUNTS") {
    getUSBankAccountsForPopup()
      .then((accounts) => sendResponse({ accounts }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_TRANSACTION_COUNT") {
    getTransactionCount(msg.accountId)
      .then((count) => sendResponse({ count }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "DELETE_ALL_TRANSACTIONS") {
    if (syncInProgress) {
      sendResponse({ error: "Sync in progress, try again later" });
      return true;
    }
    syncInProgress = true;
    deleteAllTransactions(msg.accountId)
      .then((count) => sendResponse({ count }))
      .catch((err) => sendResponse({ error: err.message }))
      .finally(() => { syncInProgress = false; });
    return true;
  }


  if (msg.type === "GET_WF_ACCOUNTS") {
    getWellsFargoAccountsForPopup()
      .then((accounts) => sendResponse({ accounts }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "CLEAR_LOGS") {
    clearLogBuffer()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function notifyPopup() {
  const { lastSyncDates = {}, lastSyncTime } = await chrome.storage.local.get(["lastSyncDates", "lastSyncTime"]);
  chrome.runtime.sendMessage({ type: "SYNC_UPDATED", lastSyncDates, lastSyncTime }).catch(() => {});
}

function getSyncOptionsForKeys(options, keys, onProgress) {
  return { onProgress };
}
