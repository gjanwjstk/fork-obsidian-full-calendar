import { Notice, TFile } from "obsidian";
import equal from "deep-equal";

import { Calendar } from "../calendars/Calendar";
import { EditableCalendar } from "../calendars/EditableCalendar";
import EventStore, { StoredEvent } from "./EventStore";
import {
    CalendarInfo,
    OFCEvent,
    validateEvent,
    generateEventUid,
} from "../types";
import RemoteCalendar from "../calendars/RemoteCalendar";
import FullNoteCalendar from "../calendars/FullNoteCalendar";
import GoogleCalendar from "../calendars/GoogleCalendar";

export type CalendarInitializerMap = Record<
    CalendarInfo["type"],
    (info: CalendarInfo) => Calendar | null
>;

export type EventCacheOptions = {
    getGcalEventColorSync?: () => boolean;
};

export type CacheEntry = { event: OFCEvent; id: string; calendarId: string };

export type UpdateViewCallback = (
    info:
        | {
              type: "events";
              toRemove: string[];
              toAdd: CacheEntry[];
          }
        | { type: "calendar"; calendar: OFCEventSource }
        | { type: "resync" }
) => void;

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const MILLICONDS_BETWEEN_REVALIDATIONS = 5 * MINUTE;

/**
 * Normalize event for comparison. Hex color is lowercased so "#1F3A8A" and "#1f3a8a" are equal.
 */
function normalizeEventForCompare(e: OFCEvent): OFCEvent {
    const copy = { ...e };
    if (
        copy.color &&
        typeof copy.color === "string" &&
        /^#[0-9A-Fa-f]{3,8}$/.test(copy.color)
    ) {
        copy.color = copy.color.toLowerCase();
    }
    return copy;
}

function eventSortKey(e: OFCEvent): string {
    const date =
        e.type === "single"
            ? e.date ?? ""
            : e.type === "recurring"
            ? e.startRecur ?? ""
            : e.type === "rrule"
            ? e.startDate ?? ""
            : "";
    const time =
        (e.type === "single" || !e.type) && "startTime" in e && e.startTime
            ? e.startTime
            : "";
    return `${e.title}|${date}|${time}`;
}

export const eventsAreDifferent = (
    oldEvents: OFCEvent[],
    newEvents: OFCEvent[]
): boolean => {
    let oldList = [...oldEvents].sort((a, b) =>
        eventSortKey(a).localeCompare(eventSortKey(b))
    );
    let newList = [...newEvents].sort((a, b) =>
        eventSortKey(a).localeCompare(eventSortKey(b))
    );

    // validateEvent() will normalize the representation of default fields in events.
    oldList = oldList.flatMap((e) => validateEvent(e) || []);
    newList = newList.flatMap((e) => validateEvent(e) || []);

    console.debug("comparing events", oldEvents, newEvents);

    if (oldList.length !== newList.length) {
        return true;
    }

    const unmatchedEvents = oldList
        .map((e, i) => ({
            oldEvent: normalizeEventForCompare(e),
            newEvent: normalizeEventForCompare(newList[i]),
        }))
        .filter(({ oldEvent, newEvent }) => !equal(oldEvent, newEvent));

    if (unmatchedEvents.length > 0) {
        console.debug("unmached events when comparing", unmatchedEvents);
    }

    return unmatchedEvents.length > 0;
};

/**
 * Create a stable key for matching events (same file, same semantic identity).
 * Used to preserve cache IDs when refreshing from disk.
 * UID takes precedence; otherwise title|type|date|startTime|endTime for single timed events.
 */
function eventMatchKey(e: OFCEvent): string {
    if (e.uid) return `uid:${e.uid}`;
    const date =
        e.type === "single"
            ? e.date
            : e.type === "recurring"
            ? e.startRecur
            : e.type === "rrule"
            ? e.startDate
            : "";
    const time =
        e.type === "single" &&
        !e.allDay &&
        "startTime" in e &&
        (e.startTime || e.endTime)
            ? `|${e.startTime ?? ""}|${e.endTime ?? ""}`
            : "";
    return `${e.title}|${e.type || "single"}|${date || ""}${time}`;
}

