export function Switch(props: { on: boolean; onToggle: (next: boolean) => void; title?: string }) {
    return (
        <div
            class={props.on ? "switch on" : "switch"}
            role="switch"
            aria-checked={props.on}
            title={props.title ?? (props.on ? "On" : "Off")}
            onClick={() => props.onToggle(!props.on)}
        />
    );
}
