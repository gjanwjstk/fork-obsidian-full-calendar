/**
 * Hex color to Google Calendar colorId matching.
 * Fetches the Colors API palette and finds the closest colorId for a given hex.
 */
import { requestUrl } from "obsidian";
import { hexToRgb } from "./colorUtils";

const COLORS_API_URL = "https://www.googleapis.com/calendar/v3/colors";

interface ColorDefinition {
    background?: string;
    foreground?: string;
}

interface ColorsResponse {
    calendar?: Record<string, ColorDefinition>;
    event?: Record<string, ColorDefinition>;
}

let cachedCalendarPalette: Record<string, string> | null = null;
let cachedEventPalette: Record<string, string> | null = null;

function rgbDistance(
    a: [number, number, number],
    b: [number, number, number]
): number {
    return Math.sqrt(
        Math.pow(a[0] - b[0], 2) +
            Math.pow(a[1] - b[1], 2) +
            Math.pow(a[2] - b[2], 2)
    );
}

function normalizeHex(hex: string): string {
    if (hex.startsWith("#")) return hex;
    return "#" + hex;
}

function buildPaletteMap(
    section: Record<string, ColorDefinition> | undefined
): Record<string, string> {
    const map: Record<string, string> = {};
    if (!section) return map;
    for (const [id, def] of Object.entries(section)) {
        const bg = def?.background;
        if (bg) {
            map[id] = normalizeHex(bg);
        }
    }
    return map;
}

/**
 * Fetch and cache the Google Calendar colors palette.
 */
export async function fetchColorsPalette(accessToken: string): Promise<{
    calendar: Record<string, string>;
    event: Record<string, string>;
}> {
    if (cachedCalendarPalette && cachedEventPalette) {
        return {
            calendar: cachedCalendarPalette,
            event: cachedEventPalette,
        };
    }

    const response = await requestUrl({
        url: COLORS_API_URL,
        method: "GET",
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    const data: ColorsResponse = response.json;
    cachedCalendarPalette = buildPaletteMap(data.calendar);
    cachedEventPalette = buildPaletteMap(data.event);

    return {
        calendar: cachedCalendarPalette,
        event: cachedEventPalette,
    };
}

/**
 * Find the closest colorId for a given hex from a palette.
 */
function findClosestColorId(
    hex: string,
    palette: Record<string, string>
): string | null {
    const targetRgb = hexToRgb(normalizeHex(hex));
    if (!targetRgb) return null;

    const entries = Object.entries(palette);
    if (entries.length === 0) return null;

    let bestId: string | null = null;
    let bestDist = Infinity;

    for (const [id, paletteHex] of entries) {
        const paletteRgb = hexToRgb(paletteHex);
        if (!paletteRgb) continue;
        const dist = rgbDistance(targetRgb, paletteRgb);
        if (dist < bestDist) {
            bestDist = dist;
            bestId = id;
        }
    }
    return bestId;
}

/**
 * Get the colorId for calendar list (CalendarList: update).
 */
export async function hexToCalendarColorId(
    hex: string,
    accessToken: string
): Promise<string | null> {
    const { calendar } = await fetchColorsPalette(accessToken);
    return findClosestColorId(hex, calendar);
}

/**
 * Get the colorId for events (Events: update).
 */
export async function hexToEventColorId(
    hex: string,
    accessToken: string
): Promise<string | null> {
    const { event } = await fetchColorsPalette(accessToken);
    return findClosestColorId(hex, event);
}