export type CachedEvent = Pick<StoredEvent, "event" | "id">;

export type OFCEventSource = {
    events: CachedEvent[];
    editable: boolean;
    color: string;
    id: string;
};

/**
 * Persistent event cache that also can write events back to disk.
 *
 * The EventCache acts as the bridge between the source-of-truth for
 * calendars (either the network or filesystem) and the FullCalendar view plugin.
 *
 * It maintains its own copy of all events which should be displayed on calendars
 * in the internal event format.
 *
 * Pluggable Calendar classes are responsible for parsing and serializing events
 * from their source, but the EventCache performs all I/O itself.
 *
 * Subscribers can register callbacks on the EventCache to be updated when events
 * change on disk.
 */
const FILE_MODIFY_GRACE_MS = 500;

export default class EventCache {
    private calendarInfos: CalendarInfo[] = [];

    /** 파일 수정 직후 fileUpdated로 덮어쓰는 것을 방지 (stale metadata 대응) */
    private recentlyModifiedFiles: Map<string, number> = new Map();

    private calendarInitializers: CalendarInitializerMap;

    private getGcalEventColorSync: () => boolean;

    private store = new EventStore();
    calendars = new Map<string, Calendar>();

    private pkCounter = 0;

    private revalidating = false;

    generateId(): string {
        return `${this.pkCounter++}`;
    }

    private updateViewCallbacks: UpdateViewCallback[] = [];

    initialized = false;

    lastRevalidation: number = 0;

    constructor(
        calendarInitializers: CalendarInitializerMap,
        options?: EventCacheOptions
    ) {
        this.calendarInitializers = calendarInitializers;
        this.getGcalEventColorSync =
            options?.getGcalEventColorSync ?? (() => true);
    }

    /**
     * Flush the cache and initialize calendars from the initializer map.
     */
    reset(infos: CalendarInfo[]): void {
        this.lastRevalidation = 0;
        this.initialized = false;
        this.calendarInfos = infos;
        this.pkCounter = 0;
        this.calendars.clear();
        this.store.clear();
        this.resync();
        this.init();
    }

    init() {
        this.calendarInfos
            .flatMap((s) => {
                const cal = this.calendarInitializers[s.type](s);
                return cal || [];
            })
            .forEach((cal) => this.calendars.set(cal.id, cal));
    }

    /**
     * Populate the cache with events.
     */
    async populate(): Promise<void> {
        if (!this.initialized || this.calendars.size === 0) {
            this.init();
        }
        for (const calendar of this.calendars.values()) {
            const results = await calendar.getEvents();
            results.forEach(([event, location]) =>
                this.store.add({
                    calendar,
                    location,
                    id: event.id || this.generateId(),
                    event,
                })
            );
        }
        this.initialized = true;
        this.revalidateRemoteCalendars();
    }

    resync(): void {
        for (const callback of this.updateViewCallbacks) {
            callback({ type: "resync" });
        }
    }

    /**
     * Get all events from the cache in a FullCalendar-friendly format.
     * @returns EventSourceInputs for FullCalendar.
     */
    getAllEvents(): OFCEventSource[] {
        const result: OFCEventSource[] = [];
        const eventsByCalendar = this.store.eventsByCalendar;
        for (const [calId, calendar] of this.calendars.entries()) {
            const events = eventsByCalendar.get(calId) || [];
            result.push({
                editable:
                    calendar instanceof EditableCalendar ||
                    calendar instanceof GoogleCalendar,
                events: events.map(({ event, id }) => ({ event, id })), // make sure not to leak location data past the cache.
                color: calendar.color,
                id: calId,
            });
        }
        return result;
    }

    /**
     * Check if an event is part of an editable calendar.
     * @param id ID of event to check
     * @returns
     */
    isEventEditable(id: string): boolean {
        const calId = this.store.getEventDetails(id)?.calendarId;
        if (!calId) {
            return false;
        }
        const cal = this.getCalendarById(calId);
        return cal instanceof EditableCalendar || cal instanceof GoogleCalendar;
    }

