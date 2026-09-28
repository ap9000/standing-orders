/**
 * The accent a person can choose (Settings → Appearance): the signal colour
 * that marks what waits on a person, re-pigmented from Pantone's Colours of
 * the Year. Chart magenta stays the default. A per-browser preference, like
 * the theme: it lives in the person's `so-accent` cookie and never in the
 * database.
 *
 * Each colour keeps its hue and gives up only lightness (and, when needed,
 * chroma to stay in sRGB) until it reads: in light, its text passes 4.5:1 on
 * its own soft wash; in dark, 6:1 on the dark paper. The swatch shows the
 * published colour; the page uses the readable one. Greys and whites (Sand
 * Dollar, Ultimate Gray, Cloud Dancer) are left out: a grey cannot mark what
 * needs a person against a grey interface.
 *
 * Colour names are Pantone LLC's; the hex values are the published screen
 * approximations. Pantone is not affiliated with Standing Orders.
 */

export type AccentChoice = { id: string; name: string; year: number | null; hex: string; note: string | null };
type Tokens = { signal: string; hover: string; on: string; soft: string; selection: string };

const PAPER_LIGHT = "#ffffff", FRAME_LIGHT = "#efefef", PAPER_DARK = "#161616", INK_DARK = "#0a0a0a";

/** Newest first, as Pantone announced them. */
const COLOURS_OF_THE_YEAR: [number, string, string][] = [
  [2025, "Mocha Mousse", "#a47864"], [2024, "Peach Fuzz", "#ffbe98"], [2023, "Viva Magenta", "#bb2649"],
  [2022, "Very Peri", "#6667ab"], [2021, "Illuminating", "#f5df4d"], [2020, "Classic Blue", "#0f4c81"],
  [2019, "Living Coral", "#ff6f61"], [2018, "Ultra Violet", "#5f4b8b"], [2017, "Greenery", "#88b04b"],
  [2016, "Rose Quartz", "#f7caca"], [2016, "Serenity", "#93a9d1"], [2015, "Marsala", "#964f4c"],
  [2014, "Radiant Orchid", "#ad5e99"], [2013, "Emerald", "#009473"], [2012, "Tangerine Tango", "#dd4124"],
  [2011, "Honeysuckle", "#d94f70"], [2010, "Turquoise", "#45b5aa"], [2009, "Mimosa", "#f0c05a"],
  [2008, "Blue Iris", "#5a5b9f"], [2007, "Chili Pepper", "#9b1b30"], [2005, "Blue Turquoise", "#53b0ae"],
  [2004, "Tigerlily", "#e2583e"], [2003, "Aqua Sky", "#7bc4c4"], [2002, "True Red", "#bf1932"],
  [2001, "Fuchsia Rose", "#c74375"], [2000, "Cerulean", "#9bb7d4"],
];
/** Left out on purpose; named so the page can say so. */
export const LEFT_OUT = "Sand Dollar (2006), Ultimate Gray (2021) and Cloud Dancer (2026)";

