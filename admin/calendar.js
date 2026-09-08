/* Event-period calendar. All wall-clock arithmetic uses the event timezone. */
const DAY = 86400000;
const MINUTE = 60000;
const GRID_MINUTES = 1440;
const COLOURS = [
    ["#dff0e4", "#245c48"], ["#e3edfa", "#315d91"],
    ["#f8ead4", "#825916"], ["#eee6f6", "#70508e"],
    ["#f8e3e6", "#994957"], ["#dcf0ef", "#287570"],
];
// Screen colours follow WORM's dark surfaces; printed exports retain COLOURS.
const UI_COLOURS = [
    ["#3d3420", "#f2d37c"], ["#20344a", "#b9d8ff"],
    ["#3b293d", "#edc0f4"], ["#1f3a3c", "#aedadd"],
    ["#452a2a", "#ffc6c6"], ["#30304a", "#cdc9ff"],
];
const formatters = new Map();

function formatter(timezone) {
    if (!formatters.has(timezone)) {
        formatters.set(timezone, new Intl.DateTimeFormat("en-CA", {
            timeZone: timezone, calendar: "gregory", numberingSystem: "latn",
            year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
            minute: "2-digit", second: "2-digit", hourCycle: "h23",
        }));
    }
    return formatters.get(timezone);
}

/** An ISO-shaped local wall time, independent of the browser's timezone. */
export function localDateTime(instant, timezone) {
    const parts = Object.fromEntries(formatter(timezone).formatToParts(new Date(instant))
        .filter(part => part.type !== "literal").map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function localDateTimeMinute(instant, timezone) {
    return localDateTime(instant, timezone).slice(0, 16);
}

function wallMillis(text) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(text)) return NaN;
    const full = text.length === 16 ? `${text}:00` : text;
    const millis = Date.parse(`${full}Z`);
    if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== full) return NaN;
    return millis;
}

/**
 * Return every instant represented by a local wall time: zero in a clock gap,
 * two in a repeated hour. Never silently choose a DST occurrence for the user.
 * Sampling offsets around the date also handles half-hour/quarter-hour zones.
 */
export function possibleInstants(text, timezone) {
    const wall = wallMillis(text);
    if (!Number.isFinite(wall)) return [];
    const expected = new Date(wall).toISOString().slice(0, 19);
    const offsets = new Set();
    for (let delta = -48; delta <= 48; delta += 6) {
        const probe = wall + delta * 3600000;
        offsets.add(wallMillis(localDateTime(probe, timezone)) - probe);
    }
    return [...offsets].map(offset => wall - offset)
        .filter(instant => localDateTime(instant, timezone) === expected)
        .sort((a, b) => a - b).map(instant => new Date(instant).toISOString());
}

function addDays(date, count) {
    return new Date(Date.parse(`${date}T12:00:00Z`) + count * DAY).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
    const start = Date.parse(`${from}T12:00:00Z`);
    const end = Date.parse(`${to}T12:00:00Z`);
    return Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / DAY) : NaN;
}

function monday(date) {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    return addDays(date, -((weekday + 6) % 7));
}

function dateAtMinute(date, minute) {
    return new Date(Date.parse(`${date}T00:00:00Z`) + minute * MINUTE).toISOString().slice(0, 19);
}