    getEventById(s: string): OFCEvent | null {
        return this.store.getEventById(s);
    }

    getCalendarById(c: string): Calendar | undefined {
        return this.calendars.get(c);
    }

    /**
     * Get calendar and location information for a given event in an editable calendar.
     * Throws an error if event is not found or if it does not have a location in the Vault.
     * @param eventId ID of event in question.
     * @returns Calendar and location for an event.
     */
    getInfoForEditableEvent(eventId: string) {
        const details = this.store.getEventDetails(eventId);
        if (!details) {
            throw new Error(`Event ID ${eventId} not present in event store.`);
        }
        const { calendarId, location } = details;
        const calendar = this.calendars.get(calendarId);
        if (!calendar) {
            throw new Error(`Calendar ID ${calendarId} is not registered.`);
        }
        if (!(calendar instanceof EditableCalendar)) {
            // console.warn("Cannot modify event of type " + calendar.type);
            throw new Error(`Read-only events cannot be modified.`);
        }
        if (!location) {
            throw new Error(
                `Event with ID ${eventId} does not have a location in the Vault.`
            );
        }
        return { calendar, location };
    }

    /**
     * Get the calendar for an editable event (EditableCalendar or GoogleCalendar).
     * Use this for UI operations where only the calendar reference is needed.
     * @param eventId ID of event in question.
     * @returns Calendar instance (EditableCalendar or GoogleCalendar).
     */
    getWritableCalendarForEvent(eventId: string): Calendar {
        const details = this.store.getEventDetails(eventId);
        if (!details) {
            throw new Error(`Event ID ${eventId} not present in event store.`);
        }
        const { calendarId } = details;
        const calendar = this.calendars.get(calendarId);
        if (!calendar) {
            throw new Error(`Calendar ID ${calendarId} is not registered.`);
        }
        if (
            !(calendar instanceof EditableCalendar) &&
            !(calendar instanceof GoogleCalendar)
        ) {
            throw new Error(`Read-only events cannot be modified.`);
        }
        return calendar;
    }

    ///
    // View Callback functions
    ///

    /**
     * Register a callback for a view.
     * @param eventType event type (currently just "update")
     * @param callback
     * @returns reference to callback for de-registration.
     */
    on(eventType: "update", callback: UpdateViewCallback) {
        switch (eventType) {
            case "update":
                this.updateViewCallbacks.push(callback);
                break;
        }
        return callback;
    }

    /**
     * De-register a callback for a view.
     * @param eventType event type
     * @param callback callback to remove
     */
    off(eventType: "update", callback: UpdateViewCallback) {
        switch (eventType) {
            case "update":
                this.updateViewCallbacks.remove(callback);
                break;
        }
    }

    /**
     * Push updates to all subscribers.
     * @param toRemove IDs of events to remove from the view.
     * @param toAdd Events to add to the view.
     */
    private updateViews(toRemove: string[], toAdd: CacheEntry[]) {
        const payload = {
            toRemove,
            toAdd,
        };

        for (const callback of this.updateViewCallbacks) {
            callback({ type: "events", ...payload });
        }
    }

    private updateCalendar(calendar: OFCEventSource) {
        for (const callback of this.updateViewCallbacks) {
            callback({ type: "calendar", calendar });
        }
    }

    ///
    // Functions to update the cache from the view layer.
    ///