// --- colour arithmetic (sRGB ⇄ OKLab), enough to move lightness honestly ---
type Rgb = [number, number, number];
const toRgb = (hex: string): Rgb => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
const toHex = (rgb: Rgb) => `#${rgb.map(c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0")).join("")}`;
const lin = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const gam = (c: number) => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
function toOklch(hex: string): [number, number, number] {
  const [r, g, b] = toRgb(hex).map(lin) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180 / Math.PI + 360) % 360];
}
function fromOklch(L: number, C: number, H: number): Rgb | null {
  const A = C * Math.cos(H * Math.PI / 180), B = C * Math.sin(H * Math.PI / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  return rgb.every(c => c >= -0.0001 && c <= 1.0001) ? rgb.map(gam) as Rgb : null;
}
/** The colour at lightness L with its hue kept, giving up chroma only to stay in sRGB. */
function atLightness(L: number, C: number, H: number): string {
  for (let c = C; c >= 0; c -= 0.002) { const rgb = fromOklch(L, c, H); if (rgb !== null) return toHex(rgb); }
  return toHex(fromOklch(L, 0, H)!);
}
const luminance = (hex: string) => { const [r, g, b] = toRgb(hex).map(lin) as Rgb; return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
const mix = (a: string, b: string, weight: number) => { const [p, q] = [toRgb(a), toRgb(b)]; return toHex(p.map((c, i) => c * weight + q[i]! * (1 - weight)) as Rgb); };

function lightTokens(hex: string): Tokens {
  const [L0, C, H] = toOklch(hex);
  let signal = hex;
  const reads = (one: string) => contrast(one, mix(one, PAPER_LIGHT, 0.12)) >= 4.5 && contrast(one, FRAME_LIGHT) >= 3;
  for (let L = L0; !reads(signal) && L > 0.05; L -= 0.005) signal = atLightness(L, C, H);
  const [L1] = toOklch(signal);
  return {
    signal, hover: atLightness(Math.max(0.05, L1 - 0.06), C, H),
    on: contrast(signal, "#ffffff") >= 4.5 ? "#ffffff" : INK_DARK,
    soft: mix(signal, PAPER_LIGHT, 0.12), selection: mix(signal, PAPER_LIGHT, 0.24),
  };
}
function darkTokens(hex: string): Tokens {
  const [L0, C, H] = toOklch(hex);
  let signal = hex;
  const reads = (one: string) => contrast(one, PAPER_DARK) >= 6 && contrast(one, mix(one, PAPER_DARK, 0.13)) >= 4.5;
  for (let L = L0; !reads(signal) && L < 0.98; L += 0.005) signal = atLightness(L, C, H);
  const [L1] = toOklch(signal);
  return {
    signal, hover: atLightness(Math.min(0.98, L1 + 0.06), C, H),
    on: contrast(signal, INK_DARK) >= 4.5 ? INK_DARK : "#ffffff",
    soft: mix(signal, PAPER_DARK, 0.13), selection: mix(signal, PAPER_DARK, 0.32),
  };
}

/** A status hue the accent sits near: the page names it so a person can decide. */
const STATUS: [string, string, string, string][] = [
  ["#c4320a", "red", "failures", "a failed one"], ["#ab6400", "amber", "warnings", "a warning"],
  ["#218358", "green", "passed checks", "a passed one"], ["#0d74ce", "blue", "running work", "a running one"],
];
function nearStatus(signal: string): string | null {
  const [, , hue] = toOklch(signal);
  const near = STATUS.find(([hex]) => { const d = Math.abs(toOklch(hex)[2] - hue); return Math.min(d, 360 - d) < 25; });
  return near === undefined ? null : `Close to the ${near[1]} used for ${near[2]}, so a task waiting on you can look like ${near[3]}.`;
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const CHOICES = COLOURS_OF_THE_YEAR.map(([year, name, hex]) => ({ id: slug(name), name, year, hex, light: lightTokens(hex), dark: darkTokens(hex) }));

/** Chart magenta first (the default, no cookie), then the colours of the year. */
export const ACCENTS: AccentChoice[] = [
  { id: "signal", name: "Chart magenta", year: null, hex: "#c0267e", note: null },
  ...CHOICES.map(one => ({ id: one.id, name: one.name, year: one.year, hex: one.hex, note: nearStatus(one.light.signal) })),
];
const IDS = new Set(ACCENTS.map(one => one.id));

/** The person's chosen accent from their own cookie; null is chart magenta. */
export function pinnedAccent(cookieHeader: string | undefined): string | null {
  const value = /(?:^|;\s*)so-accent=([a-z0-9-]{1,40})(?:;|$)/.exec(cookieHeader ?? "")?.[1];
  return value !== undefined && value !== "signal" && IDS.has(value) ? value : null;
}
export const isAccent = (id: string) => IDS.has(id);

/** The token overrides per accent, light and dark, for the shared stylesheet. */
export function accentCss(): string {
  const block = (t: Tokens) => `--so-signal: ${t.signal}; --so-signal-hover: ${t.hover}; --so-on-signal: ${t.on}; --so-signal-soft: ${t.soft}; --so-selection: ${t.selection};`;
  return CHOICES.map(one => `  :root[data-accent="${one.id}"] { ${block(one.light)} }\n` +
    `  @media (prefers-color-scheme: dark) { :root[data-accent="${one.id}"]:not([data-theme="light"]) { ${block(one.dark)} } }\n` +
    `  :root[data-theme="dark"][data-accent="${one.id}"] { ${block(one.dark)} }`).join("\n");
}

/** For tests: the readable tokens each accent resolves to. */
export const accentTokens = (id: string) => { const one = CHOICES.find(choice => choice.id === id); return one === undefined ? null : { light: one.light, dark: one.dark }; };
