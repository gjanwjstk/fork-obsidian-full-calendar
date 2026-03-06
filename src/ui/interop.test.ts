import { OFCEvent } from "../types";
import {
    dateEndpointsToFrontmatter,
    fromEventApi,
    toEventInput,
} from "./interop";

describe("interop", () => {
    describe("dateEndpointsToFrontmatter", () => {
        it("converts all-day date range to frontmatter", () => {
            const start = new Date("2024-01-15");
            const end = new Date("2024-01-15");
            const result = dateEndpointsToFrontmatter(start, end, true);
            expect(result).toEqual({
                type: "single",
                date: "2024-01-15",
                endDate: undefined,
                allDay: true,
            });
        });

        it("includes endDate when start and end differ", () => {
            const start = new Date("2024-01-15");
            const end = new Date("2024-01-17");
            const result = dateEndpointsToFrontmatter(start, end, true);
            expect(result).toEqual({
                type: "single",
                date: "2024-01-15",
                endDate: "2024-01-17",
                allDay: true,
            });
        });

        it("includes startTime and endTime for timed events", () => {
            const start = new Date("2024-01-15T10:00:00.000Z");
            const end = new Date("2024-01-15T11:30:00.000Z");
            const result = dateEndpointsToFrontmatter(start, end, false);
            expect(result).toMatchObject({
                type: "single",
                allDay: false,
            });
            expect("startTime" in result && result.startTime).toBeDefined();
            expect("endTime" in result && result.endTime).toBeDefined();
        });
    });

    describe("toEventInput", () => {
        it("converts single all-day event", () => {
            const frontmatter: OFCEvent = {
                title: "Meeting",
                type: "single",
                date: "2024-01-15",
                allDay: true,
            } as OFCEvent;
            const result = toEventInput("ev-1", frontmatter);
            expect(result).not.toBeNull();
            expect(result?.id).toBe("ev-1");
            expect(result?.title).toBe("Meeting");
            expect(result?.allDay).toBe(true);
            expect(result?.start).toBe("2024-01-15");
        });

        it("converts single timed event", () => {
            const frontmatter: OFCEvent = {
                title: "Call",
                type: "single",
                date: "2024-01-15",
                allDay: false,
                startTime: "10:00",
                endTime: "11:00",
            } as OFCEvent;
            const result = toEventInput("ev-2", frontmatter);
            expect(result).not.toBeNull();
            expect(result?.allDay).toBe(false);
            expect(result?.start).toBeDefined();
            expect(result?.end).toBeDefined();
        });

        it("includes event color when present", () => {
            const frontmatter: OFCEvent = {
                title: "Colored",
                type: "single",
                date: "2024-01-15",
                allDay: true,
                color: "#ff0000",
            } as OFCEvent;
            const result = toEventInput("ev-3", frontmatter);
            expect(result?.backgroundColor).toBe("#ff0000");
            expect(result?.borderColor).toBe("#ff0000");
        });
    });

    describe("fromEventApi", () => {
        it("converts all-day event to OFCEvent", () => {
            const eventApi = {
                title: "Meeting",
                start: new Date("2024-01-15"),
                end: new Date("2024-01-15"),
                allDay: true,
                extendedProps: {},
            } as Parameters<typeof fromEventApi>[0];
            const result = fromEventApi(eventApi);
            expect(result).toEqual({
                title: "Meeting",
                allDay: true,
                type: "single",
                date: "2024-01-15",
                endDate: null,
            });
        });

        it("converts timed event to OFCEvent", () => {
            const eventApi = {
                title: "Call",
                start: new Date("2024-01-15T10:00:00.000Z"),
                end: new Date("2024-01-15T11:00:00.000Z"),
                allDay: false,
                extendedProps: {},
            } as Parameters<typeof fromEventApi>[0];
            const result = fromEventApi(eventApi);
            expect(result.title).toBe("Call");
            expect(result.allDay).toBe(false);
            expect(result.type).toBe("single");
            expect("date" in result && result.date).toBe("2024-01-15");
            expect("startTime" in result && result.startTime).toBeDefined();
            expect("endTime" in result && result.endTime).toBeDefined();
        });

        it("preserves event color from backgroundColor", () => {
            const eventApi = {
                title: "Colored",
                start: new Date("2024-01-15"),
                end: new Date("2024-01-15"),
                allDay: true,
                extendedProps: {},
                backgroundColor: "#00ff00",
            } as Parameters<typeof fromEventApi>[0];
            const result = fromEventApi(eventApi);
            expect(result.color).toBe("#00ff00");
        });
    });
});