    /**
     * Add an event to a given calendar.
     * @param calendarId ID of calendar to add event to.
     * @param event Event details
     * @returns Returns true if successful, false otherwise.
     */
    async addEvent(calendarId: string, event: OFCEvent): Promise<boolean> {
        const calendar = this.calendars.get(calendarId);
        if (!calendar) {
            throw new Error(`Calendar ID ${calendarId} is not registered.`);
        }

        // Handle Google Calendar
        if (calendar instanceof GoogleCalendar) {
            const googleEventId = await calendar.createGoogleEvent(
                event,
                this.getGcalEventColorSync()
            );
            const eventWithId = { ...event, id: googleEventId };
            const id = this.store.add({
                calendar,
                location: null,
                id: googleEventId,
                event: eventWithId,
            });
            this.updateViews(
                [],
                [{ event: eventWithId, id, calendarId: calendar.id }]
            );
            return true;
        }

        if (!(calendar instanceof EditableCalendar)) {
            console.error(
                `Event cannot be added to non-editable calendar of type ${calendar.type}`
            );
            throw new Error(`Cannot add event to a read-only calendar`);
        }
        const location = await calendar.createEvent(event);
        const id = this.store.add({
            calendar,
            location,
            id: event.id || this.generateId(),
            event,
        });

        this.updateViews([], [{ event, id, calendarId: calendar.id }]);
        return true;
    }

    /**
     * Delete an event by its ID.
     * @param eventId ID of event to be deleted.
     */
    async deleteEvent(eventId: string): Promise<void> {
        const details = this.store.getEventDetails(eventId);
        if (!details) {
            // 이벤트가 이미 캐시에 없음 (파일 동기화, revalidation 등으로 제거됨). no-op.
            return;
        }
        const cal = this.calendars.get(details.calendarId);
        if (cal instanceof GoogleCalendar) {
            const event = this.store.getEventById(eventId);
            const googleEventId = event?.id || eventId;
            this.store.delete(eventId);
            this.updateViews([eventId], []); // 화면에서 제거 (API 실패 여부와 무관)
            try {
                await cal.deleteGoogleEvent(googleEventId);
            } catch (apiErr: unknown) {
                // HTTP 410 = 이미 삭제됨. 성공으로 간주.
                const msg =
                    apiErr instanceof Error ? apiErr.message : String(apiErr);
                if (msg.includes("410")) return;
                throw apiErr;
            }
            return;
        }

        const { calendar, location } = this.getInfoForEditableEvent(eventId);
        this.store.delete(eventId);
        await (calendar as EditableCalendar).deleteEvent(location);
        this.updateViews([eventId], []);
    }

    /**
     * Update an event with a given ID.
     * @param eventId ID of event to update.
     * @param newEvent new event contents
     * @returns true if update was successful, false otherwise.
     */
    async updateEventWithId(
        eventId: string,
        newEvent: OFCEvent
    ): Promise<boolean> {
        // Check if this is a Google Calendar event
        const details = this.store.getEventDetails(eventId);
        if (details) {
            const calendar = this.calendars.get(details.calendarId);
            if (calendar instanceof GoogleCalendar) {
                const oldEvent = this.store.getEventById(eventId);
                const googleEventId = oldEvent?.id || eventId;
                console.debug(
                    "updating Google Calendar event with ID",
                    googleEventId
                );

                await calendar.updateGoogleEvent(
                    googleEventId,
                    newEvent,
                    this.getGcalEventColorSync()
                );

                const updatedEvent = { ...newEvent, id: googleEventId };
                this.store.delete(eventId);
                this.store.add({
                    calendar,
                    location: null,
                    id: eventId,
                    event: updatedEvent,
                });

                this.updateViews(
                    [eventId],
                    [
                        {
                            id: eventId,
                            calendarId: calendar.id,
                            event: updatedEvent,
                        },
                    ]
                );
                return true;
            }
        }

        if (!details) {
            // 이벤트가 이미 캐시에 없음. 업데이트 불가.
            return false;
        }

        try {
            var { calendar, location: oldLocation } =
                this.getInfoForEditableEvent(eventId);
        } catch (e) {
            if (
                e instanceof Error &&
                e.message.includes("not present in event store")
            ) {
                // 레이스: 체크 후에 file sync 등으로 이벤트 제거됨
                return false;
            }
            throw e;
        }
        const { path, lineNumber } = oldLocation;
        console.debug("updating event with ID", eventId);

        // fileUpdated가 stale metadata로 즉시 덮어쓰는 것을 방지
        this.recentlyModifiedFiles.set(path, Date.now());

        const oldEvent = this.store.getEventById(eventId) ?? undefined;
        await calendar.modifyEvent(
            { path, lineNumber },
            newEvent,
            (newLocation) => {
                this.store.delete(eventId);
                this.store.add({
                    calendar,
                    location: newLocation,
                    id: eventId,
                    event: newEvent,
                });
            },
            oldEvent
        );

        this.updateViews(
            [eventId],
            [{ id: eventId, calendarId: calendar.id, event: newEvent }]
        );
        return true;
    }

