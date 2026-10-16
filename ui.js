// Small helpers for building the inspector's controls, shared by the app and the engines' own panels.

export const hex = (v, n = 2) => "$" + v.toString(16).toUpperCase().padStart(n, "0");

export function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "on") for (const [ev, f] of Object.entries(v)) e.addEventListener(ev, f);
    else if (k in e) e[k] = v; else e.setAttribute(k, v);
  }
  e.append(...kids.filter(k => k !== null && k !== undefined && k !== false));
  return e;
}
export const field = (label, input) => el("label", { className: "f" }, label, input);
export const check = (label, checked, onchange) => el("label", { className: "check" }, el("input", { type: "checkbox", checked, on: { change: e => onchange(e.target.checked) } }), label);
export const select = (opts, value, onchange) => {
  const s = el("select", { on: { change: e => onchange(e.target.value) } }, ...opts.map(([v, t]) => el("option", { value: v, textContent: t })));
  s.value = String(value);
  return s;
};
export const range = (min, max, value, oninput, onchange) => el("input", { type: "range", min, max, value, on: { input: e => oninput(+e.target.value), change: e => onchange(+e.target.value) } });
export const num = (min, max, value, onchange) => el("input", { type: "number", min, max, value, on: { change: e => { const v = Math.round(+e.target.value); if (Number.isFinite(v)) onchange(Math.max(min, Math.min(max, v))); } } });
export const sep = () => el("div", { className: "sep" });
export const hint = text => el("p", { className: "hint note", textContent: text });

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const midiName = k => NAMES[((k % 12) + 12) % 12] + (Math.floor(k / 12) - 1);

// Controls for an engine command the engine describes as { name, args: [{ name, min, max, signed?, hint? }], hint }.
export function commandControls(info, ev, set) {
  const kids = [];
  (info.args || []).forEach((a, i) => {
    const raw = ev.args[i] ?? 0;
    const shown = a.signed && raw > a.max ? raw - (a.bits === 16 ? 65536 : 256) : raw;
    kids.push(field(a.name, num(a.signed ? -(a.max + 1) : a.min ?? 0, a.max ?? 255, shown, v => {
      const args = ev.args.slice();
      args[i] = a.signed && v < 0 ? v + (a.bits === 16 ? 65536 : 256) : v;
      set(args);
    })));
    if (a.hint) kids.push(hint(a.hint));
  });
  if (info.hint) kids.push(hint(info.hint));
  return kids;
}
