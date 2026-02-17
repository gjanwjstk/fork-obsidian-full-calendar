/**
 * <input type="color">는 #rrggbb 형식만 허용.
 * Obsidian 테마 변수(--interactive-accent)가 hsl(calc(...)) 형태로 정의된 경우
 * getPropertyValue는 계산되지 않은 원본 문자열을 반환하여 오류 발생.
 * DOM에 숨겨진 요소를 두고 getComputedStyle로 실제 계산된 색상을 추출.
 */

/** var(--interactive-accent) 등을 실제 계산된 hex로 변환 */
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
            const r = parseInt(m[1], 10).toString(16).padStart(2, "0");
            const g = parseInt(m[2], 10).toString(16).padStart(2, "0");
            const b = parseInt(m[3], 10).toString(16).padStart(2, "0");
            return `#${r}${g}${b}`;
        }
    } catch {
        /* ignore */
    }
    return "#808080";
}

import Color from "color";

/**
 * 임의의 색상 문자열을 <input type="color">에 사용 가능한 #rrggbb로 변환.
 * hsl(calc(...)), rgb(), CSS 변수 등 모두 처리.
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
                const r = parseInt(m[1], 10).toString(16).padStart(2, "0");
                const g = parseInt(m[2], 10).toString(16).padStart(2, "0");
                const b = parseInt(m[3], 10).toString(16).padStart(2, "0");
                return `#${r}${g}${b}`;
            }
        } catch {
            /* ignore */
        }
        // hsl(calc(...)) 등 Color/div 모두 실패 시 accent 색상 사용
        if (
            /calc\(|hsl\s*\(|var\s*\(/i.test(value) ||
            value.includes("--interactive-accent")
        ) {
            return getAccentColorHex();
        }
        return "#808080";
    }
}