    /**
     * Transform an event that's already in the event store.
     *
     * A more "type-safe" wrapper around updateEventWithId(),
     * use this function if the caller is only modifying few
     * known properties of an event.
     * @param id ID of event to transform.
     * @param process function to transform the event.
     * @returns true if the update was successful.
     */
    /**
     * Assign UIDs to local events that don't have one.
     * Returns the number of events updated.
     */
    async assignUidsToEventsWithoutUid(): Promise<number> {
        let count = 0;
        const eventsByCalendar = this.store.eventsByCalendar;
        for (const [calId, events] of eventsByCalendar) {
            const calendar = this.calendars.get(calId);
            if (!(calendar instanceof EditableCalendar)) continue;
            for (const { id, event, location } of events) {
                if (event.uid || !location) continue;
                const ok = await this.updateEventWithId(id, {
                    ...event,
                    uid: generateEventUid(),
                });
                if (ok) count++;
            }
        }
        return count;
    }

    processEvent(
        id: string,
        process: (e: OFCEvent) => OFCEvent
    ): Promise<boolean> {
        const event = this.store.getEventById(id);
        if (!event) {
            throw new Error("Event does not exist");
        }
        const newEvent = process(event);
        console.debug("process", newEvent, process);
        return this.updateEventWithId(id, newEvent);
    }

    async moveEventToCalendar(
        eventId: string,
        newCalendarId: string,
        eventData?: OFCEvent,
        sourceCalendarId?: string
    ): Promise<void> {
        const event = this.store.getEventById(eventId);
        const details = this.store.getEventDetails(eventId);

        // Event may have been removed by revalidation (e.g. Google Calendar refresh) while
        // the edit modal was open. If we have eventData from the modal, add to target and delete from source.
        if (!details || !event) {
            if (eventData) {
                console.debug(
                    `Event ${eventId} not in store (likely removed by revalidation); adding form data to ${newCalendarId}`
                );
                // Preserve uid; only discard id (cache/API id) when moving to new calendar
                const { id: _discardId, ...dataWithoutId } = eventData;
                await this.addEvent(newCalendarId, dataWithoutId as OFCEvent);
                // Delete from source calendar if it was Google (prevents duplication)
                if (sourceCalendarId?.startsWith("gcal::") && eventData.id) {
                    const sourceCal = this.calendars.get(sourceCalendarId);
                    if (sourceCal instanceof GoogleCalendar) {
                        try {
                            await sourceCal.deleteGoogleEvent(eventData.id);
                        } catch (apiErr: unknown) {
                            const msg =
                                apiErr instanceof Error
                                    ? apiErr.message
                                    : String(apiErr);
                            if (msg.includes("410")) return;
                            console.warn(
                                "Failed to delete from Google after move:",
                                apiErr
                            );
                        }
                    }
                }
                return;
            }
            throw new Error(
                `Tried moving unknown event ID ${eventId} to calendar ${newCalendarId}`
            );
        }
        const { calendarId: oldCalendarId, location } = details;

        const oldCalendar = this.calendars.get(oldCalendarId);
        if (!oldCalendar) {
            throw new Error(`Source calendar ${oldCalendarId} did not exist.`);
        }
        const newCalendar = this.calendars.get(newCalendarId);
        if (!newCalendar) {
            throw new Error(`Source calendar ${newCalendarId} does not exist.`);
        }

        // FullNote→FullNote with location: use existing move logic (file rename)
        if (
            oldCalendar instanceof FullNoteCalendar &&
            newCalendar instanceof FullNoteCalendar &&
            location
        ) {
            await oldCalendar.move(location, newCalendar, (newLocation) => {
                this.store.delete(eventId);
                this.store.add({
                    calendar: newCalendar,
                    location: newLocation,
                    id: eventId,
                    event,
                });
            });
            return;
        }

        // Cross-type move: add first (to avoid data loss), then delete
        const eventToAdd = eventData ?? event;
        const { id: _discardId, ...dataWithoutId } = eventToAdd;
        try {
            await this.addEvent(newCalendarId, dataWithoutId as OFCEvent);
        } catch (addErr) {
            throw addErr;
        }
        try {
            await this.deleteEvent(eventId);
        } catch (deleteErr: unknown) {
            const msg =
                deleteErr instanceof Error
                    ? deleteErr.message
                    : String(deleteErr);
            if (msg.includes("410")) {
                // HTTP 410 = 구글에서 이미 삭제됨. 정상 처리.
                return;
            }
            new Notice(
                "이벤트가 새 캘린더에 추가되었으나, 기존 캘린더에서 삭제에 실패했습니다. 중복된 이벤트가 있을 수 있으니 확인해 주세요."
            );
            throw deleteErr;
        }
    }

