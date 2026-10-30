// ============================================================
// MediCore Sheets Sync - Google Apps Script Web App
// Receives sync batches from the Supabase Edge Function
// "sheets-sync" and upserts them into this Google Sheet.
//
// One tab is created per clinic + table, named:
//   <clinic> - <table>      e.g. "al-shifa - patients"
// Rows are upserted by the "id" column.
// This sync is one-way: Supabase -> Sheet. Editing the Sheet
// by hand does NOT change any data in the app.
// ============================================================

// Must match the SHEETS_SECRET secret set in Supabase.
const SECRET = "CHANGE_ME_TO_A_LONG_SECRET";

// Health check: open the Web App URL in a browser to test it.
function doGet(e) {
  return jsonResponse({ ok: true, service: "medicore-sheets-sync" });
}

// Receive one batch: { secret, clinic, tables: { tableName: [rows] } }
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ ok: false, error: "empty body" });
    }

    var body = JSON.parse(e.postData.contents);

    if (!body.secret || body.secret !== SECRET) {
      return jsonResponse({ ok: false, error: "bad secret" });
    }

    var clinic = String(body.clinic || "clinic");
    var tables = body.tables || {};

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var totalUpdated = 0;
    var totalInserted = 0;

    for (var tableName in tables) {
      var rows = tables[tableName];
      if (!rows || !rows.length) continue;

      var result = upsertTable(ss, clinic, tableName, rows);
      totalUpdated += result.updated;
      totalInserted += result.inserted;
    }

    return jsonResponse({ ok: true, updated: totalUpdated, inserted: totalInserted });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// Upsert all rows of one table into its tab. Returns counts.
function upsertTable(ss, clinic, tableName, rows) {
  var tabName = clinic + " - " + tableName;
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
  }

  // Header = union of keys across all rows, "id" first when present.
  var headers = collectHeaders(rows);
  ensureHeader(sheet, headers);
  // Align to the sheet's actual header order (ensureHeader may have
  // appended new columns to an existing header).
  var actual = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (v) { return String(v); })
    .filter(function (h) { return h !== ""; });
  if (actual.length) headers = actual;

  var idCol = headers.indexOf("id"); // 0-based
  if (idCol === -1) {
    // Without an id there is nothing to upsert by: append everything.
    var appended = rows.map(function (r) { return rowToValues(r, headers); });
    if (appended.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, appended.length, headers.length).setValues(appended);
    }
    return { updated: 0, inserted: appended.length };
  }

  // Build id -> rowNumber map from the id column in one read.
  var lastRow = sheet.getLastRow();
  var idToRow = {};
  if (lastRow > 1) {
    var idValues = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < idValues.length; i++) {
      var existingId = String(idValues[i][0]);
      if (existingId) idToRow[existingId] = i + 2; // +2: 1-based + header row
    }
  }

  var updated = 0;
  var toAppend = [];

  rows.forEach(function (r) {
    var values = rowToValues(r, headers);
    var id = String(r.id);
    if (idToRow[id]) {
      // Update the existing row in place.
      sheet.getRange(idToRow[id], 1, 1, headers.length).setValues([values]);
      updated++;
    } else {
      toAppend.push(values);
    }
  });

  if (toAppend.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, headers.length).setValues(toAppend);
  }

  return { updated: updated, inserted: toAppend.length };
}

// Union of keys across rows, with "id" moved to the front.
function collectHeaders(rows) {
  var seen = {};
  var headers = [];
  rows.forEach(function (r) {
    Object.keys(r).forEach(function (k) {
      if (!seen[k]) {
        seen[k] = true;
        headers.push(k);
      }
    });
  });
  var idIndex = headers.indexOf("id");
  if (idIndex > 0) {
    headers.splice(idIndex, 1);
    headers.unshift("id");
  }
  return headers;
}

// Write the header row if the sheet is empty, or extend it when
// new columns appear that the existing header does not have yet.
function ensureHeader(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return;
  }
  var existing = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0]
    .map(function (v) { return String(v); });
  var missing = headers.filter(function (h) { return existing.indexOf(h) === -1; });
  if (missing.length) {
    // Re-write the full header: existing order first, then new columns.
    var merged = existing.filter(function (h) { return h !== ""; }).concat(missing);
    sheet.getRange(1, 1, 1, merged.length).setValues([merged]);
  }
}

// Convert one row object to a values array in header order.
// Objects/arrays are JSON strings (the Edge Function already
// flattens them, this is just a safety net).
function rowToValues(row, headers) {
  return headers.map(function (h) {
    var v = row[h];
    if (v === null || v === undefined) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return v;
  });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
