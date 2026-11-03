/**
 * The event being dispatched right now, if any. React runs the effects of a
 * click / keypress before that event reaches `document`, so a listener an
 * effect adds there would see the very event that opened the popup:
 * capture this when adding it and ignore that one event.
 */
export function openedBy(): Event | undefined {
    return (globalThis as { event?: Event }).event;
}