    ///
    // Filesystem hooks
    ///

    /**
     * Delete all events located at a given path and notify subscribers.
     * @param path path of file that has been deleted
     */
    deleteEventsAtPath(path: string) {
        this.updateViews([...this.store.deleteEventsAtPath(path)], []);
    }

    /**
     * Main hook into the filesystem.
     * This callback should be called whenever a file has been updated or created.
     * @param file File which has been updated
     * @returns nothing
     */
    async fileUpdated(file: TFile): Promise<void> {
        console.debug("fileUpdated() called for file", file.path);

        // 우리가 방금 수정한 파일: stale metadata로 덮어쓰지 않음 (색상 즉시 되돌아가는 버그 방지)
        const modifiedAt = this.recentlyModifiedFiles.get(file.path);
        if (modifiedAt !== undefined) {
            this.recentlyModifiedFiles.delete(file.path);
            if (Date.now() - modifiedAt < FILE_MODIFY_GRACE_MS) {
                console.debug(
                    "skip fileUpdated: recently modified by us",
                    file.path
                );
                return;
            }
        }

        // Get all calendars that contain events stored in this file.
        const calendars = [...this.calendars.values()].flatMap((c) =>
            c instanceof EditableCalendar && c.containsPath(file.path) ? c : []
        );

        // If no calendars exist, return early.
        if (calendars.length === 0) {
            return;
        }

        const idsToRemove: string[] = [];
        const eventsToAdd: CacheEntry[] = [];

        for (const calendar of calendars) {
            const oldEvents = this.store.getEventsInFileAndCalendar(
                file,
                calendar
            );
            // TODO: Relying on calendars for file I/O means that we're potentially
            // reading the file from disk multiple times. Could be more effecient if
            // we break the abstraction layer here.
            console.debug("get events in file", file.path);
            const newEvents = await calendar.getEventsInFile(file);

            const oldEventsMapped = oldEvents.map(({ event }) => event);
            const newEventsMapped = newEvents.map(([event, _]) => event);
            console.debug("comparing events", file.path, oldEvents, newEvents);
            // TODO: It's possible events are not different, but the location has changed.
            const eventsHaveChanged = eventsAreDifferent(
                oldEventsMapped,
                newEventsMapped
            );

            // If no events have changed from what's in the cache, then there's no need to update the event store.
            if (!eventsHaveChanged) {
                console.debug(
                    "events have not changed, do not update store or view."
                );
                return;
            }
            console.debug(
                "events have changed, updating store and views...",
                oldEvents,
                newEvents
            );

            // 1순위: location(path + lineNumber)로 매칭 → 드래그로 시간 변경 시에도 ID 유지
            // 2순위: eventMatchKey로 fallback (외부 편집 등으로 줄 번호 밀림 시)
            const locationKey = (
                path: string,
                lineNumber: number | undefined
            ) => `${path}|${lineNumber ?? ""}`;
            const oldByLocation = new Map<string, StoredEvent>();
            const oldByKey = new Map<string, StoredEvent>();
            for (const r of oldEvents) {
                if (r.location) {
                    oldByLocation.set(
                        locationKey(r.location.path, r.location.lineNumber),
                        r
                    );
                }
                const key = eventMatchKey(r.event);
                if (!oldByKey.has(key)) oldByKey.set(key, r);
            }
            const usedIds = new Set<string>();
            const newEventsWithIds = newEvents.map(([event, location]) => {
                const path = location.file.path;
                const locKey = locationKey(path, location.lineNumber);
                let existing = oldByLocation.get(locKey);
                if (existing) {
                    oldByLocation.delete(locKey);
                    oldByKey.delete(eventMatchKey(existing.event));
                } else {
                    existing = oldByKey.get(eventMatchKey(event));
                    if (existing) oldByKey.delete(eventMatchKey(event));
                }
                let id =
                    event.id ||
                    (existing ? existing.id : null) ||
                    this.generateId();
                if (usedIds.has(id)) {
                    id = this.generateId();
                }
                usedIds.add(id);
                return {
                    event,
                    id,
                    location,
                    calendarId: calendar.id,
                };
            });

            // If events have changed in the calendar, then remove all the old events from the store and add in new ones.
            const oldIds = oldEvents.map((r: StoredEvent) => r.id);
            oldIds.forEach((id: string) => {
                this.store.delete(id);
            });
            newEventsWithIds.forEach(({ event, id, location }) => {
                this.store.add({
                    calendar,
                    location,
                    id,
                    event,
                });
            });

            idsToRemove.push(...oldIds);
            eventsToAdd.push(...newEventsWithIds);
        }

        this.updateViews(idsToRemove, eventsToAdd);
    }

