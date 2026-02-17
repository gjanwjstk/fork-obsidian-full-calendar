import { requestUrl } from "obsidian";
import { CalendarInfo, OFCEvent } from "src/types";
import { EventResponse } from "./Calendar";
import RemoteCalendar from "./RemoteCalendar";
import { GoogleAuthService } from "../auth/GoogleAuth";

const GOOGLE_CALENDAR_API_BASE =
    "https://www.googleapis.com/calendar/v3/calendars";

interface GoogleEvent {
    id: string;
    summary?: string;
    description?: string;
    start?: {
        dateTime?: string;
        date?: string;
        timeZone?: string;
    };
    end?: {
        dateTime?: string;
        date?: string;
        timeZone?: string;
    };
    recurrence?: string[];
    status?: string;
    extendedProperties?: {
        private?: Record<string, string>;
    };
}

interface GoogleEventsListResponse {
    items?: GoogleEvent[];
    nextPageToken?: string;
    error?: { message: string };
}

/**
 * Google Calendar integration via Google Calendar API v3.
 * Extends RemoteCalendar for read support and provides
 * additional methods for create/modify/delete operations.
 */
export default class GoogleCalendar extends RemoteCalendar {
    private calendarId: string;
    private calendarName: string;
    private authService: GoogleAuthService;
    private events: GoogleEvent[] = [];

    /** Set to true to indicate this calendar supports write operations */
    readonly writable = true;

    constructor(
        color: string,
        name: string,
        calendarId: string,
        authService: GoogleAuthService
    ) {
        super(color);
        this.calendarName = name;
        this.calendarId = calendarId;
        this.authService = authService;
    }

    get type(): CalendarInfo["type"] {
        return "gcal";
    }

    get identifier(): string {
        return this.calendarId;
    }

    get name(): string {
        return this.calendarName;
    }

