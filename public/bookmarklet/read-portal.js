/**
 * Portal table reader (MASTER-PLAN §17.23, Phase 3 item 1).
 *
 * This file is the READABLE SOURCE of the bookmarklet. It is never loaded as a
 * script by the portal — app/(app)/tools/bookmarklet/page.tsx reads it at
 * request time, substitutes the three __PLACEHOLDER__ values below, and packs
 * the result into a single `javascript:` URL the operator drags to their
 * bookmarks bar.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WHOLE SCRIPT IS INLINED INTO THE BOOKMARKLET RATHER THAN LOADED
 *
 * The obvious design is a two-line bookmarklet that injects
 * `<script src="https://hub/bookmarklet/read-portal.js">`. That breaks the
 * moment the portal sets a `script-src` Content-Security-Policy, which is
 * exactly the kind of thing a finance portal does and exactly the kind of
 * breakage that would be blamed on the Hub. Browsers exempt user-invoked
 * bookmarklets from CSP; a script the page loads from a third-party origin
 * gets no such exemption. Inlining costs a longer bookmark URL — a limit no
 * browser reaches at this size — and buys immunity from the portal's CSP.
 *
 * The same reasoning does NOT extend to the POST: `connect-src` can still
 * block the upload, which is why the file-download fallback exists and is not
 * optional.
 *
 * WHY IT READS THE GRID'S API BEFORE IT READS THE DOM
 *
 * The observed portal renders a jQuery DataTables grid ("Showing 1 to 8 of 8
 * entries", per-column filter inputs, sortable headers). Reading the DOM alone
 * would capture ONE PAGE of a paginated table and silently under-report — an
 * import that quietly drops rows 26 to 400 is the worst possible failure here,
 * because nothing about the result looks wrong. So: ask the grid for all of
 * its rows first, and fall back to the DOM only when there is no grid.
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict'

  var HUB_URL = '__HUB_URL__'
  var TOKEN = '__TOKEN__'
  var SOURCE_SYSTEM = '__SOURCE_SYSTEM__'
  var VERSION = '__VERSION__'

  // -------------------------------------------------------------------------
  // Overlay
  // -------------------------------------------------------------------------

  var box = null

  function ui(html, opts) {
    if (!box) {
      box = document.createElement('div')
      box.setAttribute(
        'style',
        'position:fixed;top:16px;right:16px;z-index:2147483647;width:380px;max-height:80vh;' +
          'overflow:auto;background:#fff;color:#111;border:1px solid #d4d4d8;border-radius:10px;' +
          'box-shadow:0 10px 30px rgba(0,0,0,.18);font:13px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;' +
          'padding:14px 16px'
      )
      document.body.appendChild(box)
    }
    box.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      '<strong style="font-size:13px">Istifadah Hub — portal reader</strong>' +
      '<span id="ih-x" style="cursor:pointer;color:#71717a;padding:0 4px">&times;</span></div>' +
      html
    var close = document.getElementById('ih-x')
    if (close) {
      close.onclick = function () {
        if (box && box.parentNode) box.parentNode.removeChild(box)
        box = null
      }
    }
    if (opts && opts.onReady) opts.onReady()
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    })
  }

  function fail(message) {
    ui('<div style="color:#b91c1c">' + esc(message) + '</div>')
  }

  // -------------------------------------------------------------------------
  // Reading the table
  // -------------------------------------------------------------------------

  function cellText(el) {
    if (!el) return ''
    // `innerText` respects rendering, so a visually-hidden helper span does not
    // leak into the value; `textContent` would include it. Falling back to
    // textContent keeps this working in a detached node.
    var text = el.innerText !== undefined ? el.innerText : el.textContent
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /**
   * Picks the header row. A filtered grid renders TWO rows in its `thead`: the
   * labels, and a row of per-column search inputs (visible in the observed
   * portal). An input's value is not text, so the filter row reads as mostly
   * empty — the row with the most non-empty cells is the labels.
   */
  function headerCells(table) {
    var rows = table.querySelectorAll('thead tr')
    var best = null
    var bestScore = -1
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].querySelectorAll('th,td')
      var score = 0
      for (var j = 0; j < cells.length; j++) if (cellText(cells[j])) score++
      if (score > bestScore) {
        bestScore = score
        best = cells
      }
    }
    if (!best || bestScore <= 0) return []
    var out = []
    for (var k = 0; k < best.length; k++) out.push(cellText(best[k]))
    return out
  }

  function bodyRows(table, columnCount) {
    var trs = table.querySelectorAll('tbody tr')
    var out = []
    for (var i = 0; i < trs.length; i++) {
      var tds = trs[i].querySelectorAll('td')
      // A grid's "No matching records found" placeholder is one cell spanning
      // the whole table. Importing it as a row would be nonsense.
      if (tds.length <= 1 && columnCount > 1) continue
      var row = []
      for (var j = 0; j < tds.length; j++) row.push(cellText(tds[j]))
      if (row.join('') === '') continue
      out.push(row)
    }
    return out
  }

  /** Every table on the page, largest body first. */
  function candidateTables() {
    var tables = [].slice.call(document.querySelectorAll('table'))
    tables.sort(function (a, b) {
      return b.querySelectorAll('tbody tr').length - a.querySelectorAll('tbody tr').length
    })
    return tables
  }

  function dataTablesApi(table) {
    var $ = window.jQuery || window.$
    if (!$ || !$.fn || !$.fn.dataTable) return null
    try {
      if (!$.fn.dataTable.isDataTable(table)) return null
      return $(table).DataTable()
    } catch (e) {
      return null
    }
  }

  /**
   * Reads a DataTables grid in full.
   *
   * Rather than reconstruct rows from the API's data objects — whose shape
   * depends on how the grid was configured, and which carry raw HTML for
   * rendered columns — this sets the page length to "all", lets the grid
   * redraw, and then reads the DOM it produced. One code path for the values,
   * and it works identically for client-side and server-side grids (a
   * server-side grid fetches the remaining rows on that redraw).
   *
   * The original page length is restored afterwards, so the operator's screen
   * is left as they found it.
   */
  function readViaDataTables(table, api, done) {
    var originalLength
    try {
      originalLength = api.page.len()
    } catch (e) {
      originalLength = null
    }

    var finish = function () {
      var headers = headerCells(table)
      var rows = bodyRows(table, headers.length)
      if (originalLength !== null && originalLength !== -1) {
        try {
          api.page.len(originalLength).draw(false)
        } catch (e) {
          /* leave it showing everything rather than fail the read */
        }
      }
      done(headers, rows)
    }

    if (originalLength === -1) return finish()

    var settled = false
    var guard = setTimeout(function () {
      // A server-side grid that never fires `draw` (offline, slow, or an error
      // in its own handler) must not leave the operator staring at a spinner.
      if (!settled) {
        settled = true
        finish()
      }
    }, 15000)

    try {
      api.one('draw', function () {
        if (settled) return
        settled = true
        clearTimeout(guard)
        finish()
      })
      api.page.len(-1).draw(false)
    } catch (e) {
      if (!settled) {
        settled = true
        clearTimeout(guard)
        finish()
      }
    }
  }

  function readTable(done) {
    var tables = candidateTables()
    if (tables.length === 0) {
      return fail('No table found on this page. Open the entry list first, then run this again.')
    }

    for (var i = 0; i < tables.length; i++) {
      var api = dataTablesApi(tables[i])
      if (api) return readViaDataTables(tables[i], api, done)
    }

    // Plain HTML table.
    var table = tables[0]
    var headers = headerCells(table)
    var rows = bodyRows(table, headers.length)

    // A plain table that is nonetheless paginated by the server would be read
    // one page at a time with no way to detect it from here. Say so rather
    // than let an operator assume a short import was the whole table.
    var pagerText = document.body.innerText || ''
    var showing = pagerText.match(/Showing\s+\d+\s+to\s+(\d+)\s+of\s+([\d,]+)/i)
    if (showing && Number(showing[2].replace(/,/g, '')) > rows.length) {
      window.__ihPartial = { shown: rows.length, total: showing[2] }
    }

    done(headers, rows)
  }

  // -------------------------------------------------------------------------
  // Submitting
  // -------------------------------------------------------------------------

  function download(payload) {
    try {
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      var url = URL.createObjectURL(blob)
      var a = document.createElement('a')
      a.href = url
      a.download = SOURCE_SYSTEM + '-portal-scrape-' + new Date().toISOString().slice(0, 10) + '.json'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(function () {
        URL.revokeObjectURL(url)
      }, 5000)
      return true
    } catch (e) {
      return false
    }
  }

  function summarise(result) {
    var summary = result.summary || {}
    var keys = Object.keys(summary)
    var lines = keys
      .map(function (k) {
        return (
          '<tr><td style="padding:2px 8px 2px 0">' +
          esc(k.replace(/_/g, ' ')) +
          '</td><td style="text-align:right;font-variant-numeric:tabular-nums">' +
          esc(summary[k]) +
          '</td></tr>'
        )
      })
      .join('')

    var warnings = (result.warnings || [])
      .map(function (w) {
        return '<li style="color:#a16207">' + esc(w) + '</li>'
      })
      .join('')

    var exceptions = (result.exceptions || [])
      .slice(0, 8)
      .map(function (x) {
        return '<li style="color:#b91c1c">' + esc(x.severity) + ': ' + esc(x.description) + '</li>'
      })
      .join('')

    return (
      '<div style="margin-bottom:6px">Batch <strong>#' +
      esc(result.batchId) +
      '</strong> — ' +
      esc(result.mode === 'dry_run' ? 'dry run (nothing saved yet)' : 'committed') +
      ', ' +
      esc(result.rowCount) +
      ' rows, status ' +
      esc(result.status) +
      '</div>' +
      '<table style="width:100%;margin:6px 0">' +
      lines +
      '</table>' +
      (warnings ? '<ul style="margin:6px 0;padding-left:18px">' + warnings + '</ul>' : '') +
      (exceptions ? '<ul style="margin:6px 0;padding-left:18px">' + exceptions + '</ul>' : '')
    )
  }

  function post(payload, mode, onResult, onError) {
    var body = {}
    for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) body[k] = payload[k]
    body.mode = mode

    fetch(HUB_URL + '/api/import/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(body),
      // Never send the portal's cookies to the Hub, and never ask for the
      // Hub's back: the bearer token is the entire credential (see
      // lib/scrape-token.ts).
      credentials: 'omit',
      mode: 'cors',
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return { error: 'Hub returned a non-JSON response (HTTP ' + response.status + ').' }
          })
          .then(function (data) {
            if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status)
            return data
          })
      })
      .then(onResult)
      .catch(onError)
  }

  // -------------------------------------------------------------------------
  // Go
  // -------------------------------------------------------------------------

  ui('<div>Reading the table…</div>')

  readTable(function (headers, rows) {
    if (!headers.length) {
      return fail('Found a table but could not read its column headings. Send a screenshot to whoever set this up.')
    }
    if (!rows.length) {
      return fail('Found the table but it has no rows on screen. Clear any filters and try again.')
    }

    var payload = {
      sourceSystem: SOURCE_SYSTEM,
      headers: headers,
      rows: rows,
      sourceUrl: location.href,
      scraperVersion: VERSION,
      scrapedAt: new Date().toISOString(),
    }

    var partial = window.__ihPartial
    var partialNote = partial
      ? '<div style="color:#a16207;margin-bottom:6px">Warning: this page shows ' +
        esc(partial.shown) +
        ' of ' +
        esc(partial.total) +
        ' rows. Set the page size to show all rows, then run this again.</div>'
      : ''

    ui(
      partialNote +
        '<div>Read <strong>' +
        rows.length +
        '</strong> rows &times; ' +
        headers.length +
        ' columns.</div>' +
        '<div style="color:#71717a;margin:4px 0 10px">' +
        esc(headers.join(' · ')) +
        '</div>' +
        '<div>Sending to the Hub as a dry run…</div>'
    )

    post(
      payload,
      'dry_run',
      function (result) {
        ui(
          partialNote +
            summarise(result) +
            '<button id="ih-commit" style="margin-top:8px;padding:7px 12px;border:0;border-radius:6px;' +
            'background:#111;color:#fff;cursor:pointer;font:inherit">Commit this import</button>',
          {
            onReady: function () {
              var btn = document.getElementById('ih-commit')
              if (!btn) return
              btn.onclick = function () {
                btn.disabled = true
                btn.textContent = 'Committing…'
                post(
                  payload,
                  'commit',
                  function (committed) {
                    ui(partialNote + summarise(committed) + '<div style="color:#15803d">Saved.</div>')
                  },
                  function (error) {
                    fail('Commit failed: ' + error.message)
                  }
                )
              }
            },
          }
        )
      },
      function (error) {
        // The likely cause is the portal's own `connect-src` CSP blocking the
        // upload, which no amount of retrying fixes — hand the operator the
        // file instead so the scrape is not wasted.
        var saved = download(payload)
        ui(
          '<div style="color:#b91c1c;margin-bottom:8px">Could not reach the Hub: ' +
            esc(error.message) +
            '</div>' +
            (saved
              ? '<div>The rows were downloaded as a .json file instead. Upload it on the Hub&rsquo;s import screen.</div>'
              : '<div>Saving a file also failed. Copy the rows manually, or ask for the paste-box workaround.</div>')
        )
      }
    )
  })
})()