    /**
     * Revalidate calendars asynchronously. This is not a blocking function: as soon as new data
     * is available for any remote calendar, its data will be updated in the cache and any subscribing views.
     */
    revalidateRemoteCalendars(force = false) {
        if (this.revalidating) {
            console.warn("Revalidation already in progress.");
            return;
        }
        const now = Date.now();

        if (
            !force &&
            now - this.lastRevalidation < MILLICONDS_BETWEEN_REVALIDATIONS
        ) {
            console.debug("Last revalidation was too soon.");
            return;
        }

        const remoteCalendars = [...this.calendars.values()].flatMap((c) =>
            c instanceof RemoteCalendar ? c : []
        );

        console.warn("Revalidating remote calendars...");
        this.revalidating = true;
        const promises = remoteCalendars.map((calendar) => {
            return calendar
                .revalidate()
                .then(() => calendar.getEvents())
                .then((events) => {
                    const deletedEvents = [
                        ...this.store.deleteEventsInCalendar(calendar),
                    ];
                    const newEvents = events.map(([event, location]) => ({
                        event,
                        id: event.id || this.generateId(),
                        location,
                        calendarId: calendar.id,
                    }));
                    newEvents.forEach(({ event, id, location }) => {
                        this.store.add({
                            calendar,
                            location,
                            id,
                            event,
                        });
                    });
                    this.updateCalendar({
                        id: calendar.id,
                        editable: calendar instanceof GoogleCalendar,
                        color: calendar.color,
                        events: newEvents,
                    });
                });
        });
        Promise.allSettled(promises).then((results) => {
            this.revalidating = false;
            this.lastRevalidation = Date.now();
            console.debug("All remote calendars have been fetched.");
            const errors = results.flatMap((result) =>
                result.status === "rejected" ? result.reason : []
            );
            if (errors.length > 0) {
                new Notice(
                    "A remote calendar failed to load. Check the console for more details."
                );
                errors.forEach((reason) => {
                    console.error(`Revalidation failed with reason: ${reason}`);
                });
            }
        });
    }

    get _storeForTest() {
        return this.store;
    }
}