    /**
     * Fetch events from Google Calendar API.
     */
    async revalidate(): Promise<void> {
        const token = await this.authService.getValidAccessToken();
        const allEvents: GoogleEvent[] = [];
        let pageToken: string | undefined;

        // Fetch events for +-6 months from now
        const now = new Date();
        const timeMin = new Date(
            now.getFullYear(),
            now.getMonth() - 6,
            1
        ).toISOString();
        const timeMax = new Date(
            now.getFullYear(),
            now.getMonth() + 6,
            1
        ).toISOString();

        do {
            const url = new URL(
                `${GOOGLE_CALENDAR_API_BASE}/${encodeURIComponent(
                    this.calendarId
                )}/events`
            );
            url.searchParams.set("maxResults", "2500");
            url.searchParams.set("singleEvents", "false");
            url.searchParams.set("timeMin", timeMin);
            url.searchParams.set("timeMax", timeMax);
            if (pageToken) {
                url.searchParams.set("pageToken", pageToken);
            }

            const response = await requestUrl({
                url: url.toString(),
                method: "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });

            const data: GoogleEventsListResponse = response.json;
            if (data.error) {
                throw new Error(
                    `Google Calendar API error: ${data.error.message}`
                );
            }

            if (data.items) {
                allEvents.push(
                    ...data.items.filter((e) => e.status !== "cancelled")
                );
            }
            pageToken = data.nextPageToken;
        } while (pageToken);

        this.events = allEvents;
    }

    /**
     * Convert Google Calendar events to OFCEvent format.
     */
    async getEvents(): Promise<EventResponse[]> {
        return this.events.flatMap((gEvent) => {
            const ofcEvent = this.googleEventToOFC(gEvent);
            if (!ofcEvent) return [];
            return [[ofcEvent, null] as EventResponse];
        });
    }

    /**
     * Convert a Google Calendar event to OFCEvent.
     */
    private googleEventToOFC(gEvent: GoogleEvent): OFCEvent | null {
        if (!gEvent.summary && !gEvent.start) return null;

        const title = gEvent.summary || "(No title)";
        const id = gEvent.id;
        const ofcColor =
            gEvent.extendedProperties?.private?.ofcColor ?? undefined;

        // All-day event
        if (gEvent.start?.date) {
            return {
                title,
                id,
                type: "single",
                allDay: true,
                date: gEvent.start.date,
                endDate: gEvent.end?.date || null,
                completed: null,
                ...(ofcColor ? { color: ofcColor } : {}),
            };
        }

        // Timed event
        if (gEvent.start?.dateTime) {
            const startDT = new Date(gEvent.start.dateTime);
            const endDT = gEvent.end?.dateTime
                ? new Date(gEvent.end.dateTime)
                : null;

            const date = this.formatDate(startDT);
            const startTime = this.formatTime(startDT);
            const endTime = endDT ? this.formatTime(endDT) : null;

            // Check for multi-day timed events
            const endDate =
                endDT && this.formatDate(endDT) !== date
                    ? this.formatDate(endDT)
                    : null;

            return {
                title,
                id,
                type: "single",
                allDay: false,
                date,
                endDate,
                startTime,
                endTime,
                completed: null,
                ...(ofcColor ? { color: ofcColor } : {}),
            };
        }

        return null;
    }

    /**
     * Convert OFCEvent to Google Calendar API event format.
     */
    private ofcToGoogleEvent(event: OFCEvent): Partial<GoogleEvent> {
        const gEvent: Partial<GoogleEvent> = {
            summary: event.title,
        };

        if (event.type !== "single") {
            // For now, only handle single events for creation/modification
            // Recurring events from Google are read-only
            return gEvent;
        }

        if (event.allDay) {
            gEvent.start = { date: event.date };
            gEvent.end = { date: event.endDate || event.date };
        } else {
            const startDateTime = this.parseDateTime(
                event.date,
                event.startTime
            );
            let endDateTime: string;
            if (event.endTime) {
                const endDate = event.endDate || event.date;
                endDateTime = this.parseDateTime(endDate, event.endTime);
            } else {
                // Default to 1 hour duration
                const start = new Date(startDateTime);
                start.setHours(start.getHours() + 1);
                endDateTime = start.toISOString();
            }
            const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            gEvent.start = { dateTime: startDateTime, timeZone: tz };
            gEvent.end = { dateTime: endDateTime, timeZone: tz };
        }

        // 일정별 색상을 Google extendedProperties.private에 저장 (재시작/재동기화 후에도 유지)
        if (event.color) {
            gEvent.extendedProperties = {
                private: { ofcColor: event.color },
            };
        }

        return gEvent;
    }

    // --- Write operations ---

    /**
     * Create an event on Google Calendar.
     * Returns the Google event ID of the created event.
     */
    async createGoogleEvent(event: OFCEvent): Promise<string> {
        const token = await this.authService.getValidAccessToken();
        const gEvent = this.ofcToGoogleEvent(event);

        const response = await requestUrl({
            url: `${GOOGLE_CALENDAR_API_BASE}/${encodeURIComponent(
                this.calendarId
            )}/events`,
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(gEvent),
        });

        const data = response.json;
        if (data.error) {
            throw new Error(`Failed to create event: ${data.error.message}`);
        }

        return data.id;
    }

    /**
     * Update an event on Google Calendar.
     */
    async updateGoogleEvent(
        googleEventId: string,
        event: OFCEvent
    ): Promise<void> {
        const token = await this.authService.getValidAccessToken();
        const gEvent = this.ofcToGoogleEvent(event);

        const response = await requestUrl({
            url: `${GOOGLE_CALENDAR_API_BASE}/${encodeURIComponent(
                this.calendarId
            )}/events/${encodeURIComponent(googleEventId)}`,
            method: "PATCH",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(gEvent),
        });

        const data = response.json;
        if (data.error) {
            throw new Error(`Failed to update event: ${data.error.message}`);
        }
    }

    /**
     * Delete an event from Google Calendar.
     */
    async deleteGoogleEvent(googleEventId: string): Promise<void> {
        const token = await this.authService.getValidAccessToken();

        await requestUrl({
            url: `${GOOGLE_CALENDAR_API_BASE}/${encodeURIComponent(
                this.calendarId
            )}/events/${encodeURIComponent(googleEventId)}`,
            method: "DELETE",
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });
    }

    // --- Helpers ---

    private formatDate(d: Date): string {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
            2,
            "0"
        )}-${String(d.getDate()).padStart(2, "0")}`;
    }

    private formatTime(d: Date): string {
        return `${String(d.getHours()).padStart(2, "0")}:${String(
            d.getMinutes()
        ).padStart(2, "0")}`;
    }

    private parseDateTime(date: string, time: string): string {
        // date: "YYYY-MM-DD", time: "HH:mm"
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const d = new Date(`${date}T${time}:00`);
        return d.toISOString();
    }
}
