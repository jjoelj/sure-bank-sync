async function getSettings() {
  const { sureApiKey, sureUrl } = await chrome.storage.sync.get(["sureApiKey", "sureUrl"]);
  if (!sureUrl) throw new Error("Sure URL not configured");
  if (!sureApiKey) throw new Error("Sure API key not configured");
  return { apiKey: sureApiKey, baseUrl: sureUrl.replace(/\/+$/, "") + "/api/v1" };
}

async function apiFetch(path, options = {}) {
  const { apiKey, baseUrl } = await getSettings();
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error("Sure API error:", res.status, JSON.stringify(body));
    throw new Error(body.message || body.error || JSON.stringify(body) || `Sure API error: ${res.status}`);
  }
  return res.json();
}

export async function testConnection() {
  await apiFetch("/accounts?page=1&per_page=1");
  return { ok: true };
}

function parseBalanceToCents(balanceStr) {
  if (!balanceStr) return null;
  const cleaned = balanceStr.replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const negative = balanceStr.includes("-") || balanceStr.includes("(");
  const cents = Math.round(parseFloat(cleaned) * 100);
  return negative ? -cents : cents;
}

export async function getAccounts() {
  const allAccounts = [];
  let page = 1;
  while (true) {
    const data = await apiFetch(`/accounts?page=${page}&per_page=100`);
    allAccounts.push(...data.accounts);
    if (page >= data.pagination.total_pages) break;
    page++;
  }
  return allAccounts.map(a => {
    const raw = a.balance_cents ?? parseBalanceToCents(a.balance);
    const sign = a.classification === "liability" ? -1 : 1;
    return { id: a.id, name: a.name, balance_cents: raw != null ? raw * sign : null };
  });
}

export async function createCsvImport(accountId, transactions) {
  const header = "date,amount,name,notes";
  const rows = transactions.map(tx => {
    const amount = (tx.amount / 100).toFixed(2);
    return `${tx.date},${amount},${csvEscape(tx.payee_name || "Unknown")},${csvEscape(tx.notes || "")}`;
  });

  const result = await apiFetch("/imports", {
    method: "POST",
    body: JSON.stringify({
      raw_file_content: [header, ...rows].join("\n"),
      type: "TransactionImport",
      account_id: accountId,
      publish: "true",
      date_col_label: "date",
      amount_col_label: "amount",
      name_col_label: "name",
      notes_col_label: "notes",
      signage_convention: "inflows_positive",
      date_format: "%Y-%m-%d",
    }),
  });

  const importId = result.id || result.import?.id;
  if (importId) await waitForImportComplete(importId);

  return result;
}

async function waitForImportComplete(importId, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await apiFetch(`/imports?per_page=100`);
    const imp = data.imports?.find(i => i.id === importId);
    if (!imp || imp.status === "complete") return;
    if (imp.status === "failed") throw new Error(`Import ${importId} failed`);
    await new Promise(r => setTimeout(r, 1000));
  }
  console.warn(`Import ${importId}: timed out waiting for completion`);
}

export async function applyRules() {
  const { apiKey, baseUrl } = await getSettings();
  const rootUrl = baseUrl.replace(/\/api\/v1$/, "");

  const page = await fetch(rootUrl, { credentials: "include" });
  const html = await page.text();
  const match = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  if (!match) throw new Error("Could not find CSRF token for rules apply");

  const res = await fetch(rootUrl + "/rules/apply_all", {
    method: "POST",
    credentials: "include",
    headers: {
      "X-CSRF-Token": match[1],
      "Accept": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || body.error || `Rules apply failed: ${res.status}`);
  }
  return res.json().catch(() => ({}));
}

function csvEscape(str) {
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function getTransactionCount(accountId) {
  const data = await apiFetch(`/transactions?account_id=${accountId}&page=1&per_page=1`);
  return data.pagination?.total_count ?? data.transactions?.length ?? 0;
}

export async function deleteAllTransactions(accountId) {
  const transactions = await getTransactions(accountId);
  const { apiKey, baseUrl } = await getSettings();
  for (const tx of transactions) {
    const res = await fetch(`${baseUrl}/transactions/${tx.id}`, {
      method: "DELETE",
      headers: { "X-Api-Key": apiKey },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || body.error || `Delete failed: ${res.status}`);
    }
  }
  return transactions.length;
}


export async function getTransactions(accountId, { startDate, endDate } = {}) {
  const all = [];
  let page = 1;
  while (true) {
    let url = `/transactions?account_id=${accountId}&page=${page}&per_page=100`;
    if (startDate) url += `&start_date=${startDate}`;
    if (endDate) url += `&end_date=${endDate}`;
    const data = await apiFetch(url);
    all.push(...data.transactions);
    if (page >= data.pagination.total_pages) break;
    page++;
  }
  return all;
}

