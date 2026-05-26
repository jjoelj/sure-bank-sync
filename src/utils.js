export const POLL_INTERVAL_MS = 500;
export const POLL_TIMEOUT_MS = 2 * 60 * 1000;

export function subtractOneDay(isoDate) {
    const [y, m, d] = isoDate.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

import { createCsvImport, getTransactions } from './sure.js';

export function logBalanceDrift(label, sureBalance, addedSum, bankBalance) {
    const expected = sureBalance + addedSum;
    const opening = bankBalance - expected;
    console.log(`${label}: Sure ${sureBalance} + added ${addedSum} = ${expected}, bank ${bankBalance}, opening balance needed: ${opening} ($${(opening / 100).toFixed(2)})`);
}

function sureToFingerprint(tx) {
    return `${tx.date}|${tx.signed_amount_cents}|${tx.name || ""}`;
}

function txFingerprint(tx) {
    return `${tx.date}|${tx.amount}|${tx.payee_name || "Unknown"}`;
}

export async function importTransactions(label, settings, accountId, transactions, mappingKey) {
    if (transactions.length === 0) return { added: 0, addedSum: 0 };

    let minDate = transactions[0].date, maxDate = transactions[0].date;
    for (const tx of transactions) {
        if (tx.date < minDate) minDate = tx.date;
        if (tx.date > maxDate) maxDate = tx.date;
    }

    const existing = await getTransactions(accountId, { startDate: minDate, endDate: maxDate });
    console.log(`${label}: ${existing.length} existing transactions in Sure (${minDate} → ${maxDate})`);
    const knownCounts = new Map();
    for (const tx of existing) {
        const fp = sureToFingerprint(tx);
        knownCounts.set(fp, (knownCounts.get(fp) || 0) + 1);
    }
    const newTxs = [];
    for (const tx of transactions) {
        const fp = txFingerprint(tx);
        const remaining = knownCounts.get(fp) || 0;
        if (remaining > 0) {
            knownCounts.set(fp, remaining - 1);
        } else {
            newTxs.push(tx);
        }
    }

    if (newTxs.length === 0) {
        console.log(`${label}: all ${transactions.length} transactions already imported, skipping.`);
        return { added: 0, addedSum: 0 };
    }

    await createCsvImport(accountId, newTxs);
    await new Promise(r => setTimeout(r, 5000));
    const addedSum = newTxs.reduce((sum, tx) => sum + tx.amount, 0);
    const skipped = transactions.length - newTxs.length;
    console.log(`${label}: ${transactions.length} total, ${newTxs.length} new via CSV import, ${skipped} already imported`);
    return { added: newTxs.length, addedSum };
}

export function getDateChunks(startDate, endDate, maxDays) {
    const chunks = [];
    let current = new Date(startDate);
    const end = new Date(endDate);

    while (current < end) {
        const chunkEnd = new Date(current);
        chunkEnd.setDate(chunkEnd.getDate() + maxDays);
        if (chunkEnd > end) chunkEnd.setTime(end.getTime());
        chunks.push([isoDate(current), isoDate(chunkEnd)]);
        current = new Date(chunkEnd);
        current.setDate(current.getDate() + 1);
    }

    return chunks;
}

export function parseCsvLine(line) {
    const result = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === "," && !inQuotes) {
            result.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    result.push(current);
    return result;
}

// ── Date helpers ─────────────────────────────────────────────────────────────

export function isoDate(date) {
    return date.toISOString().split("T")[0];
}

export function pacificDate(date) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(date);
}

export function offsetDate(isoStr, days) {
    const [y, m, d] = isoStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function getSyncPlan(lastSyncDates, syncFromDate, key) {
    const endDate = pacificDate(new Date());
    const startDate = lastSyncDates[key] || syncFromDate;
    if (!startDate) return null;

    return { startDate, endDate };
}

export function reportProgress(options, ...args) {
    if (typeof options.onProgress === "function") {
        options.onProgress(...args);
    }
}

// ── Tab helpers ──────────────────────────────────────────────────────────────

export function openTabBackground(url) {
    return new Promise((resolve, reject) => {
        chrome.windows.create({ url, type: "normal", width: 1200, height: 800 }, (win) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(win.tabs[0]);
            }
        });
    });
}


export async function updateLastSyncDate(key, date) {
    const { lastSyncDates = {} } = await chrome.storage.local.get("lastSyncDates");
    lastSyncDates[key] = date;
    await chrome.storage.local.set({ lastSyncDates });
}

export async function updateLastSyncMetrics(key, transactions) {
    const { lastSyncMetrics = {}, activeSyncSessionId = null, activeSyncSummary = null } = await chrome.storage.local.get([
        "lastSyncMetrics",
        "activeSyncSessionId",
        "activeSyncSummary",
    ]);

    const metrics = {
        count: transactions.length,
        inflow: 0,
        outflow: 0,
        net: 0,
        sessionId: activeSyncSessionId,
    };

    for (const tx of transactions) {
        const amount = Number(tx.amount) || 0;
        metrics.net += amount;
        if (amount > 0) metrics.inflow += amount;
        if (amount < 0) metrics.outflow += Math.abs(amount);
    }

    const nextSummary = activeSyncSessionId
        ? updateSyncSummary(activeSyncSummary, activeSyncSessionId, key, metrics)
        : activeSyncSummary;

    const updates = { ...(nextSummary ? { activeSyncSummary: nextSummary } : {}) };
    if (transactions.length > 0) {
        lastSyncMetrics[key] = metrics;
        updates.lastSyncMetrics = lastSyncMetrics;
    } else if (!lastSyncMetrics[key]) {
        lastSyncMetrics[key] = metrics;
        updates.lastSyncMetrics = lastSyncMetrics;
    }
    if (Object.keys(updates).length > 0) await chrome.storage.local.set(updates);
}

export async function updateLastSyncStats(key, transactions) {
    await updateLastSyncMetrics(key, transactions);
}

function updateSyncSummary(summary, sessionId, key, metrics) {
    const byKey = {
        ...((summary?.sessionId === sessionId && summary?.byKey) ? summary.byKey : {}),
        [key]: metrics,
    };
    const values = Object.values(byKey);

    return {
        sessionId,
        byKey,
        syncedAccounts: values.length,
        transactionCount: values.reduce((sum, item) => sum + (item.count || 0), 0),
        inflow: values.reduce((sum, item) => sum + (item.inflow || 0), 0),
        outflow: values.reduce((sum, item) => sum + (item.outflow || 0), 0),
    };
}