function offsetLabel(instant, timezone) {
    const millis = new Date(instant).getTime();
    const offset = Math.round((wallMillis(localDateTime(millis, timezone)) - Math.floor(millis / 1000) * 1000) / MINUTE);
    const sign = offset < 0 ? "−" : "+";
    return `UTC${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
}

function zoneOffset(instant, timezone) {
    return wallMillis(localDateTime(instant, timezone)) - Math.floor(instant / 1000) * 1000;
}

function shortDate(date) {
    return new Intl.DateTimeFormat("en-GB", {timeZone: "UTC", weekday: "short", day: "numeric", month: "short"})
        .format(new Date(`${date}T12:00:00Z`));
}

function firstInstant(date, timezone) {
    const midnight = possibleInstants(`${date}T00:00:00`, timezone);
    if (midnight.length) return Date.parse(midnight[0]);
    // A few zones advance at midnight; the first existing minute starts that day.
    for (let minute = 1; minute < GRID_MINUTES; minute++) {
        const candidates = possibleInstants(dateAtMinute(date, minute), timezone);
        if (candidates.length) return Date.parse(candidates[0]);
    }
    return null; // A skipped calendar date, e.g. Pacific/Apia on 2011-12-30.
}

function periodRecords(event) {
    const subEvents = event.subEvents || [];
    const owners = subEvents.length ? subEvents : [{...event, subEventId: ""}];
    return owners.flatMap((owner, index) => (owner.periods || []).map(period => ({
        ...period, ownerId: owner.subEventId || "", label: owner.name || "Untitled event",
        colour: COLOURS[index % COLOURS.length], uiColour: UI_COLOURS[index % UI_COLOURS.length],
    })));
}

function validRecords(event) {
    const records = periodRecords(event);
    if (records.some(period => !Number.isFinite(Date.parse(period.startsAt)) ||
        !Number.isFinite(Date.parse(period.endsAt)) || Date.parse(period.endsAt) <= Date.parse(period.startsAt))) {
        throw new Error("A time slot has invalid dates. Correct its start and end before exporting.");
    }
    return records;
}

/** Split real instants at local day boundaries, then allocate readable lanes. */
export function splitPeriods(event, startDate, dayCount = 7) {
    const records = validRecords(event);
    return Array.from({length: dayCount}, (_, index) => {
        const date = addDays(startDate, index);
        const start = firstInstant(date, event.timezone);
        let nextDate = addDays(date, 1);
        let end = firstInstant(nextDate, event.timezone);
        // The following date itself can be skipped by a civil timezone change.
        for (let tries = 0; end === null && tries < 3; tries++) {
            nextDate = addDays(nextDate, 1);
            end = firstInstant(nextDate, event.timezone);
        }
        const clockBoundaries = start === null || end === null ? [] : [start];
        if (clockBoundaries.length) {
            let cursor = start;
            let previousOffset = zoneOffset(cursor, event.timezone);
            while (cursor < end) {
                const probe = Math.min(end, cursor + 30 * MINUTE);
                const nextOffset = zoneOffset(probe, event.timezone);
                if (nextOffset !== previousOffset) {
                    let low = Math.floor(cursor / 1000) * 1000;
                    let high = Math.ceil(probe / 1000) * 1000;
                    while (high - low > 1000) {
                        const middle = Math.floor((low + high) / 2000) * 1000;
                        if (zoneOffset(middle, event.timezone) === previousOffset) low = middle;
                        else high = middle;
                    }
                    if (high > start && high < end) clockBoundaries.push(high);
                }
                cursor = probe;
                previousOffset = nextOffset;
            }
            clockBoundaries.push(end);
        }
        const clockRanges = clockBoundaries.slice(0, -1).map((from, range) => [from, clockBoundaries[range + 1]]);
        const segments = records.flatMap(record => clockRanges.flatMap(([rangeStart, rangeEnd]) => {
            const from = Math.max(rangeStart, Date.parse(record.startsAt));
            const to = Math.min(rangeEnd, Date.parse(record.endsAt));
            if (from >= to) return [];
            const localFrom = localDateTime(from, event.timezone);
            // Use the ending segment's offset at a clock change. For example,
            // 01:45 DST–02:00 DST and 01:00 standard–01:15 standard are two
            // truthful 15-minute blocks through a repeated hour.
            const localTo = new Date(wallMillis(localDateTime(to - 1000, event.timezone)) + 1000).toISOString().slice(0, 19);
            const minuteFrom = (wallMillis(localFrom) - wallMillis(`${date}T00:00:00`)) / MINUTE;
            const minuteTo = to === end ? GRID_MINUTES : (wallMillis(localTo) - wallMillis(`${date}T00:00:00`)) / MINUTE;
            const low = Math.max(0, Math.min(minuteFrom, minuteTo));
            const high = Math.min(GRID_MINUTES, Math.max(minuteFrom, minuteTo));
            const height = high - low;
            const top = low;
            const clockChanged = end - start !== DAY;
            const fromLabel = localFrom.slice(11, 16);
            const toLabel = to === end ? "24:00" : localTo.slice(11, 16);
            const times = clockChanged
                ? `${fromLabel} ${offsetLabel(from, event.timezone)} – ${toLabel} ${offsetLabel(Math.max(from, to - 1000), event.timezone)}`
                : `${fromLabel}–${toLabel}`;
            return [{...record, date, from, to, top, height, times,
                continuesBefore: Date.parse(record.startsAt) < from,
                continuesAfter: Date.parse(record.endsAt) > to}];
        }));
        const laneEnds = [];
        segments.sort((a, b) => a.top - b.top || a.from - b.from).forEach(segment => {
            let lane = laneEnds.findIndex(laneEnd => laneEnd <= segment.top);
            if (lane < 0) lane = laneEnds.length;
            laneEnds[lane] = segment.top + segment.height;
            segment.lane = lane;
        });
        return {date, start, end, clockChanged: start !== null && end !== null && end - start !== DAY,
            segments, lanes: Math.max(1, laneEnds.length)};
    });
}

function icsText(value) {
    return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
}

function icsInstant(value) {
    return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** RFC 5545: stable UIDs, UTC instants, escaped text and UTF-8-safe line folding. */
export function calendarIcs(event, now = new Date()) {
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//WORM//Event Calendar//EN",
        "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${icsText(event.name)}`,
        `X-WR-TIMEZONE:${icsText(event.timezone)}`];
    for (const record of validRecords(event)) {
        const summary = record.ownerId ? `${event.name} — ${record.label}` : event.name;
        const uid = `${encodeURIComponent(event.eventId)}.${encodeURIComponent(record.periodId)}@worm-calendar`;
        lines.push("BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${icsInstant(now)}`,
            `DTSTART:${icsInstant(record.startsAt)}`, `DTEND:${icsInstant(record.endsAt)}`,
            `SUMMARY:${icsText(summary)}`, `DESCRIPTION:${icsText(`Timezone: ${event.timezone}`)}`,
            "END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    const encoder = new TextEncoder();
    return `${lines.map(line => {
        const folded = [];
        let current = "";
        let bytes = 0;
        for (const character of line) {
            const size = encoder.encode(character).length;
            if (bytes + size > 75) {
                folded.push(current);
                current = " ";
                bytes = 1;
            }
            current += character;
            bytes += size;
        }
        return [...folded, current].join("\r\n");
    }).join("\r\n")}\r\n`;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function filename(event) {
    return (event.name || "event").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 80) || "event";
}

function canvasLines(context, text, width) {
    const lines = [];
    for (const paragraph of String(text).split(/\r\n|\r|\n/)) {
        let line = "";
        for (const character of paragraph) {
            if (line && context.measureText(line + character).width > width) {
                lines.push(line);
                line = "";
            }
            line += character;
        }
        lines.push(line);
    }
    return lines;
}

/** Render the selected week(s) directly from period data, including all hours. */
export async function calendarImage(event, startDate, dayCount = 7) {
    const days = splitPeriods(event, startDate, dayCount);
    const laneCount = Math.max(1, ...days.map(day => day.lanes));
    const dayWidth = Math.max(185, laneCount * 160);
    const width = 80 + 7 * dayWidth;
    const weekHeight = GRID_MINUTES + 90;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot create a calendar image.");
    ctx.font = "bold 25px sans-serif";
    const title = canvasLines(ctx, event.name || "Event", width - 80);
    const top = 110 + title.length * 28;
    const visibleIds = new Set(days.flatMap(day => day.segments.map(segment => segment.periodId)));
    const records = validRecords(event).filter(record => visibleIds.has(record.periodId));
    ctx.font = "13px sans-serif";
    const legend = records.map((record, index) => ({record, number: index + 1,
        lines: canvasLines(ctx, `${index + 1}. ${record.label} · ${localDateTimeMinute(record.startsAt, event.timezone).replace("T", " ")} ${offsetLabel(record.startsAt, event.timezone)} – ${localDateTimeMinute(record.endsAt, event.timezone).replace("T", " ")} ${offsetLabel(record.endsAt, event.timezone)}`, width - 90)}));
    const legendTop = top + Math.ceil(dayCount / 7) * weekHeight;
    const height = legendTop + 45 + legend.reduce((sum, item) => sum + item.lines.length * 18 + 8, 0);
    if (width > 16000 || height > 16000 || width * height > 50000000) {
        throw new Error("This calendar has too many overlapping time slots for one image. Export the calendar file instead.");
    }
    canvas.width = width;
    canvas.height = height;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#172724";
    ctx.font = "bold 25px sans-serif";
    title.forEach((line, index) => ctx.fillText(line, 36, 42 + index * 28));
    ctx.font = "15px sans-serif";
    ctx.fillStyle = "#62716d";
    ctx.fillText(`${shortDate(startDate)} – ${shortDate(addDays(startDate, dayCount - 1))}  ·  ${event.timezone}`, 36, top - 54);
    days.forEach((day, index) => {
        const week = Math.floor(index / 7);
        const weekday = index % 7;
        const x = 64 + weekday * dayWidth;
        const y = top + week * weekHeight + 34;
        ctx.font = "bold 15px sans-serif";
        ctx.fillStyle = "#172724";
        ctx.fillText(`${shortDate(day.date)}${day.clockChanged ? " · clock change" : ""}`, x + 8, y - 14);
        ctx.strokeStyle = "#dce3db";
        ctx.lineWidth = 1;
        for (let hour = 0; hour <= 24; hour++) {
            ctx.beginPath();
            ctx.moveTo(x, y + hour * 60);
            ctx.lineTo(x + dayWidth, y + hour * 60);
            ctx.stroke();
            if (weekday === 0) {
                ctx.font = "12px sans-serif";
                ctx.fillStyle = "#62716d";
                ctx.fillText(`${String(hour).padStart(2, "0")}:00`, 16, y + hour * 60 + 4);
            }
        }
        ctx.strokeRect(x, y, dayWidth, GRID_MINUTES);
        day.segments.forEach(segment => {
            const boxWidth = dayWidth / day.lanes - 6;
            const left = x + segment.lane * dayWidth / day.lanes + 3;
            const upper = y + segment.top;
            ctx.fillStyle = segment.colour[0];
            ctx.fillRect(left, upper, boxWidth, segment.height);
            ctx.fillStyle = segment.colour[1];
            ctx.fillRect(left, upper, 4, segment.height);
            ctx.font = "bold 12px sans-serif";
            const number = legend.find(item => item.record.periodId === segment.periodId)?.number;
            const label = `${number}. ${segment.continuesBefore ? "↳ " : ""}${segment.label}${segment.continuesAfter ? " ↴" : ""}`;
            let lineY = upper + 20;
            ctx.save();
            ctx.beginPath();
            ctx.rect(left + 5, upper + 1, boxWidth - 6, Math.max(0, segment.height - 2));
            ctx.clip();
            if (segment.height >= 10 && segment.height < 26) {
                ctx.font = "bold 10px sans-serif";
                ctx.fillText(`${number}.`, left + 9, upper + Math.min(12, segment.height - 2));
                ctx.font = "bold 12px sans-serif";
            }
            const availableLines = Math.max(0, Math.floor((segment.height - 10) / 16));
            const labelLines = segment.height < 80 ? [`${number}. ${segment.label}`] : canvasLines(ctx, label, boxWidth - 18);
            labelLines.slice(0, availableLines).forEach(line => {
                if (lineY > upper + segment.height - 2) return;
                ctx.fillText(line, left + 9, lineY);
                lineY += 16;
            });
            ctx.font = "12px sans-serif";
            canvasLines(ctx, segment.times, boxWidth - 18).forEach(line => {
                if (lineY + 3 > upper + segment.height - 2) return;
                ctx.fillText(line, left + 9, lineY + 3);
                lineY += 16;
            });
            ctx.restore();
        });
    });
    let legendY = legendTop + 20;
    ctx.font = "13px sans-serif";
    legend.forEach(item => {
        ctx.fillStyle = item.record.colour[1];
        ctx.fillRect(36, legendY - 10, 8, 8);
        item.lines.forEach(line => { ctx.fillText(line, 52, legendY); legendY += 18; });
        legendY += 8;
    });
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Image export failed.")), "image/png"));
}

function element(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
}

function button(text, action, className = "") {
    const result = element("button", className, text);
    result.type = "button";
    result.addEventListener("click", action);
    return result;
}

function field(labelText, input) {
    const label = element("label", "ec-field");
    label.append(element("span", "ec-field-label", labelText), input);
    return label;
}

/**
 * Owns view state only. Period edits deliver a full cloned event to onChange;
 * navigation, resizing the view and exporting never mutate event data.
 */
export function createCalendar(container, {getEvent, onChange, onEditSubEvent}) {
    let destroyed = false;
    let eventId = null;
    let startDate = "";
    let dayCount = 7;
    let targetId = "";
    let editor = null;
    let frameScroll = {top: 8 * 60, left: 0};
    let currentFrame = null;
    let liveMessage = "";
    const root = element("section", "ec-calendar");
    root.setAttribute("aria-label", "Event schedule calendar");
    container.replaceChildren(root);

    function owners(event = getEvent()) {
        return event.subEvents?.length ? event.subEvents : [{subEventId: "", name: event.name || "Whole event"}];
    }

    function targetSelect(value) {
        const select = element("select", "form-control");
        owners().forEach(owner => {
            const option = element("option", "", owner.name || "Untitled sub-event");
            option.value = owner.subEventId || "";
            select.append(option);
        });
        select.value = value;
        return select;
    }

    function periodOwner(event, id) {
        return id ? (event.subEvents || []).find(subEvent => subEvent.subEventId === id) : event;
    }

    function commit(mutator, message) {
        const next = structuredClone(getEvent());
        mutator(next);
        editor = null;
        liveMessage = message;
        onChange(next);
        render();
    }

    function openEditor(record = null, values = null) {
        const event = getEvent();
        const today = localDateTime(Date.now(), event.timezone).slice(0, 10);
        const date = today >= startDate && today < addDays(startDate, dayCount) ? today : startDate;
        editor = {
            record, ownerId: record?.ownerId ?? targetId,
            from: (values?.from || (record ? localDateTime(record.startsAt, event.timezone) : `${date}T09:00`)).slice(0, 16),
            to: (values?.to || (record ? localDateTime(record.endsAt, event.timezone) : `${date}T10:00`)).slice(0, 16),
            preferredFrom: values ? null : record?.startsAt,
            preferredTo: values ? null : record?.endsAt,
            dragged: Boolean(values),
        };
        render();
        root.querySelector('.ec-editor input[name="period-start"]')?.focus({preventScroll: true});
        root.querySelector(".ec-editor")?.scrollIntoView({block: "nearest"});
    }

    function render() {
        if (destroyed) return;
        const event = getEvent();
        if (!event) { root.replaceChildren(); return; }
        if (currentFrame) frameScroll = {top: currentFrame.scrollTop, left: currentFrame.scrollLeft};
        currentFrame = null;
        try { formatter(event.timezone).format(); } catch {
            root.replaceChildren(element("p", "ec-error", "Choose a valid event timezone before adding time slots."));
            return;
        }
        if (eventId !== event.eventId) {
            eventId = event.eventId;
            const first = periodRecords(event).filter(period => Number.isFinite(Date.parse(period.startsAt)))
                .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
            startDate = monday(localDateTime(first?.startsAt || Date.now(), event.timezone).slice(0, 10));
            editor = null;
            targetId = owners(event)[0]?.subEventId || "";
            frameScroll = {top: first ? Math.max(0, Number(localDateTime(first.startsAt, event.timezone).slice(11, 13)) - 1) * 60 : 8 * 60, left: 0};
        }
        if (!owners(event).some(owner => (owner.subEventId || "") === targetId)) targetId = owners(event)[0]?.subEventId || "";
        root.replaceChildren();
        const toolbar = element("div", "ec-toolbar");
        const target = targetSelect(targetId);
        target.setAttribute("aria-label", "Schedule for");
        target.addEventListener("change", () => { targetId = target.value; });
        toolbar.append(field("Schedule for", target));
        const endDate = addDays(startDate, dayCount - 1);
        const from = element("input", "form-control");
        from.type = "date";
        from.value = startDate;
        from.setAttribute("aria-label", "Schedule start date");
        from.addEventListener("change", () => {
            if (!from.value) return;
            const span = daysBetween(from.value, endDate);
            startDate = from.value;
            dayCount = Number.isFinite(span) && span >= 0 ? span + 1 : 1;
            render();
        });
        const to = element("input", "form-control");
        to.type = "date";
        to.value = endDate;
        to.setAttribute("aria-label", "Schedule end date");
        to.addEventListener("change", () => {
            if (!to.value) return;
            const span = daysBetween(startDate, to.value);
            if (!Number.isFinite(span)) return;
            if (span < 0) startDate = to.value;
            dayCount = Math.max(1, span + 1);
            render();
        });
        toolbar.append(field("From", from), field("To", to));
        toolbar.append(button("Add time slot", () => openEditor(), "button--primary"));
        root.append(toolbar);
        const navigation = element("div", "ec-navigation");
        const navButtons = element("div", "ec-actions");
        const previous = button("← Previous", () => { startDate = addDays(startDate, -dayCount); render(); });
        previous.setAttribute("aria-label", "Previous calendar dates");
        const next = button("Next →", () => { startDate = addDays(startDate, dayCount); render(); });
        next.setAttribute("aria-label", "Next calendar dates");
        navButtons.append(previous, button("Today", () => { startDate = localDateTime(Date.now(), event.timezone).slice(0, 10); render(); }), next);
        navigation.append(navButtons);
        root.append(navigation);
        root.append(element("p", "ec-range", `${shortDate(startDate)} – ${shortDate(addDays(startDate, dayCount - 1))} · ${event.timezone}`));
        const message = element("p", "ec-message", liveMessage);
        message.setAttribute("role", "status");
        message.setAttribute("aria-live", "polite");
        root.append(message);
        let days;
        try { days = splitPeriods(event, startDate, dayCount); } catch (error) {
            root.append(element("p", "ec-error", error.message));
            return;
        }
        const laneWidth = dayCount === 7 ? 136 : 160;
        const dayWidth = Math.max(dayCount === 7 ? 136 : 190, Math.max(...days.map(day => day.lanes)) * laneWidth);
        const frame = element("div", "modal-surface ec-frame");
        frame.tabIndex = 0;
        frame.setAttribute("role", "region");
        frame.setAttribute("aria-label", "Scrollable schedule. Use arrow keys to scroll; use Add time slot for keyboard entry.");
        const grid = element("div", "ec-grid");
        grid.style.gridTemplateColumns = `64px repeat(${dayCount}, minmax(${dayWidth}px, 1fr))`;
        grid.append(element("div", "ec-day-heading ec-axis-heading", "Time"));
        days.forEach(day => grid.append(element("div", "ec-day-heading", `${shortDate(day.date)}${day.clockChanged ? " · clock change" : ""}`)));
        const axis = element("div", "ec-time-axis");
        for (let hour = 0; hour <= 24; hour++) {
            const label = element("span", "ec-hour-label", `${String(hour).padStart(2, "0")}:00`);
            label.style.top = `${Math.max(8, Math.min(1432, hour * 60))}px`;
            axis.append(label);
        }
        grid.append(axis);
        days.forEach((day, index) => {
            const column = element("div", "ec-day");
            column.dataset.day = String(index);
            column.dataset.date = day.date;
            day.segments.forEach(segment => {
                const card = button("", () => openEditor(segment), "ec-period");
                card.dataset.periodId = segment.periodId;
                card.dataset.ownerId = segment.ownerId;
                card.style.top = `${segment.top}px`;
                card.style.height = `${segment.height}px`;
                card.style.left = `calc(${segment.lane * 100 / day.lanes}% + 3px)`;
                card.style.width = `calc(${100 / day.lanes}% - 6px)`;
                card.style.backgroundColor = segment.uiColour[0];
                card.style.color = segment.uiColour[1];
                card.setAttribute("aria-label", `${segment.label}: ${localDateTime(segment.startsAt, event.timezone)} ${offsetLabel(segment.startsAt, event.timezone)} to ${localDateTime(segment.endsAt, event.timezone)} ${offsetLabel(segment.endsAt, event.timezone)}. Edit time slot.`);
                card.title = card.getAttribute("aria-label");
                card.classList.toggle("ec-short", segment.height < 80);
                const title = element("strong", "", `${segment.continuesBefore ? "↳ " : ""}${segment.label}${segment.continuesAfter ? " ↴" : ""}`);
                card.append(title, element("span", "ec-period-time", segment.times));
                for (const edge of ["start", "end"]) {
                    if (segment.height < 30) continue;
                    if (edge === "start" && segment.continuesBefore) continue;
                    if (edge === "end" && segment.continuesAfter) continue;
                    const handle = element("span", `ec-resize ec-resize-${edge}`);
                    handle.dataset.resize = edge;
                    handle.setAttribute("aria-hidden", "true");
                    card.append(handle);
                }
                column.append(card);
            });
            grid.append(column);
        });
        let updateDraggedPreview = () => {};
        // Attach hover, drag and resize interactions to this rendered grid.
        {
            const records = periodRecords(event);
            let drag = null;
            let hoverPreview = null;
            function point(pointer) {
                const rect = grid.getBoundingClientRect();
                const renderedDayWidth = grid.querySelector(".ec-day")?.getBoundingClientRect().width || dayWidth;
                const day = Math.max(0, Math.min(dayCount - 1, Math.floor((pointer.clientX - rect.left - 64) / renderedDayWidth)));
                const minute = Math.max(0, Math.min(1440, Math.round((pointer.clientY - rect.top - 44) / 15) * 15));
                return {day, minute, wall: wallMillis(dateAtMinute(addDays(startDate, day), minute))};
            }
            function clearHoverPreview() {
                hoverPreview?.remove();
                hoverPreview = null;
            }
            function clearDragPreview() {
                grid.querySelectorAll(".ec-drag-preview").forEach(preview => preview.remove());
                grid.querySelectorAll(".ec-period.is-preview-source").forEach(card => card.classList.remove("is-preview-source"));
            }
            function drawDragPreview(low, high, record = null) {
                clearDragPreview();
                if (!Number.isFinite(low) || !Number.isFinite(high) || low >= high) return;
                if (record) {
                    grid.querySelectorAll(".ec-period").forEach(card => {
                        if (card.dataset.periodId === record.periodId && card.dataset.ownerId === record.ownerId) {
                            card.classList.add("is-preview-source");
                        }
                    });
                }
                for (let day = 0; day < dayCount; day++) {
                    const midnight = wallMillis(`${addDays(startDate, day)}T00:00`);
                    const from = Math.max(0, (low - midnight) / MINUTE);
                    const to = Math.min(GRID_MINUTES, (high - midnight) / MINUTE);
                    if (from >= to) continue;
                    const preview = element("div", "ec-drag-preview");
                    preview.style.top = `${from}px`;
                    preview.style.height = `${to - from}px`;
                    grid.querySelector(`.ec-day[data-day="${day}"]`)?.append(preview);
                }
            }
            updateDraggedPreview = () => {
                if (!editor?.dragged) {
                    clearDragPreview();
                    return;
                }
                drawDragPreview(wallMillis(editor.from), wallMillis(editor.to), editor.record);
            };
            function showHoverPreview(pointer) {
                clearHoverPreview();
                if (drag || pointer.pointerType === "touch" || pointer.target.closest(".ec-period") || !pointer.target.closest(".ec-day")) return;
                const current = point(pointer);
                const minute = Math.min(GRID_MINUTES - 60, current.minute);
                const preview = element("div", "ec-hover-preview", `+ ${dateAtMinute("2000-01-01", minute).slice(11, 16)}–${dateAtMinute("2000-01-01", minute + 60).slice(11, 16)}`);
                preview.setAttribute("aria-hidden", "true");
                preview.style.top = `${minute}px`;
                preview.style.height = "60px";
                grid.querySelector(`.ec-day[data-day="${current.day}"]`)?.append(preview);
                hoverPreview = preview;
            }
            grid.addEventListener("pointerdown", pointer => {
                if (pointer.button !== 0 || pointer.pointerType === "touch" || !pointer.target.closest(".ec-day")) return;
                clearHoverPreview();
                const card = pointer.target.closest(".ec-period");
                const record = card ? records.find(item => item.periodId === card.dataset.periodId && item.ownerId === card.dataset.ownerId) : null;
                drag = {pointerId: pointer.pointerId, from: point(pointer), x: pointer.clientX, y: pointer.clientY,
                    record, resize: pointer.target.dataset.resize || null, moved: false};
                grid.setPointerCapture(pointer.pointerId);
                pointer.preventDefault();
            });
            grid.addEventListener("pointermove", pointer => {
                if (!drag) {
                    showHoverPreview(pointer);
                    return;
                }
                if (pointer.pointerId !== drag.pointerId) return;
                if (Math.hypot(pointer.clientX - drag.x, pointer.clientY - drag.y) < 6 && !drag.moved) return;
                drag.moved = true;
                clearHoverPreview();
                const current = point(pointer);
                let low = Math.min(drag.from.wall, current.wall);
                let high = Math.max(drag.from.wall, current.wall) + 15 * MINUTE;
                if (drag.record) {
                    const originalFrom = wallMillis(localDateTime(drag.record.startsAt, getEvent().timezone));
                    const originalTo = wallMillis(localDateTime(drag.record.endsAt, getEvent().timezone));
                    const delta = current.wall - drag.from.wall;
                    low = drag.resize === "end" ? originalFrom : originalFrom + delta;
                    high = drag.resize === "start" ? originalTo : originalTo + delta;
                }
                drawDragPreview(low, high, drag.record);
                drag.values = {from: new Date(low).toISOString().slice(0, 16), to: new Date(high).toISOString().slice(0, 16)};
            });
            grid.addEventListener("pointerup", pointer => {
                if (!drag || pointer.pointerId !== drag.pointerId) return;
                const finished = drag;
                drag = null;
                clearDragPreview();
                if (grid.hasPointerCapture(pointer.pointerId)) grid.releasePointerCapture(pointer.pointerId);
                if (finished.record && !finished.moved) {
                    openEditor(finished.record);
                } else if (finished.moved && finished.values) {
                    openEditor(finished.record, finished.values);
                } else {
                    const from = finished.from.wall;
                    openEditor(null, {from: new Date(from).toISOString().slice(0, 16), to: new Date(from + 60 * MINUTE).toISOString().slice(0, 16)});
                }
            });
            grid.addEventListener("pointerleave", clearHoverPreview);
            grid.addEventListener("pointercancel", () => { drag = null; clearHoverPreview(); clearDragPreview(); });
            updateDraggedPreview();
        }
        frame.append(grid);
        root.append(frame);
        currentFrame = frame;
        frame.scrollTop = frameScroll.top;
        frame.scrollLeft = frameScroll.left;
        if (days.some(day => day.clockChanged)) root.append(element("p", "ec-help", "The clock changes during this view. Repeated-hour time slots share clock positions and show UTC offsets. The editor asks which occurrence you mean."));
        // The editor belongs to the current render and closes over its controls.
        if (editor) {
            const state = editor;
            const event = getEvent();
            const form = element("form", "modal-surface ec-editor");
            form.append(element("h3", "", state.record ? "Edit time slot" : "Add time slot"));
            form.append(element("p", "ec-help", `${state.dragged ? "Review the dragged times, then save. " : ""}Start and end can be on different days.`));
            const fields = element("div", "ec-editor-fields");
            const target = targetSelect(state.ownerId);
            target.name = "period-target";
            fields.append(field("For", target));
            const inputs = {};
            for (const [key, label, value, preferred] of [["start", "Starts", state.from, state.preferredFrom], ["end", "Ends", state.to, state.preferredTo]]) {
                const wrapper = element("div", "ec-time-field");
                const input = element("input", "form-control");
                input.type = "datetime-local";
                input.name = `period-${key}`;
                input.required = true;
                input.step = "60";
                input.value = value;
                const occurrence = element("select", "form-control");
                occurrence.name = `period-${key}-occurrence`;
                occurrence.setAttribute("aria-label", `${label}: choose repeated-time occurrence`);
                const hint = element("span", "ec-time-hint");
                const refresh = () => {
                    const candidates = possibleInstants(input.value, event.timezone);
                    const previous = occurrence.value;
                    occurrence.replaceChildren();
                    occurrence.hidden = candidates.length < 2;
                    occurrence.required = candidates.length > 1;
                    hint.textContent = !input.value ? "" : candidates.length === 0
                        ? "This local time does not exist on this date (the clock moves forward), or the date is invalid."
                        : candidates.length > 1 ? "The clock repeats this time. Choose the intended occurrence." : "";
                    if (candidates.length > 1) {
                        const empty = element("option", "", "Choose occurrence…");
                        empty.value = "";
                        occurrence.append(empty);
                        candidates.forEach((candidate, index) => {
                            const option = element("option", "", `${index === 0 ? "First" : "Second"} occurrence · ${offsetLabel(candidate, event.timezone)}`);
                            option.value = candidate;
                            occurrence.append(option);
                        });
                        const preferredIso = preferred ? new Date(preferred).toISOString() : null;
                        occurrence.value = candidates.includes(previous) ? previous : candidates.includes(preferredIso) ? preferredIso : "";
                    }
                    return candidates;
                };
                const sync = () => {
                    state[key === "start" ? "from" : "to"] = input.value;
                    refresh();
                    updateDraggedPreview();
                };
                input.addEventListener("input", sync);
                input.addEventListener("change", sync);
                refresh();
                wrapper.append(field(label, input), occurrence, hint);
                fields.append(wrapper);
                inputs[key] = {input, occurrence, refresh};
            }
            form.append(fields);
            const error = element("p", "ec-error");
            error.setAttribute("role", "alert");
            error.hidden = true;
            form.append(error);
            const actions = element("div", "ec-actions");
            const save = element("button", "button--primary", "Save time slot");
            save.type = "submit";
            actions.append(save, button("Cancel", () => { editor = null; render(); }));
            if (state.record) actions.append(button("Delete time slot", () => {
                commit(next => {
                    const owner = periodOwner(next, state.record.ownerId);
                    if (owner) owner.periods = (owner.periods || []).filter(period => period.periodId !== state.record.periodId);
                }, "Time slot deleted.");
            }, "button--ghost button--danger ec-delete"));
            if (state.ownerId && onEditSubEvent) actions.append(button("Edit sub-event games", () => onEditSubEvent(state.ownerId)));
            form.append(actions);
            form.addEventListener("submit", submitEvent => {
                submitEvent.preventDefault();
                try {
                    const resolved = {};
                    for (const [key, input] of Object.entries(inputs)) {
                        const candidates = input.refresh();
                        if (!candidates.length) throw new Error(`${key === "start" ? "Start" : "End"} time does not exist in ${event.timezone}. Choose another time.`);
                        if (candidates.length > 1 && !input.occurrence.value) throw new Error(`Choose the first or second occurrence for the ${key} time.`);
                        resolved[key] = candidates.length === 1 ? candidates[0] : input.occurrence.value;
                    }
                    if (Date.parse(resolved.end) <= Date.parse(resolved.start)) throw new Error("The end must be after the start.");
                    const ownerId = target.value;
                    commit(next => {
                        const owner = periodOwner(next, ownerId);
                        if (!owner) throw new Error("This sub-event no longer exists. Select another one.");
                        if (state.record) {
                            const oldOwner = periodOwner(next, state.record.ownerId);
                            if (oldOwner) oldOwner.periods = (oldOwner.periods || []).filter(period => period.periodId !== state.record.periodId);
                        }
                        owner.periods ||= [];
                        owner.periods.push({periodId: state.record?.periodId || crypto.randomUUID(), startsAt: resolved.start, endsAt: resolved.end});
                    }, state.record ? "Time slot updated." : "Time slot added.");
                } catch (reason) {
                    error.hidden = false;
                    error.textContent = reason.message;
                }
            });
            root.append(form);
        }
        const legend = element("div", "ec-legend");
        owners(event).forEach((owner, index) => {
            const item = element("span", "ec-legend-item");
            const dot = element("span", "ec-legend-dot");
            dot.style.backgroundColor = UI_COLOURS[index % UI_COLOURS.length][1];
            item.append(dot, document.createTextNode(owner.name || "Untitled event"));
            legend.append(item);
        });
        root.append(legend);
        const records = periodRecords(event).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
        const list = element("details", "ec-period-list");
        list.append(element("summary", "", `All time slots (${records.length})`));
        const items = element("ul");
        records.forEach(record => {
            const item = element("li");
            item.append(button(`${record.label} · ${localDateTimeMinute(record.startsAt, event.timezone).replace("T", " ")} – ${localDateTimeMinute(record.endsAt, event.timezone).replace("T", " ")}`, () => openEditor(record)));
            items.append(item);
        });
        if (!records.length) items.append(element("li", "", "No time slots yet. Add the first one above."));
        list.append(items);
        root.append(list);
        const exports = element("div", "ec-actions ec-exports");
        const download = async (action, message) => {
            try { await action(); }
            catch (error) { message = error.message; }
            liveMessage = message;
            const area = root.querySelector(".ec-message");
            if (area) area.textContent = message;
        };
        exports.append(
            button("Download calendar (.ics)", () => download(exportIcs, "Calendar file downloaded with all time slots.")),
            button("Download image (.png)", () => download(exportImage, "Calendar image downloaded for the displayed dates.")),
        );
        root.append(exports);
    }

    function exportIcs({download = true} = {}) {
        const event = getEvent();
        const text = calendarIcs(event);
        if (download) downloadBlob(new Blob([text], {type: "text/calendar;charset=utf-8"}), `${filename(event)}.ics`);
        return text;
    }

    async function exportImage({download = true} = {}) {
        const event = getEvent();
        const blob = await calendarImage(event, startDate, dayCount);
        if (download) downloadBlob(blob, `${filename(event)}-${startDate}.png`);
        return blob;
    }

    render();
    return {render, exportIcs, exportImage, destroy() { destroyed = true; editor = null; currentFrame = null; root.remove(); }};
}
