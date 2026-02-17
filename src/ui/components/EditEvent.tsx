import { DateTime } from "luxon";
import * as React from "react";
import { useEffect, useRef, useState, useCallback } from "react";
import { CalendarInfo, OFCEvent } from "../../types";
import { getAccentColorHex, toHexForColorInput } from "../../colorUtils";

const AUTO_SAVE_DEBOUNCE_MS = 400;

const COLOR_PRESETS = [
    { id: "work", label: "업무", color: "#1F3A8A" },
    { id: "exercise", label: "운동", color: "#059669" },
    { id: "personal", label: "개인", color: "#EA580C" },
] as const;

function makeChangeListener<T>(
    setState: React.Dispatch<React.SetStateAction<T>>,
    fromString: (val: string) => T
): React.ChangeEventHandler<HTMLInputElement | HTMLSelectElement> {
    return (e) => setState(fromString(e.target.value));
}

interface DayChoiceProps {
    code: string;
    label: string;
    isSelected: boolean;
    onClick: (code: string) => void;
}
const DayChoice = ({ code, label, isSelected, onClick }: DayChoiceProps) => (
    <button
        type="button"
        style={{
            marginLeft: "0.25rem",
            marginRight: "0.25rem",
            padding: "0",
            backgroundColor: isSelected
                ? "var(--interactive-accent)"
                : "var(--interactive-normal)",
            color: isSelected ? "var(--text-on-accent)" : "var(--text-normal)",
            borderStyle: "solid",
            borderWidth: "1px",
            borderRadius: "50%",
            width: "25px",
            height: "25px",
        }}
        onClick={() => onClick(code)}
    >
        <b>{label[0]}</b>
    </button>
);

const DAY_MAP = {
    U: "Sunday",
    M: "Monday",
    T: "Tuesday",
    W: "Wednesday",
    R: "Thursday",
    F: "Friday",
    S: "Saturday",
};

const DaySelect = ({
    value: days,
    onChange,
}: {
    value: string[];
    onChange: (days: string[]) => void;
}) => {
    return (
        <div>
            {Object.entries(DAY_MAP).map(([code, label]) => (
                <DayChoice
                    key={code}
                    code={code}
                    label={label}
                    isSelected={days.includes(code)}
                    onClick={() =>
                        days.includes(code)
                            ? onChange(days.filter((c) => c !== code))
                            : onChange([code, ...days])
                    }
                />
            ))}
        </div>
    );
};

interface SubmitOptions {
    markCreated?: () => void;
}
interface EditEventProps {
    submit: (
        frontmatter: OFCEvent,
        calendarIndex: number,
        options?: SubmitOptions
    ) => Promise<void>;
    readonly calendars: {
        id: string;
        name: string;
        type: CalendarInfo["type"];
    }[];
    defaultCalendarIndex: number;
    initialEvent?: Partial<OFCEvent>;
    open?: () => Promise<void>;
    deleteEvent?: () => Promise<void>;
    closeModal?: () => void;
    registerBeforeClose?: (fn: () => Promise<void>) => void;
    isCreate?: boolean;
}

