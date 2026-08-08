// ==UserScript==
// @name         DeepSeek 全量 Token 用量统计
// @namespace    https://platform.deepseek.com/
// @version      1.2.0
// @description  按时间分段汇总 DeepSeek API 的全部 Token 用量、请求数、缓存命中率和费用
// @author       Codex
// @match        https://platform.deepseek.com/usage*
// @icon         https://platform.deepseek.com/favicon.ico
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  const ROOT_ID = "ds-total-usage-root";
  const STYLE_ID = "ds-total-usage-style";
  const DEFAULT_START_DATE = "2023-01-01";
  const CONCURRENCY = 3;
  const TIME_ZONE_SECONDS = -new Date().getTimezoneOffset() * 60;
  const API_ROOT = "/api/v0/usage/by_api_key";
  const CACHE_VERSION = 1;
  const CACHE_KEY_PREFIX = "ds-total-usage-cache-v1";
  const LIVE_CACHE_TTL = 5 * 60 * 1000;
  const MAX_CACHE_ENTRIES = 240;
  const numberFormatter = new Intl.NumberFormat("zh-CN");
  const percentFormatter = new Intl.NumberFormat("zh-CN", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  const state = {
    controller: null,
    running: false,
    calendarController: null,
    calendarData: null,
    persistentCache: null,
    persistentCacheKey: null,
    cacheWriteFailed: false,
  };

  function getToday() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function getCurrentMonth() {
    return getToday().slice(0, 7);
  }

  function dateToEpoch(dateText) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
    if (!match) {
      throw new Error("日期格式无效");
    }

    const [, year, month, day] = match.map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 1000) - TIME_ZONE_SECONDS;
  }

  function monthToRange(monthText) {
    const match = /^(\d{4})-(\d{2})$/.exec(monthText);
    if (!match) {
      throw new Error("月份格式无效");
    }

    const [, year, month] = match.map(Number);
    const start = Math.floor(Date.UTC(year, month - 1, 1) / 1000) - TIME_ZONE_SECONDS;
    const end = Math.floor(Date.UTC(year, month, 1) / 1000) - TIME_ZONE_SECONDS;
    return { year, month, start, end };
  }

  function shiftMonth(monthText, offset) {
    const { year, month } = monthToRange(monthText);
    const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  function epochToDateKey(epoch) {
    return new Date((epoch + TIME_ZONE_SECONDS) * 1000).toISOString().slice(0, 10);
  }

  function getMonthQueryRange(monthText) {
    const range = monthToRange(monthText);
    if (monthText === getCurrentMonth()) {
      return { ...range, end: Math.min(range.end, dateToEpoch(getToday()) + 86400) };
    }
    return range;
  }

  function getSessionToken() {
    const raw = localStorage.getItem("userToken");
    if (!raw) {
      throw new Error("未找到登录会话，请重新登录 DeepSeek 开放平台");
    }

    let stored = raw;
    try {
      stored = JSON.parse(raw);
    } catch {
      // Some older platform builds stored the token as plain text.
    }

    const token = typeof stored === "string" ? stored : stored?.value || stored?.token;
    if (!token || typeof token !== "string") {
      throw new Error("登录会话格式无法识别，请重新登录后再试");
    }
    return token;
  }

  function buildChunks(start, endExclusive) {
    const chunks = [];
    let cursor = start;
    while (cursor < endExclusive) {
      const monthText = epochToDateKey(cursor).slice(0, 7);
      const monthEnd = monthToRange(monthText).end;
      const end = Math.min(monthEnd, endExclusive);
      chunks.push({ start: cursor, end, monthText });
      cursor = end;
    }
    return chunks;
  }

  function stableHash(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function getPersistentCacheKey() {
    let accountId = "default";
    try {
      const userInfo = JSON.parse(localStorage.getItem("__appKit_userInfo") || "null");
      if (userInfo?.value?.id != null) accountId = String(userInfo.value.id);
    } catch {
      // The cache remains isolated to this browser origin when user info is unavailable.
    }
    return `${CACHE_KEY_PREFIX}-${stableHash(accountId)}`;
  }

  function getPersistentCache() {
    const storageKey = getPersistentCacheKey();
    if (state.persistentCache && state.persistentCacheKey === storageKey) {
      return state.persistentCache;
    }

    let cache = { version: CACHE_VERSION, ranges: {} };
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (stored?.version === CACHE_VERSION && stored.ranges && typeof stored.ranges === "object") {
        cache = stored;
      }
    } catch {
      // Invalid or outdated cache data is replaced on the next successful query.
    }

    state.persistentCacheKey = storageKey;
    state.persistentCache = cache;
    state.cacheWriteFailed = false;
    return cache;
  }

  function savePersistentCache() {
    if (!state.persistentCache || !state.persistentCacheKey) return;
    try {
      localStorage.setItem(state.persistentCacheKey, JSON.stringify(state.persistentCache));
      state.cacheWriteFailed = false;
    } catch {
      state.cacheWriteFailed = true;
    }
  }

  function serializeCounters(counters) {
    return {
      requests: counters.requests,
      cacheHit: counters.cacheHit,
      cacheMiss: counters.cacheMiss,
      output: counters.output,
      costs: Object.fromEntries(counters.costs),
    };
  }

  function deserializeCounters(value) {
    const counters = createCounters();
    counters.requests = Number(value?.requests) || 0;
    counters.cacheHit = Number(value?.cacheHit) || 0;
    counters.cacheMiss = Number(value?.cacheMiss) || 0;
    counters.output = Number(value?.output) || 0;
    for (const [currency, cost] of Object.entries(value?.costs || {})) {
      counters.costs.set(currency, Number(cost) || 0);
    }
    return counters;
  }

  function serializeAggregate(aggregate) {
    return {
      summary: serializeCounters(aggregate.summary),
      models: Object.fromEntries(
        [...aggregate.models.entries()].map(([name, counters]) => [name, serializeCounters(counters)]),
      ),
      days: Object.fromEntries(
        [...aggregate.days.entries()].map(([date, counters]) => [date, serializeCounters(counters)]),
      ),
    };
  }

  function deserializeAggregate(value) {
    const aggregate = createAggregate();
    aggregate.summary = deserializeCounters(value?.summary);
    for (const [name, counters] of Object.entries(value?.models || {})) {
      aggregate.models.set(name, deserializeCounters(counters));
    }
    for (const [date, counters] of Object.entries(value?.days || {})) {
      aggregate.days.set(date, deserializeCounters(counters));
    }
    return aggregate;
  }

  function getRangeCacheKey(start, end) {
    return `${start}:${end}`;
  }

  function getCachedAggregate(start, end) {
    const cache = getPersistentCache();
    const entry = cache.ranges[getRangeCacheKey(start, end)];
    if (!entry) return null;

    const currentMonthStart = monthToRange(getCurrentMonth()).start;
    const immutable = end <= currentMonthStart;
    if (!immutable && Date.now() - Number(entry.fetchedAt) > LIVE_CACHE_TTL) {
      return null;
    }

    try {
      return deserializeAggregate(entry.aggregate);
    } catch {
      delete cache.ranges[getRangeCacheKey(start, end)];
      savePersistentCache();
      return null;
    }
  }

  function storeCachedAggregate(start, end, aggregate) {
    const cache = getPersistentCache();
    const now = Date.now();
    const currentMonthStart = monthToRange(getCurrentMonth()).start;

    for (const [key, entry] of Object.entries(cache.ranges)) {
      if (Number(entry.end) > currentMonthStart && now - Number(entry.fetchedAt) > LIVE_CACHE_TTL) {
        delete cache.ranges[key];
      }
    }

    cache.ranges[getRangeCacheKey(start, end)] = {
      start,
      end,
      fetchedAt: now,
      aggregate: serializeAggregate(aggregate),
    };

    const entries = Object.entries(cache.ranges);
    if (entries.length > MAX_CACHE_ENTRIES) {
      entries
        .sort(([, left], [, right]) => Number(left.fetchedAt) - Number(right.fetchedAt))
        .slice(0, entries.length - MAX_CACHE_ENTRIES)
        .forEach(([key]) => delete cache.ranges[key]);
    }
    savePersistentCache();
  }

  function wait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(resolve, milliseconds);
      signal.addEventListener(
        "abort",
        () => {
          window.clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }

  async function requestUsage(path, token, signal) {
    let lastError;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(path, {
          credentials: "same-origin",
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });

        let payload;
        try {
          payload = await response.json();
        } catch {
          throw new Error(`接口返回了无法解析的数据（HTTP ${response.status}）`);
        }

        const business = payload?.data;
        const failed =
          !response.ok ||
          payload?.code !== 0 ||
          business?.biz_code !== 0 ||
          !business?.biz_data;

        if (!failed) {
          return business.biz_data;
        }

        const message = business?.biz_msg || payload?.msg || `HTTP ${response.status}`;
        if (response.status === 401 || response.status === 403 || payload?.code === 40003) {
          throw new Error("登录会话已失效，请重新登录 DeepSeek 开放平台");
        }

        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          lastError = new Error(message);
          await wait(700 * 2 ** attempt, signal);
          continue;
        }

        throw new Error(`DeepSeek 接口错误：${message}`);
      } catch (error) {
        if (error.name === "AbortError") {
          throw error;
        }
        lastError = error;
        if (attempt < 2 && error instanceof TypeError) {
          await wait(700 * 2 ** attempt, signal);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error("请求失败");
  }

  function createCounters() {
    return {
      requests: 0,
      cacheHit: 0,
      cacheMiss: 0,
      output: 0,
      costs: new Map(),
    };
  }

  function createAggregate() {
    return {
      summary: createCounters(),
      models: new Map(),
      days: new Map(),
    };
  }

  function getModelCounters(aggregate, modelName) {
    if (!aggregate.models.has(modelName)) {
      aggregate.models.set(modelName, createCounters());
    }
    return aggregate.models.get(modelName);
  }

  function addUsage(counters, usage) {
    counters.requests += Number(usage?.REQUEST) || 0;
    counters.cacheHit += Number(usage?.PROMPT_CACHE_HIT_TOKEN) || 0;
    counters.cacheMiss += Number(usage?.PROMPT_CACHE_MISS_TOKEN) || 0;
    counters.output += Number(usage?.RESPONSE_TOKEN) || 0;
  }

  function mergeAmount(aggregate, data) {
    for (const series of data?.series || []) {
      const modelName = series.model || "未知模型";
      const model = getModelCounters(aggregate, modelName);

      for (const bucket of series.buckets || []) {
        addUsage(aggregate.summary, bucket.usage);
        addUsage(model, bucket.usage);
        if (Number.isFinite(Number(bucket.time))) {
          const dateKey = epochToDateKey(Number(bucket.time));
          if (!aggregate.days.has(dateKey)) aggregate.days.set(dateKey, createCounters());
          addUsage(aggregate.days.get(dateKey), bucket.usage);
        }
      }
    }
  }

  function addCost(counters, currency, value) {
    counters.costs.set(currency, (counters.costs.get(currency) || 0) + value);
  }

  function mergeCost(aggregate, data) {
    for (const currencyGroup of data?.data || []) {
      const currency = currencyGroup.currency || "CNY";

      for (const series of currencyGroup.series || []) {
        const modelName = series.model || "未知模型";
        const model = getModelCounters(aggregate, modelName);

        for (const bucket of series.buckets || []) {
          const value = Number(bucket.cost) || 0;
          addCost(aggregate.summary, currency, value);
          addCost(model, currency, value);
          if (Number.isFinite(Number(bucket.time))) {
            const dateKey = epochToDateKey(Number(bucket.time));
            if (!aggregate.days.has(dateKey)) aggregate.days.set(dateKey, createCounters());
            addCost(aggregate.days.get(dateKey), currency, value);
          }
        }
      }
    }
  }

  function mergeCounters(target, source) {
    target.requests += source.requests;
    target.cacheHit += source.cacheHit;
    target.cacheMiss += source.cacheMiss;
    target.output += source.output;
    for (const [currency, value] of source.costs) addCost(target, currency, value);
  }

  function mergeAggregate(target, source) {
    mergeCounters(target.summary, source.summary);
    for (const [modelName, counters] of source.models) {
      mergeCounters(getModelCounters(target, modelName), counters);
    }
    for (const [dateKey, counters] of source.days) {
      if (!target.days.has(dateKey)) target.days.set(dateKey, createCounters());
      mergeCounters(target.days.get(dateKey), counters);
    }
  }

  function getInputTokens(counters) {
    return counters.cacheHit + counters.cacheMiss;
  }

  function getTotalTokens(counters) {
    return getInputTokens(counters) + counters.output;
  }

  function getCacheHitRate(counters) {
    const input = getInputTokens(counters);
    return input ? counters.cacheHit / input : 0;
  }

  function formatNumber(value) {
    return numberFormatter.format(Math.round(value));
  }

  function formatCompactNumber(value) {
    const absolute = Math.abs(value);
    const units = [
      [1_000_000_000, "B"],
      [1_000_000, "M"],
      [1_000, "K"],
    ];

    for (const [divisor, suffix] of units) {
      if (absolute >= divisor) {
        const scaled = value / divisor;
        const digits = Math.abs(scaled) >= 100 ? 0 : 1;
        return `${scaled.toFixed(digits).replace(/\.0$/, "")}${suffix}`;
      }
    }
    return String(Math.round(value));
  }

  function formatCostValue(currency, value, compact = false) {
    const digits = compact || value === 0 || Math.abs(value) >= 0.01 ? 2 : 6;
    const amount = value.toLocaleString("zh-CN", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });

    if (currency === "CNY") return `¥${amount}`;
    if (currency === "USD") return `$${amount}`;
    return `${currency} ${amount}`;
  }

  function formatCosts(costs, compact = false) {
    if (!costs.size) return "—";
    return [...costs.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, value]) => formatCostValue(currency, value, compact))
      .join(" / ");
  }

  function setStatus(elements, message, kind = "normal") {
    elements.status.textContent = message;
    elements.status.dataset.kind = kind;
  }

  function setRunning(elements, running) {
    state.running = running;
    elements.run.disabled = running;
    elements.start.disabled = running;
    elements.end.disabled = running;
    elements.cancel.hidden = !running;
    elements.progress.hidden = !running;
  }

  function updateMetric(elements, key, value) {
    const target = elements.results.querySelector(`[data-metric="${key}"]`);
    if (target) target.textContent = value;
  }

  function renderResults(elements, aggregate, startDate, endDate) {
    const { summary } = aggregate;
    updateMetric(elements, "total", formatNumber(getTotalTokens(summary)));
    updateMetric(elements, "input", formatNumber(getInputTokens(summary)));
    updateMetric(elements, "output", formatNumber(summary.output));
    updateMetric(elements, "requests", formatNumber(summary.requests));
    updateMetric(elements, "hit-rate", percentFormatter.format(getCacheHitRate(summary)));
    updateMetric(elements, "cost", formatCosts(summary.costs, true));

    const rows = [...aggregate.models.entries()]
      .filter(([, counters]) => getTotalTokens(counters) || counters.requests || counters.costs.size)
      .sort(([, left], [, right]) => getTotalTokens(right) - getTotalTokens(left));

    elements.tableBody.replaceChildren(
      ...rows.map(([modelName, counters]) => {
        const row = document.createElement("tr");
        const values = [
          modelName,
          formatNumber(counters.requests),
          formatNumber(counters.cacheHit),
          formatNumber(counters.cacheMiss),
          formatNumber(counters.output),
          formatNumber(getTotalTokens(counters)),
          percentFormatter.format(getCacheHitRate(counters)),
          formatCosts(counters.costs),
        ];

        for (const [index, value] of values.entries()) {
          const cell = document.createElement("td");
          cell.textContent = value;
          if (index > 0) cell.className = "ds-tu-number";
          row.append(cell);
        }
        return row;
      }),
    );

    elements.range.textContent = `${startDate} 至 ${endDate}`;
    elements.results.hidden = false;
  }

  function updateCalendarMetric(elements, key, value) {
    const target = elements.calendarView.querySelector(`[data-calendar-metric="${key}"]`);
    if (target) target.textContent = value;
  }

  function renderDayDetail(elements, dateKey) {
    const aggregate = state.calendarData?.aggregate;
    if (!aggregate) return;

    const counters = aggregate.days.get(dateKey) || createCounters();
    elements.calendarGrid.querySelectorAll(".ds-tu-day").forEach((cell) => {
      cell.classList.toggle("is-selected", cell.dataset.date === dateKey);
    });
    elements.dayDate.textContent = dateKey;
    elements.dayTotal.textContent = formatNumber(getTotalTokens(counters));
    elements.dayInput.textContent = formatNumber(getInputTokens(counters));
    elements.dayOutput.textContent = formatNumber(counters.output);
    elements.dayRequests.textContent = formatNumber(counters.requests);
    elements.dayHitRate.textContent = percentFormatter.format(getCacheHitRate(counters));
  }

  function renderCalendar(elements, aggregate, monthText) {
    const { year, month } = monthToRange(monthText);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
    const dailyTotals = Array.from({ length: daysInMonth }, (_, index) => {
      const dateKey = `${monthText}-${String(index + 1).padStart(2, "0")}`;
      return getTotalTokens(aggregate.days.get(dateKey) || createCounters());
    });
    const maxDaily = Math.max(0, ...dailyTotals);
    const cells = [];

    for (let index = 0; index < 42; index += 1) {
      const dayNumber = index - firstWeekday + 1;
      if (dayNumber < 1 || dayNumber > daysInMonth) {
        const empty = document.createElement("div");
        empty.className = "ds-tu-day ds-tu-day-empty";
        empty.setAttribute("aria-hidden", "true");
        cells.push(empty);
        continue;
      }

      const dateKey = `${monthText}-${String(dayNumber).padStart(2, "0")}`;
      const counters = aggregate.days.get(dateKey) || createCounters();
      const total = getTotalTokens(counters);
      const intensity = total && maxDaily ? 0.08 + 0.42 * Math.sqrt(total / maxDaily) : 0;
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "ds-tu-day";
      cell.dataset.date = dateKey;
      if (dateKey > getToday()) {
        cell.classList.add("is-future");
        cell.disabled = true;
      }
      cell.style.setProperty("--heat", String(intensity));
      cell.setAttribute(
        "aria-label",
        `${dateKey}，${formatNumber(total)} Tokens，${formatNumber(counters.requests)} 次请求`,
      );
      cell.title = `${dateKey}\n总 Tokens：${formatNumber(total)}\n输入：${formatNumber(getInputTokens(counters))}\n输出：${formatNumber(counters.output)}\n请求：${formatNumber(counters.requests)}`;

      const number = document.createElement("span");
      number.className = "ds-tu-day-number";
      number.textContent = String(dayNumber);
      const tokens = document.createElement("span");
      tokens.className = "ds-tu-day-tokens";
      tokens.textContent = formatCompactNumber(total);
      const requests = document.createElement("span");
      requests.className = "ds-tu-day-requests";
      requests.textContent = `${formatCompactNumber(counters.requests)} 次`;
      cell.append(number, tokens, requests);
      cells.push(cell);
    }

    state.calendarData = { monthText, aggregate };
    elements.calendarGrid.replaceChildren(...cells);
    updateCalendarMetric(elements, "total", formatNumber(getTotalTokens(aggregate.summary)));
    updateCalendarMetric(elements, "input", formatNumber(getInputTokens(aggregate.summary)));
    updateCalendarMetric(elements, "output", formatNumber(aggregate.summary.output));
    updateCalendarMetric(elements, "requests", formatNumber(aggregate.summary.requests));

    const today = getToday();
    const nonzeroDates = [...aggregate.days.entries()]
      .filter(([dateKey, counters]) => dateKey.startsWith(monthText) && getTotalTokens(counters) > 0)
      .map(([dateKey]) => dateKey)
      .sort();
    const todayCounters = aggregate.days.get(today);
    const selectedDate =
      today.startsWith(monthText) && todayCounters && getTotalTokens(todayCounters) > 0
        ? today
        : nonzeroDates.at(-1) || `${monthText}-01`;
    renderDayDetail(elements, selectedDate);
  }

  function setCalendarStatus(elements, message, kind = "normal") {
    elements.calendarStatus.textContent = message;
    elements.calendarStatus.dataset.kind = kind;
  }

  function syncCalendarNavigation(elements) {
    elements.previousMonth.disabled = elements.month.value <= elements.month.min;
    elements.nextMonth.disabled = elements.month.value >= elements.month.max;
  }

  async function loadCalendar(elements, force = false) {
    const monthText = elements.month.value;
    const { start, end } = getMonthQueryRange(monthText);
    syncCalendarNavigation(elements);

    if (!force) {
      const cached = getCachedAggregate(start, end);
      if (cached) {
        renderCalendar(elements, cached, monthText);
        setCalendarStatus(elements, `${monthText}，缓存命中`, "success");
        return;
      }
    }

    state.calendarController?.abort();
    const controller = new AbortController();
    state.calendarController = controller;
    elements.calendarProgress.hidden = false;
    elements.month.disabled = true;
    elements.previousMonth.disabled = true;
    elements.nextMonth.disabled = true;
    setCalendarStatus(elements, `正在加载 ${monthText}`);

    try {
      const token = getSessionToken();
      const query = new URLSearchParams({
        start: String(start),
        end: String(end),
        tz: String(TIME_ZONE_SECONDS),
      });
      const [amount, cost] = await Promise.all([
        requestUsage(`${API_ROOT}/amount?${query}`, token, controller.signal),
        requestUsage(`${API_ROOT}/cost?${query}`, token, controller.signal),
      ]);
      const aggregate = createAggregate();
      mergeAmount(aggregate, amount);
      mergeCost(aggregate, cost);
      storeCachedAggregate(start, end, aggregate);
      renderCalendar(elements, aggregate, monthText);
      const cacheNote = state.cacheWriteFailed ? "，缓存写入失败" : "，已写入缓存";
      setCalendarStatus(
        elements,
        `${monthText}，共 ${formatNumber(getTotalTokens(aggregate.summary))} Tokens${cacheNote}`,
        state.cacheWriteFailed ? "error" : "success",
      );
    } catch (error) {
      if (error.name !== "AbortError" && state.calendarController === controller) {
        setCalendarStatus(elements, error.message || "日历加载失败", "error");
      }
    } finally {
      if (state.calendarController === controller) {
        state.calendarController = null;
        elements.calendarProgress.hidden = true;
        elements.month.disabled = false;
        syncCalendarNavigation(elements);
      }
    }
  }

  function changeCalendarMonth(elements, offset) {
    const next = shiftMonth(elements.month.value, offset);
    if (next < elements.month.min || next > elements.month.max) return;
    elements.month.value = next;
    loadCalendar(elements);
  }

  function setActiveView(elements, viewName) {
    elements.tabs.forEach((tab) => {
      const active = tab.dataset.view === viewName;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    elements.overviewView.hidden = viewName !== "overview";
    elements.calendarView.hidden = viewName !== "calendar";
    if (viewName === "calendar" && !state.calendarData) {
      loadCalendar(elements);
    }
  }

  async function runStatistics(elements) {
    if (state.running) return;

    const startDate = elements.start.value;
    const endDate = elements.end.value;
    let start;
    let endExclusive;

    try {
      start = dateToEpoch(startDate);
      endExclusive = dateToEpoch(endDate) + 86400;
      if (start >= endExclusive) {
        throw new Error("起始日期不能晚于结束日期");
      }
    } catch (error) {
      setStatus(elements, error.message, "error");
      return;
    }

    const controller = new AbortController();
    state.controller = controller;
    setRunning(elements, true);
    elements.results.hidden = true;

    try {
      const token = getSessionToken();
      const chunks = buildChunks(start, endExclusive);
      const aggregate = createAggregate();
      let nextChunk = 0;
      let completed = 0;
      let cacheHits = 0;
      let networkQueries = 0;

      elements.progress.max = chunks.length;
      elements.progress.value = 0;
      setStatus(elements, `正在统计 0/${chunks.length}`);

      async function worker() {
        while (nextChunk < chunks.length) {
          const index = nextChunk;
          nextChunk += 1;
          const chunk = chunks[index];
          const cached = getCachedAggregate(chunk.start, chunk.end);
          if (cached) {
            mergeAggregate(aggregate, cached);
            cacheHits += 1;
            completed += 1;
            elements.progress.value = completed;
            setStatus(elements, `正在统计 ${completed}/${chunks.length}，缓存命中 ${cacheHits}`);
            continue;
          }

          const query = new URLSearchParams({
            start: String(chunk.start),
            end: String(chunk.end),
            tz: String(TIME_ZONE_SECONDS),
          });

          const [amount, cost] = await Promise.all([
            requestUsage(`${API_ROOT}/amount?${query}`, token, controller.signal),
            requestUsage(`${API_ROOT}/cost?${query}`, token, controller.signal),
          ]);

          const chunkAggregate = createAggregate();
          mergeAmount(chunkAggregate, amount);
          mergeCost(chunkAggregate, cost);
          mergeAggregate(aggregate, chunkAggregate);
          storeCachedAggregate(chunk.start, chunk.end, chunkAggregate);
          networkQueries += 1;
          completed += 1;
          elements.progress.value = completed;
          setStatus(elements, `正在统计 ${completed}/${chunks.length}，缓存命中 ${cacheHits}`);
        }
      }

      const workerCount = Math.min(CONCURRENCY, chunks.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      renderResults(elements, aggregate, startDate, endDate);
      const cacheNote = state.cacheWriteFailed ? "，缓存写入失败" : "";
      setStatus(
        elements,
        `统计完成，复用 ${cacheHits} 个缓存，查询 ${networkQueries} 个时间段${cacheNote}`,
        state.cacheWriteFailed ? "error" : "success",
      );
    } catch (error) {
      if (error.name === "AbortError") {
        setStatus(elements, "已取消", "normal");
      } else {
        setStatus(elements, error.message || "统计失败", "error");
      }
    } finally {
      state.controller = null;
      setRunning(elements, false);
    }
  }

  function createStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID}, #${ROOT_ID} * { box-sizing: border-box; letter-spacing: 0; }
      #${ROOT_ID} { color: #1d262d; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      #${ROOT_ID} .ds-tu-launcher {
        position: fixed; right: 24px; bottom: 24px; z-index: 2147483000;
        display: inline-flex; align-items: center; gap: 8px; height: 42px;
        padding: 0 15px; border: 1px solid #075f46; border-radius: 6px;
        color: #fff; background: #087a59; box-shadow: 0 5px 16px rgba(0, 0, 0, .18);
        font: 600 14px/1 inherit; cursor: pointer;
      }
      #${ROOT_ID} .ds-tu-launcher:hover { background: #066b4e; }
      #${ROOT_ID} .ds-tu-launcher:focus-visible,
      #${ROOT_ID} button:focus-visible,
      #${ROOT_ID} input:focus-visible { outline: 3px solid rgba(24, 119, 242, .28); outline-offset: 2px; }
      #${ROOT_ID} .ds-tu-sigma { font-size: 18px; line-height: 1; }
      #${ROOT_ID} .ds-tu-dialog {
        width: min(960px, calc(100vw - 32px)); max-height: min(780px, calc(100vh - 32px));
        margin: auto; padding: 0; overflow: hidden; border: 1px solid #ccd5da;
        border-radius: 8px; color: #1d262d; background: #fff;
        box-shadow: 0 24px 72px rgba(0, 0, 0, .24);
      }
      #${ROOT_ID} .ds-tu-dialog::backdrop { background: rgba(20, 29, 35, .46); }
      #${ROOT_ID} .ds-tu-shell { display: flex; flex-direction: column; max-height: min(780px, calc(100vh - 32px)); }
      #${ROOT_ID} .ds-tu-header {
        display: flex; align-items: center; justify-content: space-between; gap: 16px;
        min-height: 58px; padding: 12px 18px; border-bottom: 1px solid #e1e6e9;
      }
      #${ROOT_ID} .ds-tu-title { margin: 0; font-size: 18px; line-height: 1.35; font-weight: 700; }
      #${ROOT_ID} .ds-tu-range { margin-top: 2px; color: #66747d; font-size: 12px; min-height: 16px; }
      #${ROOT_ID} .ds-tu-icon-button {
        flex: 0 0 34px; width: 34px; height: 34px; padding: 0; border: 1px solid transparent;
        border-radius: 6px; color: #53616a; background: transparent; font: 24px/30px inherit; cursor: pointer;
      }
      #${ROOT_ID} .ds-tu-icon-button:hover { border-color: #d6dde1; background: #f2f5f6; }
      #${ROOT_ID} .ds-tu-content { padding: 16px 18px 20px; overflow: auto; }
      #${ROOT_ID} .ds-tu-tabs {
        display: inline-flex; gap: 2px; margin-bottom: 14px; padding: 3px;
        border: 1px solid #d7dfe3; border-radius: 6px; background: #f3f6f7;
      }
      #${ROOT_ID} .ds-tu-tab {
        height: 32px; padding: 0 14px; border: 0; border-radius: 4px;
        color: #5b6971; background: transparent; font: 600 13px/1 inherit; cursor: pointer;
      }
      #${ROOT_ID} .ds-tu-tab:hover { color: #253139; background: #e8edef; }
      #${ROOT_ID} .ds-tu-tab.is-active { color: #fff; background: #087a59; }
      #${ROOT_ID} .ds-tu-controls {
        display: grid; grid-template-columns: minmax(150px, 1fr) minmax(150px, 1fr) auto auto;
        align-items: end; gap: 10px;
      }
      #${ROOT_ID} .ds-tu-field { display: grid; gap: 5px; min-width: 0; color: #55636c; font-size: 12px; font-weight: 600; }
      #${ROOT_ID} .ds-tu-field input {
        width: 100%; height: 38px; padding: 0 10px; border: 1px solid #cbd4d9;
        border-radius: 6px; color: #1d262d; background: #fff; font: 14px/1 inherit;
      }
      #${ROOT_ID} .ds-tu-button {
        height: 38px; padding: 0 16px; border: 1px solid #087a59; border-radius: 6px;
        color: #fff; background: #087a59; font: 600 14px/1 inherit; cursor: pointer; white-space: nowrap;
      }
      #${ROOT_ID} .ds-tu-button:hover { background: #066b4e; }
      #${ROOT_ID} .ds-tu-button:disabled { cursor: not-allowed; opacity: .55; }
      #${ROOT_ID} .ds-tu-button-secondary { border-color: #c8d1d6; color: #37434a; background: #fff; }
      #${ROOT_ID} .ds-tu-button-secondary:hover { background: #f2f5f6; }
      #${ROOT_ID} .ds-tu-calendar-toolbar {
        display: flex; align-items: center; justify-content: space-between; gap: 14px;
      }
      #${ROOT_ID} .ds-tu-month-control { display: grid; grid-template-columns: 38px minmax(150px, 210px) 38px; gap: 6px; }
      #${ROOT_ID} .ds-tu-month-control input {
        min-width: 0; height: 38px; padding: 0 10px; border: 1px solid #cbd4d9;
        border-radius: 6px; color: #1d262d; background: #fff; font: 600 14px/1 inherit;
      }
      #${ROOT_ID} .ds-tu-month-button {
        width: 38px; height: 38px; padding: 0; border: 1px solid #c8d1d6; border-radius: 6px;
        color: #35434b; background: #fff; font: 24px/32px inherit; cursor: pointer;
      }
      #${ROOT_ID} .ds-tu-month-button:hover { background: #f2f5f6; }
      #${ROOT_ID} .ds-tu-month-button:disabled { cursor: not-allowed; opacity: .4; }
      #${ROOT_ID} .ds-tu-calendar-status-row {
        display: flex; align-items: center; justify-content: flex-end; gap: 10px; min-width: 0;
      }
      #${ROOT_ID} .ds-tu-calendar-status { color: #596870; font-size: 13px; overflow-wrap: anywhere; }
      #${ROOT_ID} .ds-tu-calendar-status[data-kind="success"] { color: #087a59; }
      #${ROOT_ID} .ds-tu-calendar-status[data-kind="error"] { color: #b42318; }
      #${ROOT_ID} .ds-tu-calendar-status-row progress { width: 90px; }
      #${ROOT_ID} .ds-tu-progress-row { display: grid; grid-template-columns: minmax(0, 1fr) 180px; align-items: center; gap: 14px; min-height: 34px; margin-top: 10px; }
      #${ROOT_ID} .ds-tu-status { color: #596870; font-size: 13px; overflow-wrap: anywhere; }
      #${ROOT_ID} .ds-tu-status[data-kind="success"] { color: #087a59; }
      #${ROOT_ID} .ds-tu-status[data-kind="error"] { color: #b42318; }
      #${ROOT_ID} progress { width: 100%; height: 8px; accent-color: #087a59; }
      #${ROOT_ID} .ds-tu-results { margin-top: 4px; }
      #${ROOT_ID} .ds-tu-metrics {
        display: grid; grid-template-columns: 1.25fr 1.25fr 1fr .85fr .85fr .9fr;
        margin: 2px 0 16px; border-top: 1px solid #dde3e6; border-bottom: 1px solid #dde3e6;
      }
      #${ROOT_ID} .ds-tu-metric { min-width: 0; padding: 14px 12px; border-right: 1px solid #e5eaec; }
      #${ROOT_ID} .ds-tu-metric:last-child { border-right: 0; }
      #${ROOT_ID} .ds-tu-metric-label { color: #697780; font-size: 12px; white-space: nowrap; }
      #${ROOT_ID} .ds-tu-metric-value { margin-top: 5px; color: #1b252b; font-size: 16px; line-height: 1.25; font-weight: 700; white-space: nowrap; }
      #${ROOT_ID} .ds-tu-metric:first-child .ds-tu-metric-value { color: #087a59; }
      #${ROOT_ID} .ds-tu-metric:last-child .ds-tu-metric-value { color: #925d00; }
      #${ROOT_ID} .ds-tu-calendar-metrics { grid-template-columns: 1.25fr 1.25fr 1fr 1fr; margin: 14px 0 0; }
      #${ROOT_ID} .ds-tu-calendar-metrics .ds-tu-metric:last-child .ds-tu-metric-value { color: #1b252b; }
      #${ROOT_ID} .ds-tu-weekdays,
      #${ROOT_ID} .ds-tu-calendar-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
      #${ROOT_ID} .ds-tu-weekdays { border: 1px solid #dbe2e5; border-bottom: 0; border-radius: 6px 6px 0 0; background: #f5f7f8; }
      #${ROOT_ID} .ds-tu-weekday { padding: 7px 4px; color: #64727a; font-size: 12px; font-weight: 700; text-align: center; }
      #${ROOT_ID} .ds-tu-calendar-grid {
        overflow: hidden; border: 1px solid #dbe2e5; border-radius: 0 0 6px 6px;
        background: #dfe5e8; gap: 1px;
      }
      #${ROOT_ID} .ds-tu-day {
        display: grid; grid-template-rows: auto 1fr auto; align-content: start; gap: 4px;
        min-width: 0; min-height: 76px; padding: 7px; border: 0; border-radius: 0;
        color: #1d292f; background: rgba(8, 122, 89, var(--heat, 0)); text-align: left; cursor: pointer;
      }
      #${ROOT_ID} .ds-tu-day:hover { box-shadow: inset 0 0 0 2px rgba(8, 122, 89, .45); }
      #${ROOT_ID} .ds-tu-day.is-selected { box-shadow: inset 0 0 0 2px #087a59; }
      #${ROOT_ID} .ds-tu-day.is-future { color: #8b969c; background: #f3f6f7; cursor: default; opacity: .72; }
      #${ROOT_ID} .ds-tu-day-empty { background: #f7f9fa; cursor: default; }
      #${ROOT_ID} .ds-tu-day-number { color: #5b6971; font-size: 11px; line-height: 1; font-weight: 700; }
      #${ROOT_ID} .ds-tu-day-tokens {
        align-self: center; min-width: 0; font-size: 15px; line-height: 1.15; font-weight: 750;
        font-variant-numeric: tabular-nums; white-space: nowrap;
      }
      #${ROOT_ID} .ds-tu-day-requests { color: #66757d; font-size: 10px; line-height: 1; white-space: nowrap; }
      #${ROOT_ID} .ds-tu-day-detail {
        display: grid; grid-template-columns: 1.25fr repeat(5, 1fr);
        margin: 0 0 14px; border-bottom: 1px solid #dde3e6;
      }
      #${ROOT_ID} .ds-tu-day-detail-item { min-width: 0; padding: 11px 12px; border-right: 1px solid #e5eaec; }
      #${ROOT_ID} .ds-tu-day-detail-item:last-child { border-right: 0; }
      #${ROOT_ID} .ds-tu-day-detail-label { color: #697780; font-size: 11px; white-space: nowrap; }
      #${ROOT_ID} .ds-tu-day-detail-value { margin-top: 4px; font-size: 14px; line-height: 1.2; font-weight: 700; white-space: nowrap; }
      #${ROOT_ID} .ds-tu-day-detail-item:first-child .ds-tu-day-detail-value { color: #087a59; }
      #${ROOT_ID} .ds-tu-table-wrap { width: 100%; overflow-x: auto; border: 1px solid #dbe2e5; border-radius: 6px; }
      #${ROOT_ID} table { width: 100%; min-width: 880px; border-collapse: collapse; font-size: 13px; }
      #${ROOT_ID} th, #${ROOT_ID} td { padding: 10px 12px; border-bottom: 1px solid #e6ebed; text-align: left; white-space: nowrap; }
      #${ROOT_ID} th { position: sticky; top: 0; color: #53616a; background: #f5f7f8; font-size: 12px; font-weight: 700; }
      #${ROOT_ID} tbody tr:last-child td { border-bottom: 0; }
      #${ROOT_ID} tbody tr:hover { background: #f8faf9; }
      #${ROOT_ID} .ds-tu-number { text-align: right; font-variant-numeric: tabular-nums; }
      #${ROOT_ID} [hidden] { display: none !important; }
      @media (max-width: 760px) {
        #${ROOT_ID} .ds-tu-launcher { right: 14px; bottom: 14px; }
        #${ROOT_ID} .ds-tu-controls { grid-template-columns: 1fr 1fr; }
        #${ROOT_ID} .ds-tu-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        #${ROOT_ID} .ds-tu-metric-value { white-space: normal; overflow-wrap: anywhere; }
        #${ROOT_ID} .ds-tu-metric:nth-child(3) { border-right: 0; }
        #${ROOT_ID} .ds-tu-metric:nth-child(-n+3) { border-bottom: 1px solid #e5eaec; }
        #${ROOT_ID} .ds-tu-calendar-toolbar { align-items: stretch; flex-direction: column; }
        #${ROOT_ID} .ds-tu-month-control { grid-template-columns: 38px minmax(0, 1fr) 38px; }
        #${ROOT_ID} .ds-tu-calendar-status-row { justify-content: space-between; min-height: 24px; }
        #${ROOT_ID} .ds-tu-calendar-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        #${ROOT_ID} .ds-tu-calendar-metrics .ds-tu-metric:nth-child(2) { border-right: 0; }
        #${ROOT_ID} .ds-tu-calendar-metrics .ds-tu-metric:nth-child(3) { border-right: 1px solid #e5eaec; border-bottom: 0; }
        #${ROOT_ID} .ds-tu-calendar-metrics .ds-tu-metric:nth-child(-n+2) { border-bottom: 1px solid #e5eaec; }
        #${ROOT_ID} .ds-tu-day { min-height: 66px; padding: 5px; gap: 3px; }
        #${ROOT_ID} .ds-tu-day-tokens { font-size: 12px; }
        #${ROOT_ID} .ds-tu-day-requests { display: none; }
        #${ROOT_ID} .ds-tu-day-detail { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        #${ROOT_ID} .ds-tu-day-detail-item:nth-child(3) { border-right: 0; }
        #${ROOT_ID} .ds-tu-day-detail-item:nth-child(-n+3) { border-bottom: 1px solid #e5eaec; }
      }
      @media (max-width: 480px) {
        #${ROOT_ID} .ds-tu-dialog { width: calc(100vw - 16px); max-height: calc(100vh - 16px); }
        #${ROOT_ID} .ds-tu-shell { max-height: calc(100vh - 16px); }
        #${ROOT_ID} .ds-tu-content { padding: 14px; }
        #${ROOT_ID} .ds-tu-controls { grid-template-columns: 1fr; }
        #${ROOT_ID} .ds-tu-progress-row { grid-template-columns: 1fr; gap: 4px; }
        #${ROOT_ID} .ds-tu-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        #${ROOT_ID} .ds-tu-metric:nth-child(3) { border-right: 1px solid #e5eaec; }
        #${ROOT_ID} .ds-tu-metric:nth-child(even) { border-right: 0; }
        #${ROOT_ID} .ds-tu-metric:nth-child(-n+4) { border-bottom: 1px solid #e5eaec; }
        #${ROOT_ID} .ds-tu-tabs { display: grid; grid-template-columns: 1fr 1fr; width: 100%; }
        #${ROOT_ID} .ds-tu-day { min-height: 58px; padding: 4px; }
        #${ROOT_ID} .ds-tu-day-tokens { font-size: 11px; }
        #${ROOT_ID} .ds-tu-day-detail-value { font-size: 12px; white-space: normal; overflow-wrap: anywhere; }
      }
    `;
    document.head.append(style);
  }

  function createRoot() {
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
      <button class="ds-tu-launcher" type="button" aria-haspopup="dialog" title="全量用量">
        <span class="ds-tu-sigma" aria-hidden="true">Σ</span>
        <span>总用量</span>
      </button>
      <dialog class="ds-tu-dialog" aria-labelledby="ds-tu-title">
        <div class="ds-tu-shell">
          <header class="ds-tu-header">
            <div>
              <h2 class="ds-tu-title" id="ds-tu-title">全量用量</h2>
              <div class="ds-tu-range" aria-live="polite"></div>
            </div>
            <button class="ds-tu-icon-button ds-tu-close" type="button" aria-label="关闭" title="关闭">×</button>
          </header>
          <div class="ds-tu-content">
            <div class="ds-tu-tabs" role="tablist" aria-label="用量视图">
              <button class="ds-tu-tab is-active" type="button" role="tab" aria-selected="true" data-view="overview">总览</button>
              <button class="ds-tu-tab" type="button" role="tab" aria-selected="false" data-view="calendar">Token 日历</button>
            </div>
            <section class="ds-tu-view ds-tu-overview-view" role="tabpanel">
              <form class="ds-tu-controls">
                <label class="ds-tu-field">
                  <span>起始日期</span>
                  <input name="start" type="date" value="${DEFAULT_START_DATE}" required>
                </label>
                <label class="ds-tu-field">
                  <span>结束日期</span>
                  <input name="end" type="date" value="${getToday()}" required>
                </label>
                <button class="ds-tu-button ds-tu-run" type="submit">统计</button>
                <button class="ds-tu-button ds-tu-button-secondary ds-tu-cancel" type="button" hidden>取消</button>
              </form>
              <div class="ds-tu-progress-row">
                <div class="ds-tu-status" role="status" aria-live="polite">等待统计</div>
                <progress class="ds-tu-summary-progress" hidden value="0" max="1"></progress>
              </div>
              <section class="ds-tu-results" hidden>
                <div class="ds-tu-metrics">
                  <div class="ds-tu-metric"><div class="ds-tu-metric-label">总 Tokens</div><div class="ds-tu-metric-value" data-metric="total">0</div></div>
                  <div class="ds-tu-metric"><div class="ds-tu-metric-label">输入 Tokens</div><div class="ds-tu-metric-value" data-metric="input">0</div></div>
                  <div class="ds-tu-metric"><div class="ds-tu-metric-label">输出 Tokens</div><div class="ds-tu-metric-value" data-metric="output">0</div></div>
                  <div class="ds-tu-metric"><div class="ds-tu-metric-label">API 请求</div><div class="ds-tu-metric-value" data-metric="requests">0</div></div>
                  <div class="ds-tu-metric"><div class="ds-tu-metric-label">缓存命中率</div><div class="ds-tu-metric-value" data-metric="hit-rate">0.0%</div></div>
                  <div class="ds-tu-metric"><div class="ds-tu-metric-label">费用</div><div class="ds-tu-metric-value" data-metric="cost">—</div></div>
                </div>
                <div class="ds-tu-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>模型</th>
                        <th class="ds-tu-number">请求</th>
                        <th class="ds-tu-number">缓存命中输入</th>
                        <th class="ds-tu-number">缓存未命中输入</th>
                        <th class="ds-tu-number">输出</th>
                        <th class="ds-tu-number">总 Tokens</th>
                        <th class="ds-tu-number">命中率</th>
                        <th class="ds-tu-number">费用</th>
                      </tr>
                    </thead>
                    <tbody></tbody>
                  </table>
                </div>
              </section>
            </section>
            <section class="ds-tu-view ds-tu-calendar-view" role="tabpanel" hidden>
              <div class="ds-tu-calendar-toolbar">
                <div class="ds-tu-month-control">
                  <button class="ds-tu-month-button ds-tu-previous-month" type="button" aria-label="上个月" title="上个月">‹</button>
                  <input class="ds-tu-month" type="month" min="2023-01" max="${getCurrentMonth()}" value="${getCurrentMonth()}" aria-label="月份">
                  <button class="ds-tu-month-button ds-tu-next-month" type="button" aria-label="下个月" title="下个月">›</button>
                </div>
                <div class="ds-tu-calendar-status-row">
                  <div class="ds-tu-calendar-status" role="status" aria-live="polite">等待加载</div>
                  <progress class="ds-tu-calendar-progress" hidden></progress>
                </div>
              </div>
              <div class="ds-tu-metrics ds-tu-calendar-metrics">
                <div class="ds-tu-metric"><div class="ds-tu-metric-label">本月 Tokens</div><div class="ds-tu-metric-value" data-calendar-metric="total">0</div></div>
                <div class="ds-tu-metric"><div class="ds-tu-metric-label">输入 Tokens</div><div class="ds-tu-metric-value" data-calendar-metric="input">0</div></div>
                <div class="ds-tu-metric"><div class="ds-tu-metric-label">输出 Tokens</div><div class="ds-tu-metric-value" data-calendar-metric="output">0</div></div>
                <div class="ds-tu-metric"><div class="ds-tu-metric-label">API 请求</div><div class="ds-tu-metric-value" data-calendar-metric="requests">0</div></div>
              </div>
              <div class="ds-tu-day-detail">
                <div class="ds-tu-day-detail-item"><div class="ds-tu-day-detail-label">日期</div><div class="ds-tu-day-detail-value ds-tu-day-date">—</div></div>
                <div class="ds-tu-day-detail-item"><div class="ds-tu-day-detail-label">总 Tokens</div><div class="ds-tu-day-detail-value ds-tu-day-total">0</div></div>
                <div class="ds-tu-day-detail-item"><div class="ds-tu-day-detail-label">输入</div><div class="ds-tu-day-detail-value ds-tu-day-input">0</div></div>
                <div class="ds-tu-day-detail-item"><div class="ds-tu-day-detail-label">输出</div><div class="ds-tu-day-detail-value ds-tu-day-output">0</div></div>
                <div class="ds-tu-day-detail-item"><div class="ds-tu-day-detail-label">请求</div><div class="ds-tu-day-detail-value ds-tu-day-requests-value">0</div></div>
                <div class="ds-tu-day-detail-item"><div class="ds-tu-day-detail-label">命中率</div><div class="ds-tu-day-detail-value ds-tu-day-hit-rate">0.0%</div></div>
              </div>
              <div class="ds-tu-weekdays" aria-hidden="true">
                <div class="ds-tu-weekday">一</div><div class="ds-tu-weekday">二</div><div class="ds-tu-weekday">三</div>
                <div class="ds-tu-weekday">四</div><div class="ds-tu-weekday">五</div><div class="ds-tu-weekday">六</div><div class="ds-tu-weekday">日</div>
              </div>
              <div class="ds-tu-calendar-grid" aria-label="每日 Token 用量"></div>
            </section>
          </div>
        </div>
      </dialog>
    `;
    document.body.append(root);

    const elements = {
      root,
      launcher: root.querySelector(".ds-tu-launcher"),
      dialog: root.querySelector("dialog"),
      close: root.querySelector(".ds-tu-close"),
      tabs: [...root.querySelectorAll(".ds-tu-tab")],
      overviewView: root.querySelector(".ds-tu-overview-view"),
      calendarView: root.querySelector(".ds-tu-calendar-view"),
      form: root.querySelector(".ds-tu-controls"),
      start: root.querySelector('input[name="start"]'),
      end: root.querySelector('input[name="end"]'),
      run: root.querySelector(".ds-tu-run"),
      cancel: root.querySelector(".ds-tu-cancel"),
      status: root.querySelector(".ds-tu-status"),
      progress: root.querySelector(".ds-tu-summary-progress"),
      results: root.querySelector(".ds-tu-results"),
      range: root.querySelector(".ds-tu-range"),
      tableBody: root.querySelector("tbody"),
      month: root.querySelector(".ds-tu-month"),
      previousMonth: root.querySelector(".ds-tu-previous-month"),
      nextMonth: root.querySelector(".ds-tu-next-month"),
      calendarStatus: root.querySelector(".ds-tu-calendar-status"),
      calendarProgress: root.querySelector(".ds-tu-calendar-progress"),
      calendarGrid: root.querySelector(".ds-tu-calendar-grid"),
      dayDate: root.querySelector(".ds-tu-day-date"),
      dayTotal: root.querySelector(".ds-tu-day-total"),
      dayInput: root.querySelector(".ds-tu-day-input"),
      dayOutput: root.querySelector(".ds-tu-day-output"),
      dayRequests: root.querySelector(".ds-tu-day-requests-value"),
      dayHitRate: root.querySelector(".ds-tu-day-hit-rate"),
    };

    elements.launcher.addEventListener("click", () => {
      if (typeof elements.dialog.showModal === "function") {
        if (!elements.dialog.open) elements.dialog.showModal();
      } else {
        elements.dialog.setAttribute("open", "");
      }
    });

    elements.close.addEventListener("click", () => {
      if (typeof elements.dialog.close === "function") elements.dialog.close();
      else elements.dialog.removeAttribute("open");
    });

    elements.dialog.addEventListener("click", (event) => {
      if (event.target === elements.dialog && !state.running) elements.dialog.close();
    });

    elements.form.addEventListener("submit", (event) => {
      event.preventDefault();
      runStatistics(elements);
    });

    elements.cancel.addEventListener("click", () => state.controller?.abort());
    elements.tabs.forEach((tab) => {
      tab.addEventListener("click", () => setActiveView(elements, tab.dataset.view));
    });
    elements.previousMonth.addEventListener("click", () => changeCalendarMonth(elements, -1));
    elements.nextMonth.addEventListener("click", () => changeCalendarMonth(elements, 1));
    elements.month.addEventListener("change", () => loadCalendar(elements));
    elements.calendarGrid.addEventListener("click", (event) => {
      const day = event.target.closest(".ds-tu-day[data-date]");
      if (day) renderDayDetail(elements, day.dataset.date);
    });
    syncCalendarNavigation(elements);
    return elements;
  }

  function mount() {
    if (!document.body || document.getElementById(ROOT_ID)) return;
    createStyles();
    createRoot();
  }

  mount();
  const observer = new MutationObserver(mount);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
