/**
 * Lightweight, zero-dependency floating tooltip with smart viewport positioning.
 * Reads data-tip-title, data-tip-badge, data-tip-body, data-tip-meta from hovered elements.
 */
export function initTooltips() {
  const tip = document.createElement("div");
  tip.id = "floating-tooltip";
  tip.className = "floating-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.appendChild(tip);

  let activeTarget = null;

  function renderContent(target) {
    const title = target.dataset.tipTitle || "";
    const badge = target.dataset.tipBadge || "";
    const body = target.dataset.tipBody || "";
    const meta = target.dataset.tipMeta || "";

    if (!title && !body) return false;

    tip.innerHTML = "";
    if (title || badge) {
      const head = document.createElement("div");
      head.className = "ftip-head";
      if (title) {
        const t = document.createElement("strong");
        t.className = "ftip-title";
        t.textContent = title;
        head.appendChild(t);
      }
      if (badge) {
        const b = document.createElement("span");
        b.className = "ftip-badge";
        b.textContent = badge;
        head.appendChild(b);
      }
      tip.appendChild(head);
    }

    if (body) {
      const p = document.createElement("div");
      p.className = "ftip-body";
      p.textContent = body;
      tip.appendChild(p);
    }

    if (meta) {
      const m = document.createElement("div");
      m.className = "ftip-meta";
      m.textContent = meta;
      tip.appendChild(m);
    }
    return true;
  }

  function positionTip(target) {
    const rect = target.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const gap = 8;
    const pad = 12;

    let top = rect.top - tipRect.height - gap;
    if (top < pad) {
      top = rect.bottom + gap;
    }

    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    left = Math.max(pad, Math.min(window.innerWidth - tipRect.width - pad, left));

    tip.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  function showFor(target) {
    if (!renderContent(target)) {
      hideTip();
      return;
    }
    activeTarget = target;
    tip.hidden = false;
    positionTip(target);
  }

  function hideTip() {
    activeTarget = null;
    tip.hidden = true;
  }

  document.addEventListener("pointerover", (ev) => {
    const el = ev.target.closest("[data-tip-body], [data-tip-title]");
    if (!el) {
      if (activeTarget) hideTip();
      return;
    }
    if (el !== activeTarget) {
      showFor(el);
    } else {
      // Refresh live dynamic attributes if updated while hovering
      renderContent(el);
      positionTip(el);
    }
  });

  document.addEventListener("pointerdown", hideTip);
  window.addEventListener("scroll", hideTip, { passive: true });
  window.addEventListener("resize", hideTip, { passive: true });

  return {
    refreshActive() {
      if (activeTarget && document.body.contains(activeTarget)) {
        renderContent(activeTarget);
        positionTip(activeTarget);
      } else if (activeTarget) {
        hideTip();
      }
    },
  };
}
