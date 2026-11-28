// This intentionally small browser app is a synthetic validation target.
// Fault injection is fixed by the built page's mode; URL parameters cannot change it.
(() => {
  'use strict';
  const mode = document.body.dataset.appMode;
  const faulty = mode === 'faulty';
  const parameters = new URLSearchParams(location.search);
  const workspace = parameters.get('workspace') ?? 'default-workspace';
  const key = `dilution-bench:v1:${new URL('.', location.href).pathname}:${mode}:${workspace}`;
  const columns = [
    'Sample ID',
    'Stock (mg/mL)',
    'Target (mg/mL)',
    'Final volume (mL)',
    'Stock volume (mL)',
    'Diluent volume (mL)',
  ];
  const form = document.querySelector('#preparation-form');
  const messages = document.querySelector('#messages');
  const result = document.querySelector('#results');
  const largeDecimal = new Intl.NumberFormat('en-US', {
    useGrouping: false,
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
  const decimal = (value) =>
    value >= 1e21 && Number.isFinite(value) ? largeDecimal.format(value) : value.toFixed(3);
  const recordCells = (record, stockFactor = 1) => [
    record.sampleId,
    decimal(record.stockMgMl),
    decimal(record.targetMgMl),
    decimal(record.finalMl),
    decimal(record.stockMl * stockFactor),
    decimal(record.diluentMl),
  ];
  const sorted = (records) =>
    [...records].sort((a, b) => (a.sampleId < b.sampleId ? -1 : a.sampleId > b.sampleId ? 1 : 0));
  const message = (text = '', error = false) => {
    messages.replaceChildren();
    if (!text) return;
    const paragraph = document.createElement('p');
    paragraph.className = error ? 'alert' : 'status-message';
    paragraph.setAttribute('role', error ? 'alert' : 'status');
    paragraph.textContent = text;
    messages.append(paragraph);
  };
  const invalidRecord = (record) =>
    !record ||
    typeof record !== 'object' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(record.sampleId) ||
    ['stockMgMl', 'targetMgMl', 'finalMl', 'stockMl', 'diluentMl'].some(
      (field) => !Number.isFinite(record[field]) || record[field] < 0,
    );
  function loadRecords() {
    let stored;
    try {
      stored = localStorage.getItem(key);
    } catch {
      throw new Error(
        'Browser storage is unavailable. Allow local storage to retain preparations.',
      );
    }
    if (stored === null) return [];
    let records;
    try {
      const data = JSON.parse(stored);
      records = data.schema_version === 1 ? data.records : undefined;
    } catch {
      throw new Error('Saved browser data cannot be read. Clear this workspace before continuing.');
    }
    if (
      !Array.isArray(records) ||
      records.length > 500 ||
      records.some(invalidRecord) ||
      new Set(records.map((record) => record.sampleId)).size !== records.length
    )
      throw new Error('Saved browser data is invalid. Clear this workspace before continuing.');
    return records;
  }
  function saveRecords(records) {
    try {
      localStorage.setItem(key, JSON.stringify({ schema_version: 1, records }));
    } catch {
      throw new Error('Preparation was not saved. Browser storage is unavailable or full.');
    }
  }
  function renderRecords(records) {
    const rows = document.querySelector('#record-rows');
    rows.replaceChildren();
    for (const record of sorted(records ?? [])) {
      const row = document.createElement('tr');
      row.dataset.testid = `record-${record.sampleId}`;
      for (const value of recordCells(record)) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      rows.append(row);
    }
    document.querySelector('#record-count').textContent = records
      ? `${records.length} saved preparation${records.length === 1 ? '' : 's'}`
      : 'Saved preparations unavailable';
    document.querySelector('#empty-records').hidden = !records || records.length > 0;
  }
  function refreshRecords() {
    try {
      renderRecords(loadRecords());
    } catch (error) {
      renderRecords();
      message(error.message, true);
    }
  }
  function calculate(fields, records) {
    const sampleId = (fields.sampleId ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(sampleId))
      throw new Error(
        'Sample ID must be 1 to 32 letters, numbers, periods, hyphens, or underscores, starting with a letter or number.',
      );
    const number = (name, label) => {
      const text = (fields[name] ?? '').trim();
      const value = Number(text);
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) || !Number.isFinite(value))
        throw new Error(`${label} must be a finite number.`);
      return value;
    };
    const normalize = (value, divisor, label) => {
      const normalized = value / divisor;
      if (value > 0 && normalized === 0)
        throw new Error(`${label} cannot be represented after unit normalization.`);
      return normalized;
    };
    const concentration = (value, unit, label) => {
      if (!['mg/mL', 'ug/mL'].includes(unit))
        throw new Error(`${label} unit must be mg/mL or ug/mL.`);
      // Seeded defect: a misplaced decimal produces a tenfold microgram conversion error.
      const normalized = normalize(value, unit === 'ug/mL' ? (faulty ? 100 : 1000) : 1, label);
      if (normalized <= 0) throw new Error(`${label} must be greater than zero.`);
      return normalized;
    };
    const stockMgMl = concentration(
      number('stockConcentration', 'Stock concentration'),
      fields.stockUnit,
      'Stock concentration',
    );
    const targetMgMl = concentration(
      number('targetConcentration', 'Target concentration'),
      fields.targetUnit,
      'Target concentration',
    );
    if (targetMgMl > stockMgMl)
      throw new Error('Target concentration must not exceed stock concentration.');
    if (!['mL', 'uL'].includes(fields.volumeUnit)) throw new Error('Volume unit must be mL or uL.');
    const finalMl = normalize(
      number('finalVolume', 'Final volume'),
      fields.volumeUnit === 'uL' ? 1000 : 1,
      'Final volume',
    );
    // Seeded defect: zero is accepted as a final preparation volume.
    if (faulty ? finalMl < 0 : finalMl <= 0)
      throw new Error('Final volume must be greater than zero.');
    // Seeded defect: duplicate detection is skipped and the original record is replaced on save.
    if (!faulty && records.some((record) => record.sampleId === sampleId))
      throw new Error('Sample ID already exists. The original record is unchanged.');
    let stockMl = (targetMgMl / stockMgMl) * finalMl;
    if (stockMl === 0 && finalMl > 0) stockMl = (targetMgMl * finalMl) / stockMgMl;
    const diluentMl = finalMl - stockMl;
    if (!Number.isFinite(stockMl) || !Number.isFinite(diluentMl) || (finalMl > 0 && stockMl <= 0))
      throw new Error('The calculated volumes cannot be represented.');
    return { sampleId, stockMgMl, targetMgMl, finalMl, stockMl, diluentMl };
  }
  function showScreen() {
    const records = location.hash === '#records';
    document.querySelector('#prepare-screen').hidden = records;
    document.querySelector('#records-screen').hidden = !records;
    for (const [selector, active] of [
      ['#prepare-link', !records],
      ['#records-link', records],
    ]) {
      const link = document.querySelector(selector);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    document.title = `${records ? 'Saved preparations' : 'Prepare a dilution'} · Dilution Bench`;
    if (records) refreshRecords();
  }
  try {
    if (!['correct', 'faulty'].includes(mode))
      throw new Error('This application build has an invalid mode.');
    if (parameters.getAll('workspace').length > 1 || !/^[A-Za-z0-9_-]{8,80}$/.test(workspace))
      throw new Error(
        'Workspace ID must contain 8 to 80 letters, digits, underscores, or hyphens.',
      );
    document.querySelector('[data-testid="workspace-id"]').textContent = workspace;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      result.hidden = true;
      message();
      try {
        const records = loadRecords();
        const record = calculate(Object.fromEntries(new FormData(form)), records);
        const retained = records.filter((item) => item.sampleId !== record.sampleId);
        if (retained.length >= 500)
          throw new Error('Preparation capacity reached. Clear this workspace before adding more.');
        retained.push(record);
        saveRecords(retained);
        renderRecords(retained);
        for (const [name, value] of Object.entries({
          'sample-id': record.sampleId,
          'stock-volume': decimal(record.stockMl),
          'diluent-volume': decimal(record.diluentMl),
          'target-concentration': decimal(record.targetMgMl),
        }))
          document.querySelector(`[data-testid="result-${name}"]`).textContent = value;
        result.hidden = false;
      } catch (error) {
        message(error.message, true);
      }
    });
    document.querySelector('#clear-preparations').addEventListener('click', () => {
      try {
        localStorage.removeItem(key);
        renderRecords([]);
        result.hidden = true;
        form.reset();
        message('Preparations cleared for this browser workspace.');
      } catch {
        message('Browser storage could not be cleared. Preparations have not been changed.', true);
      }
    });
    document.querySelector('#download-link').addEventListener('click', (event) => {
      event.preventDefault();
      try {
        const records = sorted(loadRecords());
        // Seeded defect: microliter stock values are exported below an mL column heading.
        const factor = faulty ? 1000 : 1;
        const csv =
          [columns, ...records.map((record) => recordCells(record, factor))]
            .map((row) => row.join(','))
            .join('\r\n') + '\r\n';
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'dilution-preparations.csv';
        anchor.hidden = true;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) {
        message(error.message, true);
      }
    });
    window.addEventListener('hashchange', showScreen);
    window.addEventListener('storage', (event) => {
      if (event.key === key || event.key === null) {
        result.hidden = true;
        refreshRecords();
      }
    });
    if (location.hash !== '#records') refreshRecords();
    showScreen();
    document.body.dataset.appReady = 'true';
  } catch (error) {
    message(error.message, true);
    for (const element of document.querySelectorAll('input, select, button'))
      element.disabled = true;
    document.querySelector('#download-link').removeAttribute('href');
  }
})();
