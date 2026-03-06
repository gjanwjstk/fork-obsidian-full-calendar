/**
 * Color utilities for the plugin.
 * <input type="color"> requires #rrggbb format.
 * Obsidian theme variables (--interactive-accent) may be hsl(calc(...));
 * getPropertyValue returns the raw string, so we use getComputedStyle on a DOM element.
 */

import Color from "color";

/** Parse hex color to [r, g, b]. Supports #rrggbb and #rgb. */
export function hexToRgb(hex: string): [number, number, number] | null {
    const normalized = hex.replace(/^#/, "");
    const m =
        normalized.match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i) ||
        normalized.match(/^([0-9a-f])([0-9a-f])([0-9a-f])$/i);
    if (!m) return null;
    const expand = (s: string) =>
        s.length === 1 ? parseInt(s + s, 16) : parseInt(s, 16);
    return [expand(m[1]), expand(m[2]), expand(m[3])];
}

/** Convert r,g,b (0-255) to #rrggbb hex string. */
export function rgbToHex(r: number, g: number, b: number): string {
    return (
        "#" +
        [r, g, b]
            .map((n) => Math.round(Math.max(0, Math.min(255, n))))
            .map((n) => n.toString(16).padStart(2, "0"))
            .join("")
    );
}

/** Get computed accent color as hex (e.g. from var(--interactive-accent)). */
export function getAccentColorHex(): string {
    if (typeof document === "undefined") return "#808080";
    try {
        const div = document.createElement("div");
        div.style.cssText =
            "position:absolute;visibility:hidden;pointer-events:none;color:var(--interactive-accent)";
        document.body.appendChild(div);
        const rgb = getComputedStyle(div).color;
        document.body.removeChild(div);
        const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (m) {
            return rgbToHex(
                parseInt(m[1], 10),
                parseInt(m[2], 10),
                parseInt(m[3], 10)
            );
        }
    } catch {
        /* ignore */
    }
    return "#808080";
}

/**
 * Convert any color string to #rrggbb for <input type="color">.
 * Handles hsl(calc(...)), rgb(), CSS variables, etc.
 */
export function toHexForColorInput(value: string | null | undefined): string {
    if (!value || typeof value !== "string") return "#808080";
    if (/^#[0-9A-Fa-f]{6}$/.test(value)) return value;
    try {
        return Color(value).hex();
    } catch {
        try {
            const div = document.createElement("div");
            div.style.color = value;
            document.body.appendChild(div);
            const rgb = getComputedStyle(div).color;
            document.body.removeChild(div);
            const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
            if (m) {
                return rgbToHex(
                    parseInt(m[1], 10),
                    parseInt(m[2], 10),
                    parseInt(m[3], 10)
                );
            }
        } catch {
            /* ignore */
        }
        if (
            /calc\(|hsl\s*\(|var\s*\(/i.test(value) ||
            value.includes("--interactive-accent")
        ) {
            return getAccentColorHex();
        }
        return "#808080";
    }
}