export const EditEvent = ({
    initialEvent,
    submit,
    open,
    deleteEvent,
    calendars,
    defaultCalendarIndex,
    closeModal,
    registerBeforeClose,
    isCreate = false,
}: EditEventProps) => {
    const [date, setDate] = useState(
        initialEvent
            ? initialEvent.type === "single"
                ? initialEvent.date
                : initialEvent.type === "recurring"
                ? initialEvent.startRecur
                : initialEvent.type === "rrule"
                ? initialEvent.startDate
                : ""
            : ""
    );
    const [endDate, setEndDate] = useState(
        initialEvent && initialEvent.type === "single"
            ? initialEvent.endDate
            : undefined
    );

    let initialStartTime = "";
    let initialEndTime = "";
    if (initialEvent) {
        // @ts-ignore
        const { startTime, endTime } = initialEvent;
        initialStartTime = startTime || "";
        initialEndTime = endTime || "";
    }

    const [startTime, setStartTime] = useState(initialStartTime);
    const [endTime, setEndTime] = useState(initialEndTime);
    const [title, setTitle] = useState(initialEvent?.title || "");
    const [isRecurring, setIsRecurring] = useState(
        initialEvent?.type === "recurring" || false
    );
    const [endRecur, setEndRecur] = useState("");

    const [daysOfWeek, setDaysOfWeek] = useState<string[]>(
        (initialEvent?.type === "recurring" ? initialEvent.daysOfWeek : []) ||
            []
    );

    const [allDay, setAllDay] = useState(initialEvent?.allDay || false);

    const [calendarIndex, setCalendarIndex] = useState(defaultCalendarIndex);

    const defaultEventColor =
        typeof document !== "undefined" ? getAccentColorHex() : "#808080";
    const [eventColor, setEventColor] = useState(
        initialEvent?.color
            ? toHexForColorInput(initialEvent.color)
            : defaultEventColor
    );

    const [complete, setComplete] = useState(
        initialEvent?.type === "single" &&
            initialEvent.completed !== null &&
            initialEvent.completed !== undefined
            ? initialEvent.completed
            : false
    );

    const [isTask, setIsTask] = useState(
        initialEvent?.type === "single" &&
            initialEvent.completed !== undefined &&
            initialEvent.completed !== null
    );

    const titleRef = useRef<HTMLInputElement>(null);
    const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hasCreatedRef = useRef(false);

    const getEventData = useCallback(
        () =>
            ({
                ...{ title },
                ...{ color: eventColor },
                ...(allDay
                    ? { allDay: true }
                    : { allDay: false, startTime: startTime || "", endTime }),
                ...(isRecurring
                    ? {
                          type: "recurring",
                          daysOfWeek: daysOfWeek as (
                              | "U"
                              | "M"
                              | "T"
                              | "W"
                              | "R"
                              | "F"
                              | "S"
                          )[],
                          startRecur: date || undefined,
                          endRecur: endRecur || undefined,
                      }
                    : {
                          type: "single",
                          date: date || "",
                          endDate: endDate || null,
                          completed: isTask ? complete : null,
                      }),
            } as OFCEvent),
        [
            title,
            eventColor,
            allDay,
            startTime,
            endTime,
            isRecurring,
            daysOfWeek,
            date,
            endRecur,
            endDate,
            isTask,
            complete,
        ]
    );

    const performSave = useCallback(
        async (overrides?: Partial<OFCEvent>) => {
            const base = getEventData();
            const data = (
                overrides ? { ...base, ...overrides } : base
            ) as OFCEvent;
            if (isCreate && !data.title) return;
            if (isCreate && !date) return;
            if (isCreate && hasCreatedRef.current) return;
            try {
                await submit(data, calendarIndex, {
                    markCreated: () => {
                        hasCreatedRef.current = true;
                    },
                });
                if (isCreate) hasCreatedRef.current = true;
            } catch (_e) {
                /* submit handles notice */
            }
        },
        [getEventData, isCreate, date, calendarIndex, submit]
    );

    const autoSave = useCallback(() => {
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }
        saveTimeoutRef.current = setTimeout(
            () => performSave(undefined),
            AUTO_SAVE_DEBOUNCE_MS
        );
    }, [performSave]);

    const saveImmediately = useCallback(
        (overrides?: Partial<OFCEvent>) => {
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
                saveTimeoutRef.current = null;
            }
            return performSave(overrides);
        },
        [performSave]
    );

    useEffect(() => {
        if (titleRef.current) {
            titleRef.current.focus();
        }
    }, [titleRef]);

    useEffect(
        () => () => {
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
            }
        },
        []
    );

    useEffect(() => {
        if (registerBeforeClose) {
            registerBeforeClose(async () => saveImmediately());
        }
    }, [registerBeforeClose, saveImmediately]);

    const wrapChange =
        <T,>(
            setter: React.Dispatch<React.SetStateAction<T>>,
            fromString: (val: string) => T
        ) =>
        (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
            setter(fromString(e.target.value));
            autoSave();
        };

    const wrapCheck =
        (setter: React.Dispatch<React.SetStateAction<boolean>>) =>
        (e: React.ChangeEvent<HTMLInputElement>) => {
            setter(e.target.checked);
            autoSave();
        };

    const wrapDays = (fn: (days: string[]) => void) => (days: string[]) => {
        fn(days);
        autoSave();
    };

    return (
        <>
            <div>
                <p style={{ float: "right" }}>
                    {open && <button onClick={open}>Open Note</button>}
                </p>
            </div>

            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    saveImmediately();
                }}
            >
                <p>
                    <input
                        ref={titleRef}
                        type="text"
                        id="title"
                        value={title}
                        placeholder={"Add title"}
                        required
                        onChange={wrapChange(setTitle, (x) => x)}
                    />
                </p>
                <p
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                        flexWrap: "wrap",
                    }}
                >
                    <input
                        type="color"
                        value={toHexForColorInput(eventColor)}
                        onChange={(e) => {
                            const c = e.target.value;
                            setEventColor(c);
                            saveImmediately({ color: c });
                        }}
                        style={{
                            width: "2rem",
                            height: "1.5rem",
                            padding: 0,
                            border: "none",
                            cursor: "pointer",
                        }}
                        title="Event color"
                    />
                    {COLOR_PRESETS.map((preset) => (
                        <label
                            key={preset.id}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.25rem",
                                cursor: "pointer",
                            }}
                        >
                            <input
                                type="radio"
                                name="colorPreset"
                                checked={
                                    eventColor.toUpperCase() ===
                                    preset.color.toUpperCase()
                                }
                                onChange={() => {
                                    setEventColor(preset.color);
                                    saveImmediately({ color: preset.color });
                                }}
                            />
                            <span
                                style={{
                                    width: "0.75rem",
                                    height: "0.75rem",
                                    borderRadius: "2px",
                                    backgroundColor: preset.color,
                                }}
                            />
                            {preset.label}
                        </label>
                    ))}
                </p>
                <p>
                    <select
                        id="calendar"
                        value={calendarIndex}
                        onChange={(e) => {
                            setCalendarIndex(parseInt(e.target.value));
                            autoSave();
                        }}
                    >
                        {calendars.map((cal, idx) => (
                            <option
                                key={idx}
                                value={idx}
                                disabled={
                                    !(
                                        initialEvent?.title === undefined ||
                                        calendars[calendarIndex].type ===
                                            cal.type
                                    )
                                }
                            >
                                {cal.type === "gcal"
                                    ? `[Google] ${cal.name}`
                                    : cal.type === "dailynote"
                                    ? "Daily Note"
                                    : cal.name}
                            </option>
                        ))}
                    </select>
                </p>
                <p>
                    {!isRecurring && (
                        <input
                            type="date"
                            id="date"
                            value={date}
                            required={!isRecurring}
                            // @ts-ignore
                            onChange={wrapChange(setDate, (x) => x)}
                        />
                    )}

                    {allDay ? (
                        <></>
                    ) : (
                        <>
                            <input
                                type="time"
                                id="startTime"
                                value={startTime}
                                required
                                onChange={wrapChange(setStartTime, (x) => x)}
                            />
                            -
                            <input
                                type="time"
                                id="endTime"
                                value={endTime}
                                required
                                onChange={wrapChange(setEndTime, (x) => x)}
                            />
                        </>
                    )}
                </p>
                <p>
                    <label htmlFor="allDay">All day event </label>
                    <input
                        id="allDay"
                        checked={allDay}
                        onChange={wrapCheck(setAllDay)}
                        type="checkbox"
                    />
                </p>
                <p>
                    <label htmlFor="recurring">Recurring Event </label>
                    <input
                        id="recurring"
                        checked={isRecurring}
                        onChange={wrapCheck(setIsRecurring)}
                        type="checkbox"
                    />
                </p>

                {isRecurring && (
                    <>
                        <DaySelect
                            value={daysOfWeek}
                            onChange={wrapDays(setDaysOfWeek)}
                        />
                        <p>
                            Starts recurring
                            <input
                                type="date"
                                id="startDate"
                                value={date}
                                // @ts-ignore
                                onChange={wrapChange(setDate, (x) => x)}
                            />
                            and stops recurring
                            <input
                                type="date"
                                id="endDate"
                                value={endRecur}
                                onChange={wrapChange(setEndRecur, (x) => x)}
                            />
                        </p>
                    </>
                )}
                <p>
                    <label htmlFor="task">Task Event </label>
                    <input
                        id="task"
                        checked={isTask}
                        onChange={wrapCheck(setIsTask)}
                        type="checkbox"
                    />
                </p>

                {isTask && (
                    <>
                        <label htmlFor="taskStatus">Complete? </label>
                        <input
                            id="taskStatus"
                            checked={
                                !(complete === false || complete === undefined)
                            }
                            onChange={(e) => {
                                setComplete(
                                    e.target.checked
                                        ? DateTime.now().toISO()
                                        : false
                                );
                                autoSave();
                            }}
                            type="checkbox"
                        />
                    </>
                )}

                <p
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        width: "100%",
                    }}
                >
                    {closeModal && (
                        <button type="button" onClick={closeModal}>
                            Close
                        </button>
                    )}
                    <span>
                        {deleteEvent && (
                            <button
                                type="button"
                                style={{
                                    backgroundColor:
                                        "var(--interactive-normal)",
                                    color: "var(--background-modifier-error)",
                                    borderColor:
                                        "var(--background-modifier-error)",
                                    borderWidth: "1px",
                                    borderStyle: "solid",
                                }}
                                onClick={deleteEvent}
                            >
                                Delete Event
                            </button>
                        )}
                    </span>
                </p>
            </form>
        </>
    );
};
