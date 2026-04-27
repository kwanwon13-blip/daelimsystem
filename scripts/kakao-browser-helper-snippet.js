(() => {
  const MARK_ATTR = 'data-kakao-download-helper';
  const BUTTON_SELECTOR = [
    'button',
    'a[href]',
    '[role="button"]',
    '[aria-label]',
    '[title]',
    'input[type="button"]',
    'input[type="submit"]',
  ].join(',');

  const state = {
    candidates: [],
    markerStyleId: 'kakao-download-helper-style',
  };

  function installStyle() {
    if (document.getElementById(state.markerStyleId)) return;
    const style = document.createElement('style');
    style.id = state.markerStyleId;
    style.textContent = `
      [${MARK_ATTR}] {
        outline: 3px solid #ff8a00 !important;
        outline-offset: 2px !important;
        position: relative !important;
      }
      .kakao-download-helper-badge {
        position: fixed;
        z-index: 2147483647;
        background: #ff8a00;
        color: #111;
        font: 700 12px/1.2 system-ui, sans-serif;
        padding: 3px 5px;
        border-radius: 4px;
        pointer-events: none;
        box-shadow: 0 2px 8px rgba(0, 0, 0, .25);
      }
    `;
    document.head.appendChild(style);
  }

  function cleanupMarks() {
    document.querySelectorAll(`[${MARK_ATTR}]`).forEach((el) => {
      el.removeAttribute(MARK_ATTR);
    });
    document.querySelectorAll('.kakao-download-helper-badge').forEach((el) => el.remove());
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 3 &&
      rect.height > 3 &&
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= window.innerHeight &&
      rect.left <= window.innerWidth &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0'
    );
  }

  function textOf(el) {
    return [
      el.innerText,
      el.textContent,
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('alt'),
      el.value,
      el.href,
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cssPath(el) {
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      let part = current.nodeName.toLowerCase();
      if (current.id) {
        part += `#${CSS.escape(current.id)}`;
        parts.unshift(part);
        break;
      }
      const className = String(current.className || '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((name) => `.${CSS.escape(name)}`)
        .join('');
      if (className) part += className;
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.nodeName === current.nodeName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function collect(patternText = '다운로드|저장|받기|download|save') {
    installStyle();
    cleanupMarks();

    const pattern = new RegExp(patternText, 'i');
    const elements = [...document.querySelectorAll(BUTTON_SELECTOR)].filter(isVisible);
    const scored = elements
      .map((el) => {
        const text = textOf(el);
        const rect = el.getBoundingClientRect();
        const matches = pattern.test(text);
        return {
          el,
          text,
          matches,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          selector: cssPath(el),
        };
      })
      .filter((item) => item.matches || /svg|icon|button/i.test(item.selector));

    state.candidates = scored;
    scored.forEach((item, index) => {
      item.el.setAttribute(MARK_ATTR, String(index));
      const badge = document.createElement('div');
      badge.className = 'kakao-download-helper-badge';
      badge.textContent = `KD${index}`;
      badge.style.left = `${Math.max(4, item.x - 14)}px`;
      badge.style.top = `${Math.max(4, item.y - 14)}px`;
      document.body.appendChild(badge);
    });

    console.table(
      scored.map((item, index) => ({
        index,
        matches: item.matches,
        x: item.x,
        y: item.y,
        text: item.text.slice(0, 100),
        selector: item.selector,
      }))
    );
    console.log('Use kakaoDownloadHelper.click(index) after checking the KD label.');
    return scored;
  }

  function click(index) {
    const item = state.candidates[index];
    if (!item) throw new Error(`No candidate at index ${index}. Run kakaoDownloadHelper.scan() first.`);
    item.el.scrollIntoView({ block: 'center', inline: 'center' });
    item.el.click();
    console.log(`Clicked KD${index}:`, item.text || item.selector);
  }

  async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function autoClick(options = {}) {
    const {
      pattern = '다운로드|저장|받기|download|save',
      delayMs = 2000,
      limit = 20,
      scrollAfterClick = false,
    } = options;

    if (
      !window.confirm(
        `Click up to ${limit} visible download/save candidates?\n\nThis only clicks controls in this logged-in browser tab. Keep your asset watcher running and stop if the page behaves unexpectedly.`
      )
    ) {
      return;
    }

    let clicked = 0;
    while (clicked < limit) {
      collect(pattern);
      const item = state.candidates.find((candidate) => candidate.matches);
      if (!item) {
        if (!scrollAfterClick) break;
        window.scrollBy({ top: Math.round(window.innerHeight * 0.8), behavior: 'smooth' });
        await sleep(delayMs);
        continue;
      }
      item.el.scrollIntoView({ block: 'center', inline: 'center' });
      await sleep(250);
      item.el.click();
      clicked += 1;
      console.log(`Clicked ${clicked}/${limit}:`, item.text || item.selector);
      await sleep(delayMs);
      if (scrollAfterClick) {
        window.scrollBy({ top: Math.round(window.innerHeight * 0.8), behavior: 'smooth' });
        await sleep(500);
      }
    }
    console.log(`Done. clicked=${clicked}`);
  }

  async function scrollScan(options = {}) {
    const { steps = 10, delayMs = 700, pattern = '다운로드|저장|받기|download|save' } = options;
    const all = [];
    for (let i = 0; i < steps; i += 1) {
      const found = collect(pattern).map((item) => ({
        text: item.text,
        x: item.x,
        y: item.y,
        selector: item.selector,
      }));
      all.push(...found);
      window.scrollBy({ top: Math.round(window.innerHeight * 0.8), behavior: 'smooth' });
      await sleep(delayMs);
    }
    console.table(all);
    return all;
  }

  window.kakaoDownloadHelper = {
    scan: collect,
    list: () => state.candidates,
    click,
    autoClick,
    scrollScan,
    clear: cleanupMarks,
  };

  collect();
})();
